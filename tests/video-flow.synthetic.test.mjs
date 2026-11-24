import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { cleanText } from '../server/text.js';
import { openDatabase, newId } from '../server/db.js';
import { createRateLimiter } from '../server/rate-limit.js';
import { createAuth } from '../server/auth.js';
import { createVideoApiRouter } from '../server/video-api.js';
import { readCleanupPolicy } from '../server/cleanup-policy.js';

for (const key of [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'AI_TIMEOUT_MS',
  'CUSTOM_AI_API_KEY',
  'CUSTOM_AI_BASE_URL',
  'CUSTOM_AI_MODEL',
  'CUSTOM_AI_LABEL',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
  'OLLAMA_DISABLED',
  'AI_PROVIDERS',
  'TTS_PROVIDER',
  'TTS_PROVIDER_ORDER',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'SUBTITLE_FONT',
]) {
  delete process.env[key];
}

const { createGenerationQueue, publishRenderedVideo, INTERRUPTED_MESSAGE } = await import('../server/generation.js');
const SCRIPT = {
  hook: 'Синтетический хук',
  benefit1: 'Первое преимущество',
  benefit2: 'Второе преимущество',
  cta: 'Закажите сейчас',
};
const SYNTHETIC_MP4 = Buffer.alloc(24 * 1024, 0x53);
const VOICE = {
  path: 'synthetic-voice.wav',
  duration: 15,
  aligned: true,
  kind: 'tts-mock',
  gender: 'female',
  voiceLanguage: 'ru',
  voiceName: 'Synthetic voice',
  exactLanguage: true,
  warning: '',
};
const LANGUAGES = { ru: 'Russian', uz: 'Uzbek', en: 'English' };
const CATEGORIES = ['product', 'realty', 'food', 'shop', 'service', 'job', 'event', 'other'];
const STYLES = ['product', 'dynamic', 'premium', 'ugc'];
const roots = [];
const harnesses = [];
const databases = new Set();

