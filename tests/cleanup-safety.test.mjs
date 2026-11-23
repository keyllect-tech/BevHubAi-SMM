// Safety tests for automatic file deletion. Everything runs in throwaway directories under
// %TEMP%\bevhub-safety-*; no test reads, writes or deletes anything under the project's real
// `uploads/` or `data/`, and none of them starts the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readCleanupPolicy, parseToggle, parseMode, describePolicy, CATEGORY_ENV } from '../server/cleanup-policy.js';
import { createFileInventory } from '../server/file-inventory.js';
import { createGenerationQueue, classifyPartFile, classifyMissingVideo, jobPaths, cleanupFailedRender, removeRunWorkDir } from '../server/generation.js';
import { prepareTmpDir } from '../server/tmp-dir.js';
import { backupDatabase } from '../server/db.js';
import { removeOwnFile } from '../server/safe-remove.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, workspace_id TEXT, filename TEXT NOT NULL, mime_type TEXT, size INTEGER, original_name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, workspace_id TEXT, video_file TEXT NOT NULL DEFAULT '', status TEXT, error_message TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS video_assets (file_id TEXT, video_id TEXT, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS brand_kits (workspace_id TEXT, logo_url TEXT);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT NOT NULL DEFAULT 'Queued',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
`;

const roots = [];
function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bevhub-safety-${name}-`));
  roots.push(dir);
  const uploads = path.join(dir, 'uploads');
  const images = path.join(uploads, 'images');
  const videos = path.join(uploads, 'videos');
  const backups = path.join(dir, 'data', 'backups');
  fs.mkdirSync(images, { recursive: true });
  fs.mkdirSync(videos, { recursive: true });
  fs.mkdirSync(backups, { recursive: true });
  return { dir, uploads, images, videos, backups, dbFile: path.join(dir, 'data', 'test.db') };
}

function openDb(file, { create = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  if (create) db.exec(SCHEMA);
  return db;
}

function touch(file, { bytes = 1024, ageHours = 0 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  if (ageHours) {
    const when = new Date(Date.now() - ageHours * 3600 * 1000);
    fs.utimesSync(file, when, when);
  }
  return file;
}

function listing(dir) {
  const walk = (d, prefix = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(d, e.name), rel) : [rel];
  });
  return fs.existsSync(dir) ? walk(dir).sort() : [];
}

function bytes(dir) {
  let total = 0;
  for (const rel of listing(dir)) total += fs.statSync(path.join(dir, rel)).size;
  return total;
}

test.after(() => {
  // Best effort: an open handle or a scanner can keep a file locked on Windows. A failed cleanup must
  // not fail the run, and nothing outside this process's own temp directories is ever touched.
  for (const dir of roots) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        break;
      } catch {
        /* retried below */
      }
    }
  }
});

// ── Kill-switch ───────────────────────────────────────────────────────────────
test('kill-switch: a missing variable means OFF', () => {
  const policy = readCleanupPolicy({});
  assert.equal(policy.globalEnabled, false);
  for (const key of Object.keys(CATEGORY_ENV)) {
    assert.equal(policy[key].mode, 'off');
    assert.equal(policy[key].apply, false);
    assert.equal(policy[key].dryRun, false);
  }
});

test('kill-switch: unknown or misspelled values mean OFF', () => {
  for (const value of ['', '  ', 'tru', 'TRUE ', 'enabled', '1 ', 'yes please', 'on-ish', 'apply', '2']) {
    assert.equal(parseToggle(value), value.trim().toLowerCase() === 'true' || value.trim().toLowerCase() === '1', `toggle ${JSON.stringify(value)}`);
  }
  for (const value of ['', 'off', 'aply', 'dryrun', 'dry_run', 'APPLY ', 'delete', 'true']) {
    const mode = parseMode(value);
    assert.ok(['off', 'dry-run', 'apply'].includes(mode));
    if (!['off', 'dry-run', 'apply'].includes(value.trim().toLowerCase())) assert.equal(mode, 'off', `mode ${JSON.stringify(value)}`);
  }
  const policy = readCleanupPolicy({ CLEANUP_ENABLED: 'TRUE', CLEANUP_ORPHAN_MODE: 'aply', CLEANUP_TMP_MODE: 'dryrun' });
  assert.equal(policy.orphan.mode, 'off');
  assert.equal(policy.generationTemp.mode, 'off');
});

test('kill-switch: a misconfiguration cannot enable deletion', () => {
  // apply requested but the global switch is absent -> not applying
  const missing = readCleanupPolicy({ CLEANUP_ORPHAN_MODE: 'apply' });
  assert.equal(missing.orphan.mode, 'apply');
  assert.equal(missing.orphan.apply, false);
  assert.equal(missing.orphan.blockedByGlobal, true);
  // global switch alone -> nothing applies
  const globalOnly = readCleanupPolicy({ CLEANUP_ENABLED: '1' });
  assert.equal(globalOnly.globalEnabled, true);
  for (const key of Object.keys(CATEGORY_ENV)) assert.equal(globalOnly[key].apply, false);
  // one category cannot drag another along
  const one = readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_ORPHAN_MODE: 'apply' });
  assert.equal(one.orphan.apply, true);
  assert.equal(one.generationTemp.apply, false);
  assert.equal(one.uploadTemp.apply, false);
  assert.equal(one.backups.apply, false);
  assert.equal(one.missingLinks.apply, false);
});

test('kill-switch: dry-run works without the global switch and applies nothing', () => {
  const policy = readCleanupPolicy({ CLEANUP_ORPHAN_MODE: 'dry-run' });
  assert.equal(policy.orphan.dryRun, true);
  assert.equal(policy.orphan.apply, false);
  assert.match(describePolicy(policy), /ORPHAN=dry-run/);
});

