import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { cleanText } from '../server/text.js';
import { newId, openDatabase } from '../server/db.js';
import { createRateLimiter } from '../server/rate-limit.js';
import { createVideoApiRouter } from '../server/video-api.js';

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53]);
const LANGUAGES = { ru: 'Russian', uz: 'Uzbek', en: 'English' };
const CATEGORIES = ['product', 'realty', 'food', 'shop', 'service', 'job', 'event', 'other'];
const STYLES = ['product', 'dynamic', 'premium', 'ugc'];
const roots = [];
const harnesses = [];

test.after(async () => {
  for (const harness of harnesses) await harness.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function createHarness({ detectImageType = () => 'image/png', createUploadWriteStream } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bevhub-upload-cleanup-synthetic-'));
  roots.push(root);
  const imagesDir = path.join(root, 'uploads', 'images');
  const videosDir = path.join(root, 'uploads', 'videos');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });
  const db = openDatabase(path.join(root, 'database', 'synthetic.sqlite'));
  const workspaces = [newId(), newId()];
  const timestamp = new Date().toISOString();
  for (let index = 0; index < workspaces.length; index++) {
    const userId = newId();
    db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      `upload-${index}@example.test`,
      `Upload ${index}`,
      'synthetic-password-hash',
      timestamp,
    );
    db.prepare('INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      workspaces[index],
      userId,
      `Synthetic upload workspace ${index}`,
      timestamp,
    );
  }

  let nextUploadId = crypto.randomUUID();
  const api = express.Router();
  api.use((req, res, next) => {
    const workspaceId = req.get('x-synthetic-workspace');
    if (!workspaces.includes(workspaceId)) return res.status(401).json({ error: 'Synthetic authentication required' });
    req.workspace = { id: workspaceId };
    next();
  });
  api.use(
    createVideoApiRouter({
      db,
      queue: {},
      rate: createRateLimiter(db),
      imagesDir,
      videosDir,
      cleanText,
      detectImageType,
      validateImageDecodes: async () => {},
      generateScript: async () => {
        throw new Error('not used in upload cleanup test');
      },
      isAiActive: () => false,
      maleVoiceAvailable: () => false,
      LANGUAGES,
      STYLES,
      CATEGORIES,
      normalizeUzbekText: (text) => text,
      detectLanguage: () => 'ru',
      detectCategory: () => 'product',
      pickStyle: () => 'dynamic',
      defaultCta: () => 'Закажите сейчас',
      interruptedMessage: 'Synthetic interruption',
      createUploadId: () => nextUploadId,
      createUploadWriteStream,
    }),
  );
  const app = express();
  app.use('/api', api);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Synthetic server error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  let closed = false;
  const harness = {
    db,
    imagesDir,
    workspaces,
    setUploadId(id) {
      nextUploadId = id;
    },
    async upload({ workspaceId = workspaces[0], content = IMAGE } = {}) {
      const body = new FormData();
      body.append('image', new Blob([content], { type: 'image/png' }), 'synthetic.png');
      return fetch(`http://127.0.0.1:${server.address().port}/api/files`, {
        method: 'POST',
        headers: { 'x-synthetic-workspace': workspaceId },
        body,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

function storedFiles(imagesDir) {
  return fs.readdirSync(imagesDir).filter((name) => fs.statSync(path.join(imagesDir, name)).isFile());
}

function failingUploadStream(error, onClose) {
  return (target, options) => {
    const output = fs.createWriteStream(target, options);
    output.once('open', () => {
      fs.writeSync(output.fd, Buffer.from('synthetic partial upload'));
      output.once('close', () => onClose?.(fs.existsSync(target)));
      output.destroy(error);
    });
    return output;
  };
}

test('upload cleanup preserves successful files and workspace ownership', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await harness.upload();
  assert.equal(response.status, 201);
  const { file } = await response.json();
  const row = harness.db.prepare('SELECT workspace_id, filename FROM files WHERE id = ?').get(file.id);
  assert.equal(row.workspace_id, harness.workspaces[0]);
  assert.ok(fs.existsSync(path.join(harness.imagesDir, row.filename)));
  assert.equal(storedFiles(harness.imagesDir).length, 1);
});

test('validation failure removes the newly written synthetic upload', async (t) => {
  const harness = await createHarness({ detectImageType: () => null });
  t.after(() => harness.close());

  const response = await harness.upload();
  assert.equal(response.status, 400);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.deepEqual(storedFiles(harness.imagesDir), []);
});

test('SQLite insert failure removes the unregistered synthetic upload', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.db.exec(`
    CREATE TRIGGER reject_synthetic_file
    BEFORE INSERT ON files
    BEGIN
      SELECT RAISE(FAIL, 'synthetic file insert failure');
    END;
  `);

  const response = await harness.upload();
  assert.equal(response.status, 500);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.deepEqual(storedFiles(harness.imagesDir), []);
});

test('an exclusive filename collision does not modify or remove a pre-existing file', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const id = crypto.randomUUID();
  const filename = `${id}.png`;
  const preExisting = Buffer.from('synthetic pre-existing user file');
  fs.writeFileSync(path.join(harness.imagesDir, filename), preExisting);
  harness.setUploadId(id);

  const response = await harness.upload();
  assert.equal(response.status, 400);
  assert.deepEqual(fs.readFileSync(path.join(harness.imagesDir, filename)), preExisting);
  assert.deepEqual(storedFiles(harness.imagesDir), [filename]);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
});

test('cleanup retains a file referenced by another workspace after INSERT failure', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const id = crypto.randomUUID();
  const filename = `${id}.png`;
  harness.setUploadId(id);
  harness.db.prepare(
    'INSERT INTO files (id, workspace_id, filename, mime_type, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(newId(), harness.workspaces[1], filename, 'image/png', IMAGE.length, 'foreign synthetic image.png', new Date().toISOString());
  harness.db.exec(`
    CREATE TRIGGER reject_synthetic_file
    BEFORE INSERT ON files
    WHEN NEW.workspace_id = '${harness.workspaces[0]}'
    BEGIN
      SELECT RAISE(FAIL, 'synthetic file insert failure');
    END;
  `);

  const response = await harness.upload();
  assert.equal(response.status, 500);
  assert.deepEqual(fs.readFileSync(path.join(harness.imagesDir, filename)), IMAGE);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS n FROM files WHERE filename = ?').get(filename).n, 1);
});

test('Multer size failure removes only the partial synthetic upload', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x53);

  const response = await harness.upload({ content: oversized });
  assert.equal(response.status, 400);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.deepEqual(storedFiles(harness.imagesDir), []);
});