test.after(async () => {
  for (const harness of harnesses) await harness.close();
  for (const db of databases) db.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function providerResult(input) {
  return {
    script: SCRIPT,
    fullText: [SCRIPT.hook, SCRIPT.benefit1, SCRIPT.benefit2, SCRIPT.cta].join(' '),
    source: {
      id: 'ai:openai',
      kind: 'ai',
      provider: 'openai',
      label: 'Synthetic OpenAI',
      model: 'synthetic-model',
      warning: '',
      reason: '',
    },
    attempts: [{ provider: 'openai', ok: true, model: 'synthetic-model', input }],
  };
}

async function createHarness({
  speech = async () => VOICE,
  render = async ({ outputPath }) => fs.writeFileSync(outputPath, SYNTHETIC_MP4),
  apiScript = async (input) => providerResult(input),
  queueScript = async (input) => providerResult(input),
  scriptsPerHour = 30,
  log = { warn() {} },
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bevhub-video-flow-synthetic-'));
  roots.push(root);
  const databaseDir = path.join(root, 'database');
  const uploadsDir = path.join(root, 'uploads');
  const imagesDir = path.join(uploadsDir, 'images');
  const videosDir = path.join(uploadsDir, 'videos');
  const tmpDir = path.join(uploadsDir, 'tmp');
  const backupsDir = path.join(root, 'backups');
  for (const dir of [databaseDir, imagesDir, videosDir, tmpDir, backupsDir]) fs.mkdirSync(dir, { recursive: true });

  const db = openDatabase(path.join(databaseDir, 'synthetic.sqlite'));
  databases.add(db);
  const auth = createAuth(db);
  const workspaces = [];
  const sessions = new Map();
  const registrations = [];
  const credentials = [];
  const rate = createRateLimiter(db);
  const calls = { apiScript: 0, queueScript: 0, speech: 0, render: 0 };
  const queue = createGenerationQueue({
    db,
    imagesDir,
    videosDir,
    tmpDir,
    concurrency: 1,
    cleanupPolicy: readCleanupPolicy({}),
    generateScriptImpl: async (input) => {
      calls.queueScript += 1;
      return queueScript(input);
    },
    generateSpeechImpl: async (...args) => {
      calls.speech += 1;
      return speech(...args);
    },
    renderVideoImpl: async (...args) => {
      calls.render += 1;
      return render(...args);
    },
    renderAutoVideoImpl: async (...args) => {
      calls.render += 1;
      return render(...args);
    },
    publishRenderedVideoImpl: (partPath, finalPath) =>
      publishRenderedVideo(partPath, finalPath, {
        probe: async () => ({ ok: true, reason: '', durationSec: 15, width: 1080, height: 1920 }),
      }),
  });

  const api = express.Router();
  api.use(auth.requireAuth);
  api.use(
    createVideoApiRouter({
      db,
      queue,
      rate,
      imagesDir,
      videosDir,
      cleanText,
      detectImageType: () => 'image/png',
      validateImageDecodes: async () => {},
      generateScript: async (input) => {
        calls.apiScript += 1;
        return apiScript(input);
      },
      isAiActive: () => true,
      maleVoiceAvailable: () => false,
      LANGUAGES,
      STYLES,
      CATEGORIES,
      normalizeUzbekText: (text) => text,
      detectLanguage: () => 'ru',
      detectCategory: () => 'product',
      pickStyle: () => 'dynamic',
      defaultCta: () => 'Закажите сейчас',
      interruptedMessage: INTERRUPTED_MESSAGE,
      scriptsPerHour,
      log,
    }),
  );

  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router);
  app.use('/api', api);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Synthetic server error' });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  let closed = false;

  const harness = {
    db,
    rate,
    queue,
    calls,
    root,
    imagesDir,
    videosDir,
    workspaces,
    registrations,
    baseUrl,
    async register(index) {
      const name = `Synthetic ${index}`;
      const email = `synthetic-${crypto.randomUUID()}@example.test`;
      const password = `synthetic-password-${index}`;
      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
        }),
      });
      const data = await response.json();
      const setCookie = response.headers.get('set-cookie');
      assert.equal(response.status, 201);
      assert.equal(data.user.email, email);
      assert.ok(data.workspace.id);
      assert.ok(setCookie);
      sessions.set(data.workspace.id, setCookie.split(';', 1)[0]);
      credentials[index] = { email, password };
      workspaces.push(data.workspace.id);
      registrations.push(data);
      return data;
    },
    async login(index) {
      const { email, password } = credentials[index];
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      const setCookie = response.headers.get('set-cookie');
      assert.equal(response.status, 200);
      assert.equal(data.user.email, email);
      assert.ok(setCookie);
      sessions.set(workspaces[index], setCookie.split(';', 1)[0]);
      return data;
    },
    async request(url, { workspaceId = workspaces[0], ...options } = {}) {
      const headers = new Headers(options.headers);
      const sessionCookie = sessions.get(workspaceId);
      if (!sessionCookie) throw new Error('Missing synthetic registration session');
      headers.set('cookie', sessionCookie);
      if (options.json !== undefined) {
        headers.set('content-type', 'application/json');
        options.body = JSON.stringify(options.json);
        delete options.json;
      }
      return fetch(`${baseUrl}${url}`, { ...options, headers });
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
      databases.delete(db);
    },
  };
  harnesses.push(harness);
  await harness.register(0);
  await harness.register(1);
  return harness;
}

test('script quota preserves the HTTP 429 response and records one allowed attempt', async (t) => {
  const harness = await createHarness({ scriptsPerHour: 1 });
  t.after(() => harness.close());
  const input = {
    productName: 'Synthetic product',
    description: 'Synthetic product description',
    cta: SCRIPT.cta,
    language: 'ru',
    style: 'dynamic',
    category: 'product',
  };

  const allowed = await harness.request('/scripts', { method: 'POST', json: input });
  assert.equal(allowed.status, 200);
  const rejected = await harness.request('/scripts', { method: 'POST', json: input });
  assert.equal(rejected.status, 429);
  assert.ok(Number(rejected.headers.get('retry-after')) >= 1);
  assert.match((await rejected.json()).error, /Слишком много запросов сценария/);
  assert.equal(harness.rate.peek({ bucket: 'scripts', key: harness.workspaces[0], windowMs: 60 * 60 * 1000 }), 1);
});