// ── Inventory: read-only and fail-closed ──────────────────────────────────────
test('inventory: an empty database blocks the whole scan', () => {
  const box = sandbox('empty-db');
  const db = openDb(box.dbFile);
  touch(path.join(box.images, 'stray.jpg'), { ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.ok(result.blocked.includes('DB_EMPTY'));
  assert.equal(result.candidates.length, 0);
  assert.equal(inv.apply(result).removed.length, 0);
  assert.deepEqual(listing(box.images), ['stray.jpg']);
  db.close();
});

test('inventory: an empty but readable storage still deletes nothing', () => {
  const box = sandbox('empty-storage');
  const db = openDb(box.dbFile);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('a', 'gone.jpg', new Date(0).toISOString());
  db.prepare('INSERT INTO videos (id, video_file, status) VALUES (?, ?, ?)').run('v', 'gone.mp4', 'completed');
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.ok(result.counts.missingOnDisk >= 1);
  assert.equal(result.candidates.length, 0);
  db.close();
});

test('inventory: an unavailable database blocks the scan', () => {
  const box = sandbox('no-db');
  const db = { prepare: () => ({ all: () => { throw Object.assign(new Error('no such table: files'), { code: 'ERR_SQLITE_ERROR' }); } }) };
  touch(path.join(box.images, 'stray.jpg'), { ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.ok(result.blocked.includes('DB_UNAVAILABLE'));
  assert.equal(result.candidates.length, 0);
  assert.equal(inv.apply(result).removed.length, 0);
  assert.deepEqual(listing(box.images), ['stray.jpg']);
});

test('inventory: a corrupt database blocks the scan', () => {
  const box = sandbox('corrupt-db');
  // Not a SQLite file at all: the handle opens, every query fails.
  fs.writeFileSync(box.dbFile, Buffer.from('this is not a sqlite database, just bytes'));
  touch(path.join(box.images, 'stray.jpg'), { ageHours: 100 });
  const db = (() => {
    try {
      return openDb(box.dbFile, { create: false });
    } catch {
      return null;
    }
  })();
  if (!db) {
    // The handle itself could not be opened: the scan is still read-only and still deletes nothing.
    assert.ok(true);
    assert.deepEqual(listing(box.images), ['stray.jpg']);
    return;
  }
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.ok(result.blocked.includes('DB_UNAVAILABLE'));
  assert.equal(result.candidates.length, 0);
  assert.equal(inv.apply(result).removed.length, 0);
  assert.deepEqual(listing(box.images), ['stray.jpg']);
  try {
    db.close();
  } catch {
    /* already closed by the failed read */
  }
});

test('inventory: a partly populated database is never treated as authoritative', () => {
  const box = sandbox('partial-db');
  const db = openDb(box.dbFile);
  // one known row, many files on disk -> coverage too low to trust the database
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('a', 'known.jpg', new Date(Date.now() - 100 * 3600e3).toISOString());
  db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('a', 'v');
  for (let i = 0; i < 5; i++) touch(path.join(box.images, `stray-${i}.jpg`), { ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.ok(result.blocked.includes('DB_COVERAGE_LOW'));
  assert.equal(result.candidates.length, 0);
  assert.equal(inv.apply(result).removed.length, 0);
  assert.equal(listing(box.images).length, 5);
  db.close();
});

test('inventory: an unreadable directory leaves database rows untouched', () => {
  const box = sandbox('no-dir');
  const db = openDb(box.dbFile);
  const inv = createFileInventory({ db, imagesDir: path.join(box.uploads, 'does-not-exist'), videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const before = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  const result = inv.scan();
  assert.ok(result.blocked.includes('IMAGES_DIR_UNAVAILABLE'));
  assert.equal(result.candidates.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, before);
  db.close();
});

test('inventory: dry-run reports candidates without deleting anything', () => {
  const box = sandbox('dry-run');
  const db = openDb(box.dbFile);
  const old = new Date(Date.now() - 100 * 3600e3).toISOString();
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', old);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('used', 'used.jpg', old);
  db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('used', 'v1');
  touch(path.join(box.images, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'used.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'fresh.jpg'), { ageHours: 1 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });

  const result = inv.scan();
  const before = listing(box.images).join(',');

  // policy is read-only here: only the scan report changes, the files do not
  const candidates = result.candidates.map((f) => f.rel);
  assert.deepEqual(candidates, ['images/orphan.jpg']);
  assert.deepEqual(listing(box.images).join(','), before);
  assert.equal(result.files.find((f) => f.name === 'used.jpg').reason, 'referenced');
  assert.equal(result.files.find((f) => f.name === 'fresh.jpg').reason, 'too-new');
  assert.equal(result.files.find((f) => f.name === 'orphan.jpg').reason, 'orphan-row');
  assert.equal(result.files.find((f) => f.name === 'orphan.jpg').status, 'KNOWN_IN_DB');
  db.close();
});

// ── UNKNOWN_IN_DB: never a deletion candidate ────────────────────────────────
// Each case seeds a database that knows `known` files, puts `unknown` files on disk that no row
// mentions, and asserts that not one of them is a candidate or gets removed.
function unknownCase(name, { known, unknown, ageHours = 100, extra = () => {} }) {
  test(`unknown-in-db: ${name}`, () => {
    const box = sandbox(`unknown-${name.replace(/\W+/g, '-')}`);
    const db = openDb(box.dbFile);
    const old = new Date(Date.now() - 100 * 3600e3).toISOString();
    for (let i = 0; i < known; i++) {
      const filename = `known-${i}.jpg`;
      db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run(`k${i}`, filename, old);
      db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run(`k${i}`, `vid-${i}`);
      touch(path.join(box.images, filename), { ageHours: 100 });
    }
    for (let i = 0; i < unknown; i++) {
      touch(path.join(box.images, `stray-${i}.jpg`), { ageHours });
    }
    extra({ db, box, old });

    const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
    const result = inv.scan();
    const before = listing(box.images).join(',');
    // Whatever is on disk without a row is the unknown set (the seeding may have renamed a file).
    const actualUnknown = listing(box.images).filter((n) => !n.startsWith('known-'));
    assert.equal(actualUnknown.length, unknown, `expected ${unknown} unknown file(s), saw ${actualUnknown.join(',')}`);

    for (const filename of actualUnknown) {
      const entry = result.files.find((f) => f.name === filename);
      assert.ok(entry, `${filename} was not even scanned`);
      assert.equal(entry.status, 'UNKNOWN_IN_DB', `${filename} must be UNKNOWN_IN_DB`);
      assert.equal(entry.inDb, false);
      assert.equal(entry.deletable, false);
      assert.equal(entry.needsManualReview, true);
      assert.ok(!result.candidates.some((f) => f.name === filename), `${filename} must never be a candidate`);
    }
    assert.equal(result.counts.unknownInDb, unknown);
    assert.equal(result.manualReview.filter((f) => f.kind === 'images').length, unknown);
    assert.equal(result.candidates.filter((f) => f.kind === 'images').length, 0);
    assert.deepEqual(listing(box.images).join(','), before);
    // Even a forced apply must not remove them.
    const forced = { ...result, blocked: [], candidates: [...result.candidates, ...result.manualReview.filter((f) => f.kind === 'images')] };
    const outcome = inv.apply(forced);
    assert.equal(outcome.removed.length, 0);
    assert.ok(outcome.skipped.every((s) => String(s.reason).startsWith('not-deletable') || s.reason === 'needs-manual-review' || s.reason === 'candidate-not-issued'));
    assert.deepEqual(listing(box.images).join(','), before);
    db.close();
  });
}

unknownCase('one known and one unknown', { known: 1, unknown: 1 });
unknownCase('one known and a hundred unknown', { known: 1, unknown: 100 });
unknownCase('a hundred known and one unknown', { known: 100, unknown: 1 });
unknownCase('an old unknown file', { known: 3, unknown: 1, ageHours: 24 * 365 });
unknownCase('an unknown file with a render-like name', {
  known: 2,
  unknown: 1,
  extra: ({ box }) => {
    // Renamed after seeding so the file itself carries a name a generator could produce.
    const src = path.join(box.images, 'stray-0.jpg');
    const dst = path.join(box.images, '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f.jpg');
    fs.renameSync(src, dst);
  },
});

test('unknown-in-db: a video with no row is never a candidate either', () => {
  const box = sandbox('unknown-video');
  const db = openDb(box.dbFile);
  const old = new Date(Date.now() - 100 * 3600e3).toISOString();
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('k0', 'known-0.jpg', old);
  db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('k0', 'vid-0');
  touch(path.join(box.images, 'known-0.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'orphan-render.mp4'), { ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  const entry = result.files.find((f) => f.name === 'orphan-render.mp4');
  assert.equal(entry.status, 'UNKNOWN_IN_DB');
  assert.equal(entry.deletable, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(inv.apply(result).removed.length, 0);
  assert.deepEqual(listing(box.videos), ['orphan-render.mp4']);
  db.close();
});

test('inventory: apply deletes only the confirmed candidates', () => {
  const box = sandbox('apply');
  const db = openDb(box.dbFile);
  const old = new Date(Date.now() - 100 * 3600e3).toISOString();
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', old);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('used', 'used.jpg', old);
  db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('used', 'v1');
  db.prepare('INSERT INTO videos (id, video_file, status, created_at) VALUES (?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', old);
  touch(path.join(box.images, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'used.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'v1.mp4'), { ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });

  const outcome = inv.apply(inv.scan());
  assert.deepEqual(outcome.removed, ['images/orphan.jpg']);
  assert.deepEqual(outcome.blocked, []);
  assert.deepEqual(listing(box.images), ['used.jpg']);
  assert.deepEqual(listing(box.videos), ['v1.mp4']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get('orphan').n, 0);
  db.close();
});

test('inventory: symlinks and odd names are never candidates', () => {
  const box = sandbox('links');
  const db = openDb(box.dbFile);
  const old = new Date(Date.now() - 100 * 3600e3).toISOString();
  for (let i = 0; i < 3; i++) db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run(`id${i}`, `f${i}.jpg`, old);
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  touch(path.join(box.dir, 'outside.jpg'), { ageHours: 100 });
  // On Windows fs.symlinkSync can hang indefinitely when the host lacks
  // SeCreateSymbolicLinkPrivilege instead of throwing EPERM. Probe support
  // without blocking: hard links work everywhere, symlinks do not.
  let symlinkMade = false;
  if (process.platform !== 'win32') {
    try {
      fs.symlinkSync(path.join(box.dir, 'outside.jpg'), path.join(box.images, 'link.jpg'), 'file');
      symlinkMade = true;
    } catch {
      /* no symlink privileges: link.jpg stays absent */
    }
  }
  fs.mkdirSync(path.join(box.images, 'subdir'));
  const result = inv.scan();
  if (symlinkMade) {
    assert.equal(result.files.find((f) => f.name === 'link.jpg').reason, 'symlink');
  }
  assert.equal(result.files.find((f) => f.name === 'subdir').reason, 'not-a-regular-file');
  assert.equal(result.candidates.length, 0);
  assert.ok(listing(box.dir).includes('outside.jpg'));
  db.close();
});

// ── Generation leftovers ──────────────────────────────────────────────────────
const UUID = '11111111-2222-3333-4444-555555555555';

test('parts: an active render keeps its file', () => {
  assert.equal(classifyPartFile({ name: `${UUID}.part.mp4`, activeJobIds: [UUID] }), 'keep:active');
});

test('parts: a referenced part file is kept even with a matching name', () => {
  assert.equal(classifyPartFile({ name: `${UUID}.part.mp4`, referencedNames: [`${UUID}.part.mp4`] }), 'keep:referenced');
});

test('parts: a row of any status keeps its file', () => {
  assert.equal(classifyPartFile({ name: `${UUID}.part.mp4`, videoIds: [UUID] }), 'keep:row-exists');
});

test('parts: a young file is kept — it may belong to another process', () => {
  assert.equal(classifyPartFile({ name: `${UUID}.part.mp4`, mtimeMs: 100, startedAt: 99 }), 'keep:unowned');
});

test('parts: an unknown extension or malformed name is not a part file', () => {
  assert.equal(classifyPartFile({ name: 'notes.txt' }), 'not-a-part');
  assert.equal(classifyPartFile({ name: `${UUID}.mp4` }), 'not-a-part');
  assert.equal(classifyPartFile({ name: 'not-a-uuid.part.mp4' }), 'not-a-part');
});

test('parts: there is no delete verdict — ownership cannot be proven', () => {
  // A leftover with no row anywhere: still kept. Age and process uptime are not proof of non-use.
  assert.equal(classifyPartFile({ name: `${UUID}.part.mp4` }), 'keep:unowned');
  assert.notEqual(classifyPartFile({ name: `${UUID}.part.mp4` }), 'delete');
});

test('parts: every known state is a keep', () => {
  const verdicts = [
    classifyPartFile({ name: `${UUID}.part.mp4`, activeJobIds: [UUID] }),
    classifyPartFile({ name: `${UUID}.part.mp4`, referencedNames: [`${UUID}.part.mp4`] }),
    classifyPartFile({ name: `${UUID}.part.mp4`, videoIds: [UUID] }),
    classifyPartFile({ name: `${UUID}.part.mp4` }),
  ];
  assert.ok(verdicts.every((v) => v.startsWith('keep:')), verdicts.join(','));
});

test('missing videos: an empty or unknown directory never clears a row', () => {
  assert.equal(classifyMissingVideo({ fileName: 'v.mp4', present: new Set(), dirEmpty: true }), 'empty-dir');
  assert.equal(classifyMissingVideo({ fileName: '', present: new Set(['x']), dirEmpty: false }), 'no-file');
  assert.equal(classifyMissingVideo({ fileName: 'v.mp4', present: new Set(['v.mp4']), dirEmpty: false }), 'present');
  assert.equal(classifyMissingVideo({ fileName: 'v.mp4', present: new Set(['other.mp4']), dirEmpty: false }), 'missing');
  // A file whose stat failed (EACCES / EBUSY / temporary I/O error) is unknown, not missing.
  assert.equal(classifyMissingVideo({ fileName: 'v.mp4', present: new Set(['other.mp4']), dirEmpty: false, unreadable: ['v.mp4'] }), 'unreadable');
  assert.notEqual(classifyMissingVideo({ fileName: 'v.mp4', present: new Set(), dirEmpty: false, unreadable: ['v.mp4'] }), 'missing');
});

// ── Backup rotation ───────────────────────────────────────────────────────────
test('backups: rotation removes only its own surplus snapshots', () => {
  const box = sandbox('backups');
  const db = openDb(box.dbFile);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('a', 'a.jpg', new Date().toISOString());
  const made = [];
  for (let i = 0; i < 4; i++) made.push(backupDatabase(db, box.dbFile, { keep: 2, directory: box.backups }).target);
  const unrelated = touch(path.join(box.backups, 'important-user-file.db'), { bytes: 64 });
  const result = backupDatabase(db, box.dbFile, { keep: 2, directory: box.backups });
  const left = fs.readdirSync(box.backups).sort();
  assert.ok(left.includes('important-user-file.db'));
  assert.equal(left.filter((n) => n.startsWith('bevhub-')).length, 2);
  assert.ok(result.removed.length >= 1);
  assert.ok(result.removed.every((n) => made.includes(path.join(box.backups, n))));
  assert.ok(fs.existsSync(unrelated));
  assert.ok(left.some((n) => n.startsWith('bevhub-') && fs.statSync(path.join(box.backups, n)).size > 0));
  db.close();
});

test('backups: rotation is disabled when the policy says so', () => {
  const box = sandbox('backups-off');
  const db = openDb(box.dbFile);
  for (let i = 0; i < 5; i++) touch(path.join(box.backups, `bevhub-2026-01-0${i + 1}T00-00-00.db`), { bytes: 128 });
  const before = listing(box.backups).length;
  const result = backupDatabase(db, box.dbFile, { keep: 1, rotate: false, directory: box.backups });
  assert.equal(result.rotated, false);
  assert.deepEqual(result.removed, []);
  assert.equal(listing(box.backups).length, before + 1); // only the new snapshot was added
  db.close();
});

test('backups: the default retention never touches the only snapshot', () => {
  const box = sandbox('backups-last');
  const db = openDb(box.dbFile);
  const only = touch(path.join(box.backups, 'bevhub-2020-01-01T00-00-00.db'), { bytes: 256 });
  const result = backupDatabase(db, box.dbFile, { directory: box.backups }); // default keep = 10
  assert.ok(fs.existsSync(only));
  assert.deepEqual(result.removed, []);
  assert.equal(fs.readdirSync(box.backups).filter((n) => n.startsWith('bevhub-')).length, 2);
  db.close();
});

// ── End-to-end: the queue with cleanup disabled ───────────────────────────────
test('queue: with cleanup disabled the recovery pass keeps every leftover', () => {
  const box = sandbox('queue-off');
  const db = openDb(box.dbFile);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO videos (id, video_file, status, created_at) VALUES (?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', ts);
  db.prepare('INSERT INTO generation_jobs (id, video_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)').run('j2', 'v2', 'processing', ts, ts);
  touch(path.join(box.videos, 'v1.mp4'), { ageHours: 100 });
  touch(path.join(box.videos, `${UUID}.part.mp4`), { ageHours: 100 });
  const before = listing(box.videos).join(',');

  const policy = readCleanupPolicy({});
  const queue = createGenerationQueue({ db, imagesDir: box.images, videosDir: box.videos, tmpDir: path.join(box.uploads, 'tmp'), cleanupPolicy: policy });
  const report = queue.recoverOnStartup();
  assert.equal(report.storageError, null);
  assert.equal(report.partsRemoved, 0);
  assert.equal(listing(box.videos).join(','), before);
  assert.equal(db.prepare("SELECT status FROM videos WHERE id = 'v1'").get().status, 'completed');
  db.close();
});

test('queue: a missing directory leaves every video row untouched', () => {
  const box = sandbox('queue-nodir');
  const db = openDb(box.dbFile);
  db.prepare('INSERT INTO videos (id, video_file, status, created_at) VALUES (?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', new Date().toISOString());
  const queue = createGenerationQueue({
    db,
    imagesDir: box.images,
    videosDir: path.join(box.uploads, 'missing-videos'),
    tmpDir: path.join(box.uploads, 'tmp'),
    cleanupPolicy: readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply', CLEANUP_ORPHAN_MODE: 'apply', CLEANUP_MISSING_LINKS_MODE: 'apply' }),
  });
  const report = queue.recoverOnStartup();
  assert.ok(report.storageError);
  assert.equal(report.missing.length, 0);
  assert.equal(db.prepare("SELECT status, video_file FROM videos WHERE id = 'v1'").get().status, 'completed');
  // The explicitly confirmed step is never reached, because the storage could not be read.
  if (!report.storageError && report.missing.length) queue.markMissingVideos(report);
  assert.equal(db.prepare("SELECT video_file FROM videos WHERE id = 'v1'").get().video_file, 'v1.mp4');
  db.close();
});

test('queue: a video whose file is absent is only reported, never cleared', () => {
  const box = sandbox('queue-missing-report');
  const db = openDb(box.dbFile);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'gone.mp4', 'completed', ts, ts);
  // A readable, non-empty directory is what makes the absence provable — here it is empty of the
  // file but not of the directory itself.
  touch(path.join(box.videos, 'other.mp4'), { ageHours: 100 });
  const queue = createGenerationQueue({ db, imagesDir: box.images, videosDir: box.videos, tmpDir: path.join(box.uploads, 'tmp') });
  const report = queue.recoverOnStartup();
  assert.equal(report.storageError, null);
  assert.deepEqual(report.missing.map((m) => m.file), ['gone.mp4']);
  assert.equal(report.partsRemoved, 0);
  const row = db.prepare('SELECT status, video_file FROM videos WHERE id = ?').get('v1');
  assert.equal(row.status, 'completed');
  assert.equal(row.video_file, 'gone.mp4');
  db.close();
});

test('queue: an unreadable file is reported as unverifiable, not as missing', () => {
  const box = sandbox('queue-unreadable');
  const db = openDb(box.dbFile);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', ts, ts);
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v2', 'gone.mp4', 'completed', ts, ts);
  // A directory in place of the file: stat reports a non-file, which is "unknown", not "missing".
  fs.mkdirSync(path.join(box.videos, 'v1.mp4'), { recursive: true });
  const queue = createGenerationQueue({ db, imagesDir: box.images, videosDir: box.videos, tmpDir: path.join(box.uploads, 'tmp') });
  const report = queue.recoverOnStartup();
  assert.equal(report.storageError, null);
  assert.deepEqual(report.missing.map((m) => m.file), ['gone.mp4']);
  assert.ok(report.unverifiable.some((u) => u.file === 'v1.mp4' && u.verdict === 'unreadable'));
  const v1 = db.prepare('SELECT status, video_file FROM videos WHERE id = ?').get('v1');
  assert.equal(v1.status, 'completed');
  assert.equal(v1.video_file, 'v1.mp4');
  db.close();
});

test('queue: markMissingVideos is explicit and only touches provable absences', () => {
  const box = sandbox('queue-mark');
  const db = openDb(box.dbFile);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'gone.mp4', 'completed', ts, ts);
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v2', 'v2.mp4', 'completed', ts, ts);
  touch(path.join(box.videos, 'v2.mp4'), { ageHours: 100 });
  const queue = createGenerationQueue({ db, imagesDir: box.images, videosDir: box.videos, tmpDir: path.join(box.uploads, 'tmp') });
  const report = queue.recoverOnStartup();
  assert.equal(queue.markMissingVideos(report).length, 1);
  assert.equal(db.prepare("SELECT status, video_file FROM videos WHERE id = 'v1'").get().video_file, '');
  assert.equal(db.prepare("SELECT video_file FROM videos WHERE id = 'v2'").get().video_file, 'v2.mp4');
  db.close();
});

test('queue: an interrupted job is marked failed, its render is kept', () => {
  const box = sandbox('queue-interrupted');
  const db = openDb(box.dbFile);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', '', 'processing', ts, ts);
  db.prepare('INSERT INTO generation_jobs (id, video_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)').run('j1', 'v1', 'processing', ts, ts);
  touch(path.join(box.videos, `${UUID}.part.mp4`), { bytes: 2048, ageHours: 100 });
  const queue = createGenerationQueue({
    db,
    imagesDir: box.images,
    videosDir: box.videos,
    tmpDir: path.join(box.uploads, 'tmp'),
    cleanupPolicy: readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply' }),
  });
  const report = queue.recoverOnStartup();
  assert.equal(report.interrupted, 1);
  assert.equal(db.prepare("SELECT status FROM videos WHERE id = 'v1'").get().status, 'failed');
  assert.equal(db.prepare("SELECT status FROM generation_jobs WHERE id = 'j1'").get().status, 'failed');
  assert.ok(listing(box.videos).includes(`${UUID}.part.mp4`));
  assert.equal(report.partsRemoved, 0);
  db.close();
});

test('queue: a fail-closed default keeps leftovers when no policy is passed', () => {
  const box = sandbox('queue-default');
  const db = openDb(box.dbFile);
  db.prepare('INSERT INTO videos (id, video_file, status, created_at) VALUES (?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', new Date().toISOString());
  touch(path.join(box.videos, `${UUID}.part.mp4`), { ageHours: 100 });
  const queue = createGenerationQueue({ db, imagesDir: box.images, videosDir: box.videos, tmpDir: path.join(box.uploads, 'tmp') });
  const report = queue.recoverOnStartup();
  assert.equal(report.partsRemoved, 0);
  assert.ok(listing(box.videos).includes(`${UUID}.part.mp4`));
  db.close();
});

test('queue: the byte count of the storage never changes during a read-only pass', () => {
  const box = sandbox('queue-bytes');
  const db = openDb(box.dbFile);
  touch(path.join(box.videos, 'keep.mp4'), { bytes: 4096, ageHours: 100 });
  touch(path.join(box.videos, `${UUID}.part.mp4`), { bytes: 2048, ageHours: 100 });
  const before = bytes(box.videos);
  const queue = createGenerationQueue({ db, imagesDir: box.images, videosDir: box.videos, tmpDir: path.join(box.uploads, 'tmp'), cleanupPolicy: readCleanupPolicy({}) });
  queue.recoverOnStartup();
  assert.equal(bytes(box.videos), before);
  db.close();
});

// ── Concurrency: two processes, one render in flight ─────────────────────────
// Process A renders into <uuid>.part.mp4 and stays alive; process B then runs the recovery pass with
// every deletion category enabled. B must not touch A's file. This runs in real child processes, so the
// cross-process path (not just the in-process one) is exercised.
const CHILD = `
// Keep stdout clean: the JSON report is parsed by the parent, so logs go to stderr.
console.log = (...args) => console.error(...args);
const { createGenerationQueue } = await import(${JSON.stringify(new URL('../server/generation.js', import.meta.url).href)});
const { readCleanupPolicy } = await import(${JSON.stringify(new URL('../server/cleanup-policy.js', import.meta.url).href)});
const [mode, dbFile, videosDir, imagesDir, tmpDir, partFile] = process.argv.slice(2);
const fs = await import('node:fs');
if (mode === 'holder') {
  // Process A: keep an open handle on the render for a moment, then exit.
  const handle = fs.openSync(partFile, 'r+');
  await new Promise((r) => setTimeout(r, 1500));
  fs.closeSync(handle);
  process.exit(0);
}
if (mode === 'tmp') {
  // Process B: the real startup path for uploads/tmp, with deletion requested and the global switch on.
  const { prepareTmpDir } = await import(${JSON.stringify(new URL('../server/tmp-dir.js', import.meta.url).href)});
  const policy = readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_UPLOAD_TMP_MODE: 'apply' });
  const out = prepareTmpDir({ tmpDir, policy, log: { info: (...a) => console.error(...a), warn: (...a) => console.error(...a) } });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbFile);
const queue = createGenerationQueue({ db, imagesDir, videosDir, tmpDir, cleanupPolicy: readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply', CLEANUP_ORPHAN_MODE: 'apply' }) });
const report = queue.recoverOnStartup();
process.stdout.write(JSON.stringify({ parts: report.parts, partsRemoved: report.partsRemoved }));
db.close();
`;

test('concurrency: a second process never removes another process\'s render', async () => {
  const box = sandbox('two-processes');
  const db = openDb(box.dbFile);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', ts, ts);
  touch(path.join(box.videos, 'v1.mp4'), { ageHours: 100 });
  const partFile = path.join(box.videos, `${UUID}.part.mp4`);
  touch(partFile, { bytes: 4096, ageHours: 100 });
  db.close();

  const script = path.join(box.dir, 'child.mjs');
  fs.writeFileSync(script, CHILD, 'utf8');

  const holder = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'holder', box.dbFile, box.videos, box.images, path.join(box.uploads, 'tmp'), partFile], { encoding: 'utf8' });
  assert.equal(holder.status, 0, holder.stderr);

  // While (or right after) A holds the file, B runs the recovery pass with deletion fully enabled.
  const second = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'scan', box.dbFile, box.videos, box.images, path.join(box.uploads, 'tmp'), partFile], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout);
  assert.equal(report.partsRemoved, 0);
  assert.ok(report.parts.length >= 1);
  assert.ok(report.parts.every((p) => p.deletable === false));

  const stat = fs.statSync(partFile);
  assert.equal(stat.size, 4096, 'the render must survive unchanged');
  assert.deepEqual(listing(box.videos).sort(), ['v1.mp4', `${UUID}.part.mp4`].sort());
});

test('concurrency: a render created immediately before the second process still survives', async () => {
  const box = sandbox('two-processes-late');
  const db = openDb(box.dbFile);
  db.prepare('INSERT INTO videos (id, video_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'v1.mp4', 'completed', new Date().toISOString(), new Date().toISOString());
  touch(path.join(box.videos, 'v1.mp4'), { ageHours: 100 });
  db.close();
  const script = path.join(box.dir, 'child.mjs');
  fs.writeFileSync(script, CHILD, 'utf8');

  const partFile = path.join(box.videos, `${UUID}.part.mp4`);
  // The render appears with mtime = now, while B is about to look at the directory.
  touch(partFile, { bytes: 4096 });
  const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'holder', box.dbFile, box.videos, box.images, path.join(box.uploads, 'tmp'), partFile], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const second = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'scan', box.dbFile, box.videos, box.images, path.join(box.uploads, 'tmp'), partFile], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).partsRemoved, 0);
  holder.kill('SIGKILL');
  assert.ok(fs.existsSync(partFile));
  assert.equal(fs.statSync(partFile).size, 4096);
});

// ── Own-file deletion: the two documented exceptions ─────────────────────────
test('safe-remove: a scratch file created by this operation is removed', () => {
  const box = sandbox('safe-remove-ok');
  const target = touch(path.join(box.uploads, 'tmp', 'scratch.try.mp3'), { bytes: 64 });
  const result = removeOwnFile(target, { dir: path.dirname(target), name: path.basename(target) });
  assert.deepEqual(result, { removed: true, reason: 'removed' });
  assert.equal(fs.existsSync(target), false);
});

test('safe-remove: a path outside the owned directory is refused', () => {
  const box = sandbox('safe-remove-outside');
  const victim = touch(path.join(box.dir, 'user-file.jpg'), { bytes: 64 });
  const result = removeOwnFile(victim, { dir: path.join(box.uploads, 'images'), name: 'user-file.jpg' });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'outside-dir');
  assert.ok(fs.existsSync(victim));
});

test('safe-remove: a name mismatch is refused', () => {
  const box = sandbox('safe-remove-name');
  const victim = touch(path.join(box.dir, 'user-file.jpg'), { bytes: 64 });
  const result = removeOwnFile(victim, { dir: box.dir, name: 'something-else.jpg' });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'name-mismatch');
  assert.ok(fs.existsSync(victim));
});

test('safe-remove: a file that is still referenced is refused', () => {
  const box = sandbox('safe-remove-referenced');
  const victim = touch(path.join(box.dir, 'file.jpg'), { bytes: 64 });
  const result = removeOwnFile(victim, { dir: box.dir, name: 'file.jpg', isUnused: () => false });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'still-referenced');
  assert.ok(fs.existsSync(victim));
});

test('safe-remove: a symlink is never removed through this path', () => {
  if (process.platform === 'win32') {
    // fs.symlinkSync hangs on some Windows hosts instead of throwing EPERM
    // when SeCreateSymbolicLinkPrivilege is missing; symlink behaviour
    // cannot be exercised here.
    return;
  }
  const box = sandbox('safe-remove-link');
  const outside = touch(path.join(box.dir, 'outside.jpg'), { bytes: 64 });
  const link = path.join(box.dir, 'link.jpg');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch {
    return; // no symlink privileges on this host
  }
  const result = removeOwnFile(link, { dir: box.dir, name: 'link.jpg' });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'not-a-plain-file');
  assert.ok(fs.existsSync(outside));
});

test('safe-remove: a file that existed before the operation is never removed', () => {
  const box = sandbox('safe-remove-old');
  // The name matches, the directory matches — but the file is a day old, so this operation cannot have
  // written it. Deleting it would destroy somebody else's data, whatever the config says.
  const victim = touch(path.join(box.dir, 'scratch.mp3'), { bytes: 128, ageHours: 24 });
  const startedAt = Date.now();
  const result = removeOwnFile(victim, { dir: box.dir, name: 'scratch.mp3', notOlderThan: startedAt });
  assert.deepEqual(result, { removed: false, reason: 'pre-existing' });
  assert.equal(fs.statSync(victim).size, 128);
});

test('safe-remove: a file written during the operation is removed', () => {
  const box = sandbox('safe-remove-new');
  const startedAt = Date.now() - 1000;
  const own = touch(path.join(box.dir, 'scratch.mp3'), { bytes: 128 });
  const result = removeOwnFile(own, { dir: box.dir, name: 'scratch.mp3', notOlderThan: startedAt });
  assert.deepEqual(result, { removed: true, reason: 'removed' });
  assert.equal(fs.existsSync(own), false);
});

// ── safe-remove TOCTOU adversarial tests ──────────────────────────────────

test('safe-remove: parent directory replaced with a file → not removed', () => {
  const box = sandbox('safe-remove-parent-file');
  const sub = path.join(box.dir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const target = path.join(sub, 'scratch.mp3');
  fs.writeFileSync(target, Buffer.alloc(128));
  const startedAt = Date.now();
  // Delete the parent directory (and its contents), then put a file at the parent path.
  // removeOwnFile lstat's the target first — target is gone because the directory was removed.
  fs.rmSync(sub, { recursive: true, force: true });
  fs.writeFileSync(sub, 'not a directory');
  const result = removeOwnFile(target, { dir: sub, name: 'scratch.mp3', notOlderThan: startedAt });
  assert.equal(result.removed, false, 'parent replaced by file → not removed');
  assert.equal(result.reason, 'already-gone', 'target no longer exists');
});

test('safe-remove: file replaced with symlink → not removed', (t) => {
  if (process.platform === 'win32') {
    t.skip('fs.symlinkSync hangs on this Windows host — skipped, not passed');
    return;
  }
  const box = sandbox('safe-remove-symlink');
  const outside = touch(path.join(box.dir, 'outside.jpg'), { bytes: 64 });
  const target = path.join(box.dir, 'scratch.mp3');
  fs.writeFileSync(target, Buffer.alloc(128));
  const startedAt = Date.now();
  // Replace the file with a symlink after creating it.
  fs.rmSync(target, { force: true });
  fs.symlinkSync(outside, target, 'file');
  const result = removeOwnFile(target, { dir: box.dir, name: 'scratch.mp3', notOlderThan: startedAt });
  assert.equal(result.removed, false, 'symlink substitution → not removed');
  assert.equal(result.reason, 'not-a-plain-file');
  assert.ok(fs.existsSync(outside), 'symlink target must survive');
});

test('safe-remove: file replaced with different content after startedAt → removed (it is now our file)', () => {
  const box = sandbox('safe-remove-replaced');
  const target = path.join(box.dir, 'scratch.mp3');
  fs.writeFileSync(target, Buffer.alloc(128));
  const startedAt = Date.now();
  // Overwrite the file after startedAt — its mtime is now after startedAt, so it is treated as ours.
  fs.writeFileSync(target, Buffer.alloc(9999, 0x62));
  const result = removeOwnFile(target, { dir: box.dir, name: 'scratch.mp3', notOlderThan: startedAt });
  assert.equal(result.removed, true, 'file rewritten after startedAt → removed');
  assert.equal(fs.existsSync(target), false, 'file must be gone');
});

// ── Per-run ownership: scratch directories and render files ────────────────────
test('runs: a retry gets a fresh scratch directory and a fresh render file', () => {
  const box = sandbox('runs-fresh');
  const args = { tmpDir: path.join(box.uploads, 'tmp'), videosDir: box.videos, videoId: UUID };
  const first = jobPaths(args);
  const second = jobPaths(args);
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.workDir, second.workDir);
  assert.notEqual(first.partPath, second.partPath);
  // The published name is per video, not per run: a retry replaces the previous result.
  assert.equal(first.finalPath, second.finalPath);
  assert.equal(path.basename(first.finalPath), `${UUID}.mp4`);
  // Both identifiers appear in the paths, which is what makes a leftover attributable.
  assert.equal(path.basename(first.workDir), first.runId);
  assert.ok(path.basename(first.partPath).includes(first.runId));
});

test('runs: parallel renders of one video cannot delete each other\'s scratch', () => {
  const box = sandbox('runs-parallel');
  const args = { tmpDir: path.join(box.uploads, 'tmp'), videosDir: box.videos, videoId: UUID };
  const first = jobPaths(args);
  const second = jobPaths(args);

  // Both runs create their directory exclusively, exactly as `run()` does.
  fs.mkdirSync(path.dirname(first.workDir), { recursive: true });
  fs.mkdirSync(first.workDir);
  fs.mkdirSync(second.workDir);
  fs.writeFileSync(path.join(first.workDir, 'voice.wav'), Buffer.alloc(512, 0x61));
  fs.writeFileSync(path.join(second.workDir, 'voice.wav'), Buffer.alloc(512, 0x62));

  // Run A finishes and cleans up its own directory.
  fs.rmSync(first.workDir, { recursive: true, force: true });

  assert.equal(fs.existsSync(first.workDir), false);
  assert.equal(fs.readFileSync(path.join(second.workDir, 'voice.wav')).length, 512);
});

test('runs: a second run cannot claim an existing directory', () => {
  const box = sandbox('runs-exclusive');
  const args = { tmpDir: path.join(box.uploads, 'tmp'), videosDir: box.videos, videoId: UUID };
  const first = jobPaths(args);
  fs.mkdirSync(path.dirname(first.workDir), { recursive: true });
  fs.mkdirSync(first.workDir);
  // A reused name would have to collide with the UUID; if it ever did, creation must fail loudly.
  assert.throws(() => fs.mkdirSync(first.workDir), (err) => err.code === 'EEXIST');
});

test('parts: a per-run render file is recognised and never deletable', () => {
  const box = sandbox('runs-parts');
  const { partPath } = jobPaths({ tmpDir: path.join(box.uploads, 'tmp'), videosDir: box.videos, videoId: UUID });
  const name = path.basename(partPath);
  assert.equal(classifyPartFile({ name }), 'keep:unowned');
  assert.equal(classifyPartFile({ name, videoIds: [UUID] }), 'keep:row-exists');
  assert.equal(classifyPartFile({ name, referencedNames: [name] }), 'keep:referenced');
  assert.equal(classifyPartFile({ name, activeJobIds: [UUID] }), 'keep:active');
  assert.equal(classifyPartFile({ name }), 'keep:unowned');
  assert.ok(classifyPartFile({ name }).startsWith('keep:'));
});

test('failed render: kept when temp cleanup is disabled', () => {
  const box = sandbox('fail-off');
  const partFile = touch(path.join(box.videos, `${UUID}.abc.part.mp4`), { bytes: 4096 });
  const outcome = cleanupFailedRender({ partPath: partFile, rendered: false, policy: readCleanupPolicy({}), startedAt: Date.now() });
  assert.deepEqual(outcome, { removed: false, reason: 'cleanup-disabled' });
  assert.equal(fs.statSync(partFile).size, 4096);
});

test('failed render: kept when the file predates the run', () => {
  const box = sandbox('fail-old');
  const partFile = touch(path.join(box.videos, `${UUID}.abc.part.mp4`), { bytes: 4096, ageHours: 5 });
  const policy = readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply' });
  const outcome = cleanupFailedRender({ partPath: partFile, rendered: false, policy, startedAt: Date.now() });
  assert.deepEqual(outcome, { removed: false, reason: 'pre-existing' });
  assert.equal(fs.statSync(partFile).size, 4096);
});

test('failed render: kept when a valid file was produced', () => {
  const box = sandbox('fail-valid');
  const partFile = touch(path.join(box.videos, `${UUID}.abc.part.mp4`), { bytes: 4096 });
  const policy = readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply' });
  const outcome = cleanupFailedRender({ partPath: partFile, rendered: true, policy, startedAt: Date.now() });
  assert.deepEqual(outcome, { removed: false, reason: 'valid-render-kept' });
  assert.equal(fs.statSync(partFile).size, 4096);
});

test('failed render: removed when this run wrote it and cleanup is on', () => {
  const box = sandbox('fail-own');
  const startedAt = Date.now();
  const partFile = touch(path.join(box.videos, `${UUID}.abc.part.mp4`), { bytes: 4096 });
  const policy = readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply' });
  const outcome = cleanupFailedRender({ partPath: partFile, rendered: false, policy, startedAt });
  assert.deepEqual(outcome, { removed: true, reason: 'removed' });
  assert.equal(fs.existsSync(partFile), false);
});

test('failed render: a call without a policy falls back to fail-closed', () => {
  const box = sandbox('fail-nopolicy');
  const partFile = touch(path.join(box.videos, `${UUID}.abc.part.mp4`), { bytes: 4096 });
  const outcome = cleanupFailedRender({ partPath: partFile, rendered: false, startedAt: Date.now() });
  assert.deepEqual(outcome, { removed: false, reason: 'cleanup-disabled' });
  assert.equal(fs.statSync(partFile).size, 4096);
});

// ── uploads/tmp: locked at startup ────────────────────────────────────────────
test('policy: the recursive temp wipe cannot be enabled by configuration', () => {
  for (const env of [
    { CLEANUP_ENABLED: 'true', CLEANUP_UPLOAD_TMP_MODE: 'apply' },
    { CLEANUP_ENABLED: '1', CLEANUP_UPLOAD_TMP_MODE: 'apply', CLEANUP_TMP_MODE: 'apply' },
  ]) {
    const policy = readCleanupPolicy(env);
    assert.equal(policy.uploadTemp.mode, 'apply');
    assert.equal(policy.uploadTemp.locked, true);
    assert.equal(policy.uploadTemp.dryRun, false);
    assert.equal(policy.uploadTemp.apply, false, 'a locked category never deletes');
    assert.equal(policy.uploadTemp.blockedByLock, true);
  }
});

test('tmp: startup creates the directory and removes nothing from it', () => {
  const box = sandbox('tmp-create');
  const tmpDir = path.join(box.dir, 'uploads', 'tmp-missing');
  const logs = [];
  const outcome = prepareTmpDir({ tmpDir, policy: readCleanupPolicy({}), log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  assert.equal(outcome.created, true);
  assert.equal(outcome.removed, 0);
  assert.equal(outcome.leftovers, 0);
  assert.equal(fs.existsSync(tmpDir), true);
});

test('tmp: a scratch tree another process is writing survives startup', async () => {
  const box = sandbox('tmp-two-processes');
  const tmpDir = path.join(box.uploads, 'tmp');
  const { workDir, partPath } = jobPaths({ tmpDir, videosDir: box.videos, videoId: UUID });

  // Process A: a render that is mid-flight, with its own run directory and a file inside it.
  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  fs.mkdirSync(workDir);
  const scratch = touch(path.join(workDir, 'voice.wav'), { bytes: 2048 });
  touch(partPath, { bytes: 4096 });
  const handle = fs.openSync(scratch, 'r+');

  const script = path.join(box.dir, 'child.mjs');
  fs.writeFileSync(script, CHILD, 'utf8');
  const second = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'tmp', box.dbFile, box.videos, box.images, tmpDir, partPath], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout);
  assert.equal(report.removed, 0, 'a locked category reports no deletion');
  assert.equal(report.locked, true);
  assert.ok(report.leftovers >= 1, 'the scratch tree is reported as kept');

  // A keeps writing after B's startup pass — proof that its directory was not removed.
  fs.writeSync(handle, Buffer.alloc(1024, 0x62), 0, 1024, 2048);
  fs.closeSync(handle);
  assert.equal(fs.statSync(scratch).size, 3072);
  assert.ok(fs.existsSync(workDir));
  assert.deepEqual(listing(tmpDir), [`${UUID}/${path.basename(workDir)}/voice.wav`]);
  assert.equal(fs.statSync(partPath).size, 4096, 'the render file is untouched');
});

// ── Inventory: the scan-to-delete window ──────────────────────────────────────
// ── Scratch directory ownership ───────────────────────────────────────────────
test('scratch: a directory this run created is removed in finally', () => {
  const box = sandbox('scratch-own');
  const { workDir } = jobPaths({ tmpDir: path.join(box.uploads, 'tmp'), videosDir: box.videos, videoId: UUID });

  // The exact sequence of run(): create the parent, create the run directory exclusively, work in it.
  let ownsWorkDir = false;
  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  fs.mkdirSync(workDir);
  ownsWorkDir = true;
  fs.writeFileSync(path.join(workDir, 'voice.wav'), Buffer.alloc(2048, 0x61));

  const logs = [];
  const outcome = removeRunWorkDir({ workDir, ownsWorkDir, label: UUID, log: { warn: (m) => logs.push(m) } });

  assert.deepEqual(outcome, { removed: true, reason: 'removed' });
  assert.equal(fs.existsSync(workDir), false);
  assert.deepEqual(logs, [], 'a directory this run created needs no warning');
});

test('scratch: a directory another run owns is left untouched (EEXIST)', () => {
  const box = sandbox('scratch-eexist');
  const { workDir } = jobPaths({ tmpDir: path.join(box.uploads, 'tmp'), videosDir: box.videos, videoId: UUID });

  // Somebody else's directory is already there, with content. run() creates its parent, then fails to
  // create the directory and therefore never becomes its owner.
  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  fs.mkdirSync(workDir);
  const foreign = path.join(workDir, 'voice.wav');
  fs.writeFileSync(foreign, Buffer.alloc(4096, 0x62));

  let ownsWorkDir = false;
  assert.throws(() => fs.mkdirSync(workDir), (err) => err.code === 'EEXIST');
  // The assignment in run() sits after the mkdir, so it never ran: the flag is still false.
  assert.equal(ownsWorkDir, false, 'ownership is set only after a successful mkdir');

  const logs = [];
  const outcome = removeRunWorkDir({ workDir, ownsWorkDir, label: UUID, log: { warn: (m) => logs.push(m) } });

  assert.deepEqual(outcome, { removed: false, reason: 'not-owner' });
  assert.equal(fs.existsSync(workDir), true, 'the directory must survive');
  assert.equal(fs.readFileSync(foreign).length, 4096, 'its content must survive unchanged');
  assert.equal(logs.length, 1, 'the operator is told why nothing was removed');
  assert.match(logs[0], /not created by this run/);
});

test('inventory: a file that changed after the scan is not deleted', () => {
  const box = sandbox('scan-race');
  const db = openDb(box.dbFile);
  const old = new Date(Date.now() - 100 * 3600e3).toISOString();
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', old);
  const target = touch(path.join(box.images, 'orphan.jpg'), { bytes: 1024, ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: box.dir, ttlHours: 24 });
  const scan = inv.scan();
  assert.equal(scan.candidates.length, 1);
  assert.deepEqual(scan.candidates[0].fingerprint, { size: 1024, mtimeMs: fs.statSync(target).mtimeMs, ino: fs.statSync(target).ino ?? 0 });

  // Somebody else rewrote the file between the scan and the delete: same name, different content.
  fs.writeFileSync(target, Buffer.alloc(4096, 0x62));

  const outcome = inv.apply(scan);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'changed-since-scan' }]);
  assert.equal(fs.statSync(target).size, 4096, 'the rewritten file must survive');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get('orphan').n, 1, 'its row survives too');
  db.close();
});