test('pipeline failure after open waits for stream close and removes the partial file', async (t) => {
  let fileExistedAtClose = false;
  const harness = await createHarness({
    createUploadWriteStream: failingUploadStream(new Error('synthetic pipeline failure'), (exists) => {
      fileExistedAtClose = exists;
    }),
  });
  t.after(() => harness.close());

  const response = await harness.upload();
  assert.equal(response.status, 400);
  assert.equal(fileExistedAtClose, true);
  assert.deepEqual(storedFiles(harness.imagesDir), []);
});

test('cleanup failure is logged without replacing the original pipeline error', async (t) => {
  const pipelineErrorMessage = 'synthetic pipeline failure';
  const id = crypto.randomUUID();
  const harness = await createHarness({
    createUploadWriteStream: failingUploadStream(new Error(pipelineErrorMessage)),
  });
  t.after(() => harness.close());
  harness.setUploadId(id);
  const warnings = [];
  const originalWarn = console.warn;
  harness.db.exec('BEGIN IMMEDIATE');

  let response;
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    response = await harness.upload();
  } finally {
    console.warn = originalWarn;
    harness.db.exec('ROLLBACK');
  }

  const filename = `${id}.png`;
  assert.equal(response.status, 400);
  assert.ok(warnings.some((message) => message.includes(`partial file ${filename} cleanup failed`)));
  assert.ok(warnings.some((message) => message.includes(pipelineErrorMessage)));
  assert.deepEqual(storedFiles(harness.imagesDir), [filename]);
});