async function uploadSyntheticImage(harness) {
  const image = new FormData();
  image.append('image', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'synthetic.png');
  const uploadResponse = await harness.request('/files', { method: 'POST', body: image });
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()).file;
  assert.equal(uploaded.mime_type, 'image/png');
  const uploadedRow = harness.db.prepare('SELECT filename FROM files WHERE id = ?').get(uploaded.id);
  assert.ok(uploadedRow);
  assert.ok(fs.existsSync(path.join(harness.imagesDir, uploadedRow.filename)));
  return uploaded;
}

test('uploaded image remains available from its workspace file URL with the stored MIME type', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  await harness.register(0);
  await harness.register(1);

  const uploaded = await uploadSyntheticImage(harness);
  const response = await harness.request(`/files/${uploaded.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^image\/png\b/);

  const row = harness.db.prepare('SELECT workspace_id, filename, mime_type FROM files WHERE id = ?').get(uploaded.id);
  assert.equal(row.workspace_id, harness.workspaces[0]);
  assert.equal(row.mime_type, 'image/png');
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    fs.readFileSync(path.join(harness.imagesDir, row.filename)),
  );

  const otherWorkspaceResponse = await harness.request(`/files/${uploaded.id}`, { workspaceId: harness.workspaces[1] });
  assert.equal(otherWorkspaceResponse.status, 404);
});

async function createVideoThroughApi(harness) {
  const projectResponse = await harness.request('/projects', {
    method: 'POST',
    json: { name: 'Synthetic project', description: 'Synthetic project description' },
  });
  assert.equal(projectResponse.status, 201);
  const project = (await projectResponse.json()).project;

  const scriptResponse = await harness.request('/scripts', {
    method: 'POST',
    json: {
      productName: 'Synthetic product',
      description: 'Synthetic product description',
      cta: SCRIPT.cta,
      language: 'ru',
      style: 'dynamic',
      category: 'product',
    },
  });
  assert.equal(scriptResponse.status, 200);
  const generated = await scriptResponse.json();
  assert.deepEqual(generated.script, SCRIPT);
  assert.equal(generated.fullText, [SCRIPT.hook, SCRIPT.benefit1, SCRIPT.benefit2, SCRIPT.cta].join(' '));
  assert.equal(generated.source, 'ai:openai');
  assert.equal(generated.sourceKind, 'ai');

  const uploaded = await uploadSyntheticImage(harness);

  const createResponse = await harness.request('/videos', {
    method: 'POST',
    json: {
      clientRequestId: crypto.randomUUID(),
      projectId: project.id,
      productName: 'Synthetic product',
      description: 'Synthetic product description',
      price: '10',
      cta: SCRIPT.cta,
      websiteUrl: '',
      language: 'ru',
      voiceType: 'female',
      style: 'dynamic',
      category: 'product',
      fileIds: [uploaded.id],
      script: generated.script,
      scriptSource: generated.source,
    },
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).video;
  assert.equal(created.project_id, project.id);
  assert.equal(created.status, 'processing');
  return { created, uploaded, project };
}

async function postSyntheticVideo(harness, { script, description, productName = 'Bluetooth-наушники' }) {
  const uploaded = await uploadSyntheticImage(harness);
  const response = await harness.request('/videos', {
    method: 'POST',
    json: {
      clientRequestId: crypto.randomUUID(),
      productName,
      description,
      cta: 'Попробуйте сейчас',
      language: 'ru',
      voiceType: 'female',
      style: 'dynamic',
      category: 'product',
      fileIds: [uploaded.id],
      script,
      scriptSource: 'ai:openai',
    },
  });
  return { response, uploaded };
}

async function getVideoUntil(harness, videoId, targetStatus) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await harness.request(`/videos/${videoId}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    if (data.video.status === targetStatus) return data;
    if (data.video.status === 'failed' && targetStatus !== 'failed') {
      assert.fail(`generation failed early: ${data.video.error_message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`video did not reach ${targetStatus}`);
}

test('video file 404 logs safe diagnostics without user identifiers or paths', async (t) => {
  const warnings = [];
  const harness = await createHarness({
    log: { warn: (message) => warnings.push(message) },
  });
  t.after(() => harness.close());

  const { created } = await createVideoThroughApi(harness);
  await getVideoUntil(harness, created.id, 'completed');
  const row = harness.db.prepare('SELECT video_file FROM videos WHERE id = ?').get(created.id);
  const videoPath = path.join(harness.videosDir, row.video_file);
  assert.ok(fs.existsSync(videoPath));

  harness.db.prepare("UPDATE videos SET status = 'processing' WHERE id = ?").run(created.id);
  const statusResponse = await harness.request(`/videos/${created.id}/file`);
  assert.equal(statusResponse.status, 404);
  const statusLog = JSON.parse(warnings[0].slice('[VIDEO_FILE_404] '.length));
  assert.deepEqual(statusLog, {
    reason: 'status_not_completed',
    status: 'processing',
    workspace_match: true,
    file_exists: true,
    file_bytes: SYNTHETIC_MP4.length,
  });

  harness.db.prepare("UPDATE videos SET status = 'completed' WHERE id = ?").run(created.id);
  fs.rmSync(videoPath);
  const missingFileResponse = await harness.request(`/videos/${created.id}/file`);
  assert.equal(missingFileResponse.status, 404);
  const missingFileLog = JSON.parse(warnings[1].slice('[VIDEO_FILE_404] '.length));
  assert.deepEqual(missingFileLog, {
    reason: 'file_missing',
    status: 'completed',
    workspace_match: true,
    file_exists: false,
    file_bytes: null,
    file_error_code: 'ENOENT',
  });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => !warning.includes(harness.root)));
  assert.ok(warnings.every((warning) => !warning.includes(harness.workspaces[0])));
  assert.ok(warnings.every((warning) => !warning.includes(created.id)));
  assert.ok(warnings.every((warning) => !warning.includes(path.basename(row.video_file))));
});

test('registration, login, and project saving persist data in the owning workspace', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const createdResponse = await harness.request('/projects', {
    method: 'POST',
    json: { name: 'Persistent synthetic project', description: 'Project saved for the user flow test' },
  });
  assert.equal(createdResponse.status, 201);
  const createdProject = (await createdResponse.json()).project;
  assert.equal(createdProject.workspace_id, harness.workspaces[0]);

  const storedProject = harness.db
    .prepare('SELECT id, workspace_id, name, description FROM projects WHERE id = ?')
    .get(createdProject.id);
  assert.deepEqual({ ...storedProject }, {
    id: createdProject.id,
    workspace_id: harness.workspaces[0],
    name: 'Persistent synthetic project',
    description: 'Project saved for the user flow test',
  });

  const login = await harness.login(0);
  assert.equal(login.workspace.id, harness.workspaces[0]);
  const projectsAfterLogin = await harness.request('/projects');
  assert.deepEqual((await projectsAfterLogin.json()).projects.map(({ id }) => id), [createdProject.id]);

  const otherWorkspaceProjects = await harness.request('/projects', { workspaceId: harness.workspaces[1] });
  assert.deepEqual((await otherWorkspaceProjects.json()).projects, []);
});

test('POST /videos rejects an unsupported client claim before storing or enqueueing it', async () => {
  const harness = await createHarness();
  try {
    const before = harness.db.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
    const { response } = await postSyntheticVideo(harness, {
      description: 'Bluetooth-наушники для музыки.',
      script: {
        hook: 'Музыка для вашего дня',
        benefit1: 'Водонепроницаемый корпус',
        benefit2: 'Выбирайте настроение',
        cta: 'Попробуйте сейчас',
      },
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /неподтверждённые характеристики/i);
    assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM videos').get().count, before);
    assert.equal(harness.calls.apiScript, 0);
    assert.equal(harness.calls.queueScript, 0);
    assert.equal(harness.calls.speech, 0);
    assert.equal(harness.calls.render, 0);
  } finally {
    await harness.close();
  }
});

test('POST /videos accepts a client claim supported by the product description', async () => {
  const harness = await createHarness();
  try {
    const script = {
      hook: 'Музыка для вашего дня',
      benefit1: 'Кабель не входит в комплект.',
      benefit2: 'Выбирайте настроение',
      cta: 'Попробуйте сейчас',
    };
    const { response } = await postSyntheticVideo(harness, {
      description: 'Bluetooth-наушники. Кабель не входит в комплект.',
      script,
    });
    assert.equal(response.status, 201);
    const created = (await response.json()).video;
    assert.equal(created.script_hook, script.hook);
    assert.equal(created.script_body, `${script.benefit1}\n${script.benefit2}`);
    const completed = await getVideoUntil(harness, created.id, 'completed');
    assert.equal(completed.job.status, 'completed');
    assert.equal(harness.calls.speech, 1);
    assert.equal(harness.calls.render, 1);
  } finally {
    await harness.close();
  }
});

test('a saved legacy claim fails before TTS and render files without invoking another script source', async () => {
  const harness = await createHarness();
  try {
    const videoId = newId();
    const timestamp = new Date().toISOString();
    const script = {
      hook: 'Музыка для вашего дня',
      benefit1: 'Водонепроницаемый корпус',
      benefit2: 'Выбирайте настроение',
      cta: 'Попробуйте сейчас',
    };
    harness.db.prepare(
      `INSERT INTO videos (
        id, workspace_id, client_request_id, title, product_name, product_description, language, style,
        script_hook, script_body, script_cta, script_source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
    ).run(
      videoId,
      harness.workspaces[0],
      crypto.randomUUID(),
      'Synthetic legacy video',
      'Bluetooth-наушники',
      'Bluetooth-наушники для музыки.',
      'ru',
      'dynamic',
      script.hook,
      `${script.benefit1}\n${script.benefit2}`,
      script.cta,
      'client',
      timestamp,
      timestamp,
    );
    harness.db.prepare(
      "INSERT INTO generation_jobs (id, video_id, status, progress, current_step, started_at, created_at) VALUES (?, ?, 'processing', 0, 'Queued', ?, ?)",
    ).run(newId(), videoId, timestamp, timestamp);

    harness.queue.enqueue(videoId);
    const failed = await getVideoUntil(harness, videoId, 'failed');
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.video.error_message, /factual validation/i);
    assert.equal(harness.calls.queueScript, 0);
    assert.equal(harness.calls.speech, 0);
    assert.equal(harness.calls.render, 0);
    assert.deepEqual(fs.readdirSync(harness.videosDir), []);
    const storedScript = harness.db.prepare('SELECT script_hook, script_body, script_cta FROM videos WHERE id = ?').get(videoId);
    assert.equal(storedScript.script_hook, script.hook);
    assert.equal(storedScript.script_body, `${script.benefit1}\n${script.benefit2}`);
    assert.equal(storedScript.script_cta, script.cta);
  } finally {
    await harness.close();
  }
});

test('synthetic API-to-queue flow uploads an image, renders, publishes, isolates, and downloads the video', async () => {
  let markSpeechStarted;
  let releaseSpeech;
  const speechStarted = new Promise((resolve) => {
    markSpeechStarted = resolve;
  });
  const speechGate = new Promise((resolve) => {
    releaseSpeech = resolve;
  });
  let renderCalled = false;
  const harness = await createHarness({
    speech: async () => {
      markSpeechStarted();
      await speechGate;
      return VOICE;
    },
    render: async ({ imagePath, voice, script, outputPath }) => {
      renderCalled = true;
      assert.ok(fs.existsSync(imagePath));
      assert.equal(voice.path, VOICE.path);
      assert.deepEqual(script, SCRIPT);
      fs.writeFileSync(outputPath, SYNTHETIC_MP4);
    },
  });
  try {
    assert.equal(harness.registrations.length, 2);
    assert.equal(harness.registrations[0].workspace.demo_mode, true);
    assert.ok(
      harness.db.prepare('SELECT 1 FROM subscriptions WHERE workspace_id = ?').get(harness.workspaces[0]),
    );
    const { created, uploaded } = await createVideoThroughApi(harness);
    await speechStarted;

    const foreignVideo = await harness.request(`/videos/${created.id}`, { workspaceId: harness.workspaces[1] });
    assert.equal(foreignVideo.status, 404);
    const foreignFile = await harness.request(`/videos/${created.id}/file`, { workspaceId: harness.workspaces[1] });
    assert.equal(foreignFile.status, 404);

    harness.db.prepare("UPDATE videos SET status = 'queued' WHERE id = ?").run(created.id);
    harness.db.prepare("UPDATE generation_jobs SET status = 'queued', current_step = 'Queued' WHERE video_id = ?").run(created.id);
    const queuedResponse = await harness.request(`/videos/${created.id}`);
    const queuedData = await queuedResponse.json();
    assert.equal(queuedData.video.status, 'queued');
    assert.equal(queuedData.job.status, 'queued');

    harness.db.prepare("UPDATE videos SET status = 'processing' WHERE id = ?").run(created.id);
    harness.db.prepare("UPDATE generation_jobs SET status = 'processing', current_step = 'Generating voice' WHERE video_id = ?").run(created.id);
    const processingResponse = await harness.request(`/videos/${created.id}`);
    const processingData = await processingResponse.json();
    assert.equal(processingData.video.status, 'processing');
    assert.equal(processingData.job.status, 'processing');

    releaseSpeech();
    const completedData = await getVideoUntil(harness, created.id, 'completed');
    assert.equal(renderCalled, true);
    assert.equal(completedData.job.status, 'completed');
    assert.equal(completedData.job.progress, 100);
    assert.match(completedData.video.video_url, new RegExp(`/api/videos/${created.id}/file$`));
    assert.equal(completedData.video.audio_kind, 'tts-mock');
    assert.equal(completedData.assets[0].file_id, uploaded.id);

    const downloadPath = `/videos/${created.id}/file?download=1`;
    const beforeHead = harness.rate.peek({ bucket: 'downloads', key: harness.workspaces[0], windowMs: 5 * 60 * 1000 });
    const head = await harness.request(downloadPath, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(harness.rate.peek({ bucket: 'downloads', key: harness.workspaces[0], windowMs: 5 * 60 * 1000 }), beforeHead);

    const download = await harness.request(downloadPath);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /video\/mp4/);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), SYNTHETIC_MP4);

    const originalNow = Date.now;
    let syntheticNow = originalNow() + 1000;
    try {
      Date.now = () => syntheticNow++;
      while (harness.rate.peek({ bucket: 'downloads', key: harness.workspaces[0], windowMs: 5 * 60 * 1000 }) < 60) {
        const quota = harness.rate.hit({ bucket: 'downloads', key: harness.workspaces[0], limit: 60, windowMs: 5 * 60 * 1000 });
        assert.equal(quota.allowed, true);
      }
    } finally {
      Date.now = originalNow;
    }

    const headAtLimit = await harness.request(downloadPath, { method: 'HEAD' });
    assert.equal(headAtLimit.status, 200);
    assert.equal(harness.rate.peek({ bucket: 'downloads', key: harness.workspaces[0], windowMs: 5 * 60 * 1000 }), 60);
    const getAtLimit = await harness.request(downloadPath);
    assert.equal(getAtLimit.status, 429);
  } finally {
    releaseSpeech();
  }
});

test('TTS provider failure marks the video and job failed without rendering', async () => {
  let renderCalled = false;
  const harness = await createHarness({
    speech: async () => {
      throw new Error('all synthetic TTS providers failed');
    },
    render: async () => {
      renderCalled = true;
    },
  });
  try {
    const { created } = await createVideoThroughApi(harness);
    const failed = await getVideoUntil(harness, created.id, 'failed');
    assert.equal(renderCalled, false);
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.video.error_message, /all synthetic TTS providers failed/);
  } finally {
    await harness.close();
  }
});

test('rendering failure marks the video and job failed', async () => {
  const harness = await createHarness({
    render: async () => {
      throw new Error('synthetic render failure');
    },
  });
  try {
    const { created } = await createVideoThroughApi(harness);
    const failed = await getVideoUntil(harness, created.id, 'failed');
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.video.error_message, /synthetic render failure/);
  } finally {
    await harness.close();
  }
});
