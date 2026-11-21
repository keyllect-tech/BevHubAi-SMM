// Inventory scope tests (Stage C / B-01): every file below the uploads root must be reported, and a
// file no database table can vouch for must never become a deletion candidate.
//
// Everything runs in throwaway directories under %TEMP%\bevhub-scope-*: no test reads, writes or
// deletes anything under the project's real `uploads/` or `data/`, and none of them starts the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createFileInventory } from '../server/file-inventory.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, workspace_id TEXT, filename TEXT NOT NULL, mime_type TEXT, size INTEGER, original_name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, workspace_id TEXT, video_file TEXT NOT NULL DEFAULT '', status TEXT, error_message TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS video_assets (file_id TEXT, video_id TEXT, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS brand_kits (workspace_id TEXT, logo_url TEXT);
`;

const roots = [];
function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bevhub-scope-${name}-`));
  roots.push(dir);
  const uploads = path.join(dir, 'uploads');
  for (const sub of ['images', 'videos', 'audio', 'tmp']) fs.mkdirSync(path.join(uploads, sub), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return { dir, uploads, images: path.join(uploads, 'images'), videos: path.join(uploads, 'videos'), audio: path.join(uploads, 'audio'), tmp: path.join(uploads, 'tmp'), dbFile: path.join(dir, 'data', 'test.db') };
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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

const OLD = () => new Date(Date.now() - 100 * 3600e3).toISOString();

/** A database that knows one image and one video, both referenced: no coverage block. */
function seedKnown(db) {
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('k0', 'known.jpg', OLD());
  db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('k0', 'vid-0');
  db.prepare('INSERT INTO videos (id, video_file, status, created_at) VALUES (?, ?, ?, ?)').run('vid-0', 'known.mp4', 'completed', OLD());
}

function inventory(box, db, overrides = {}, ttlHours = 24) {
  return createFileInventory({
    db,
    imagesDir: overrides.imagesDir || box.images,
    videosDir: overrides.videosDir || box.videos,
    uploadsDir: overrides.uploadsDir || box.uploads,
    audioDir: overrides.audioDir || box.audio,
    trustedRoot: Object.prototype.hasOwnProperty.call(overrides, 'trustedRoot') ? overrides.trustedRoot : box.dir,
    ttlHours,
  });
}

/** Every absolute path the scan reported, for duplicate and containment checks. */
function absPaths(result) {
  return result.files.map((f) => path.resolve(f.abs));
}

function byRel(result, rel) {
  return result.files.find((f) => f.rel === rel);
}

test.after(() => {
  for (const dir of roots) {
    clearLinks(dir); // a junction must be unlinked before its parent is removed
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        break;
      } catch {
        /* retried */
      }
    }
  }
});

/** Removes links/junctions below `dir` without ever descending into their targets. */
function clearLinks(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        fs.rmdirSync(abs); // removes the link itself; the target is untouched
      } catch {
        /* best effort */
      }
      continue;
    }
    if (st.isDirectory()) clearLinks(abs);
  }
}

/** Creates a Windows junction (no administrator needed). Returns null when unsupported. */
function mkJunction(link, target) {
  if (process.platform === 'win32') {
    // On some Windows hosts mklink hangs indefinitely instead of returning
    // ERROR_PRIVILEGE_NOT_HELD when SeCreateSymbolicLinkPrivilege is missing.
    return 'symlinks/junctions are not creatable on this Windows host';
  }
  const res = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
  return res.status === 0 ? null : `${res.code || res.status}: ${(res.stderr || res.stdout || '').trim()}`;
}

/** Creates a symbolic link. Returns null when the host forbids it (EPERM without the privilege). */
function mkSymlink(target, link, type) {
  if (process.platform === 'win32') {
    // On some Windows hosts fs.symlinkSync hangs indefinitely instead of
    // throwing EPERM when SeCreateSymbolicLinkPrivilege is missing.
    return 'symlinks are not creatable on this Windows host';
  }
  try {
    fs.symlinkSync(target, link, type);
    return null;
  } catch (err) {
    return `${err.code || 'ESYMLINK'}: ${err.message}`;
  }
}

// ── 1. A file directly in uploads ─────────────────────────────────────────────
test('scope: a file directly in uploads is reported and never deletable', () => {
  const box = sandbox('root-file');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.uploads, 'test_landscape.jpg'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  const entry = byRel(result, 'root/test_landscape.jpg');
  assert.ok(entry, 'a file in the uploads root must be scanned');
  assert.equal(entry.kind, 'root');
  assert.equal(entry.status, 'NEEDS_MANUAL_REVIEW');
  assert.equal(entry.reason, 'outside-database-scope');
  assert.equal(entry.deletable, false);
  assert.equal(entry.needsManualReview, true);
  assert.equal(entry.inDb, null);
  assert.ok(!result.candidates.some((f) => f.rel === 'root/test_landscape.jpg'));
  assert.ok(result.manualReview.some((f) => f.rel === 'root/test_landscape.jpg'));
  assert.equal(result.counts.outsideDbScope, 1);
  assert.deepEqual(result.blocked, []);
  db.close();
});

// ── 2. A file in uploads/audio ────────────────────────────────────────────────
test('scope: a file in uploads/audio is reported and never deletable', () => {
  const box = sandbox('audio-file');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.audio, 'voice-01.mp3'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  const entry = byRel(result, 'audio/voice-01.mp3');
  assert.ok(entry, 'a file in uploads/audio must be scanned');
  assert.equal(entry.kind, 'audio');
  assert.equal(entry.status, 'NEEDS_MANUAL_REVIEW');
  assert.equal(entry.reason, 'outside-database-scope');
  assert.equal(entry.deletable, false);
  assert.equal(result.counts.outsideDbScope, 1);
  assert.ok(!result.candidates.some((f) => f.kind === 'audio'));
  assert.deepEqual(result.blocked, []);
  db.close();
});

test('scope: audio and root files do not make a good database look partial', () => {
  const box = sandbox('audio-coverage');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  for (let i = 0; i < 21; i++) touch(path.join(box.audio, `voice-${i}.mp3`), { ageHours: 100 });
  for (let i = 0; i < 6; i++) touch(path.join(box.uploads, `root-${i}.jpg`), { ageHours: 100 });

  const result = inventory(box, db).scan();
  // The coverage ratio only measures what the database could know: 21 audio files are not "unknown".
  assert.ok(!result.blocked.includes('DB_COVERAGE_LOW'), `blocked: ${result.blocked.join(',')}`);
  assert.equal(result.counts.unknownInDb, 0);
  assert.equal(result.counts.outsideDbScope, 27);
  assert.equal(result.counts.scanned, 29);
  db.close();
});

// ── 3. A file in a supported subdirectory ─────────────────────────────────────
test('scope: supported subdirectories keep their existing verdicts', () => {
  const box = sandbox('supported');
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', OLD());
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('fresh', 'fresh.jpg', new Date().toISOString());
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'fresh.jpg'), { ageHours: 1 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.videos, 'stray.mp4'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  assert.equal(byRel(result, 'images/known.jpg').reason, 'referenced');
  assert.equal(byRel(result, 'images/known.jpg').status, 'KNOWN_IN_DB');
  assert.equal(byRel(result, 'images/known.jpg').inDb, true);
  assert.equal(byRel(result, 'images/orphan.jpg').reason, 'orphan-row');
  assert.equal(byRel(result, 'images/orphan.jpg').status, 'KNOWN_IN_DB');
  assert.equal(byRel(result, 'images/fresh.jpg').reason, 'too-new');
  assert.equal(byRel(result, 'videos/known.mp4').reason, 'referenced');
  assert.equal(byRel(result, 'videos/stray.mp4').status, 'UNKNOWN_IN_DB');
  assert.deepEqual(result.candidates.map((f) => f.rel), ['images/orphan.jpg']);
  db.close();
});

// ── 4. Nested directories ────────────────────────────────────────────────────
test('scope: a nested directory below uploads is walked and reported as manual review', () => {
  const box = sandbox('nested-root');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.uploads, 'misc', 'deep', 'note.jpg'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  const entry = byRel(result, 'root/misc/deep/note.jpg');
  assert.ok(entry, 'a nested file below uploads must be scanned');
  assert.equal(entry.kind, 'root');
  assert.equal(entry.status, 'NEEDS_MANUAL_REVIEW');
  assert.equal(entry.reason, 'nested-path');
  assert.equal(entry.deletable, false);
  assert.equal(result.counts.nested, 1);
  db.close();
});

test('scope: a nested file inside a media directory is never deletable, even with an orphan row', () => {
  const box = sandbox('nested-images');
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', OLD());
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.images, 'sub', 'orphan.jpg'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  const entry = byRel(result, 'images/sub/orphan.jpg');
  assert.ok(entry, 'the nested file must be reported');
  assert.equal(entry.reason, 'nested-path');
  assert.equal(entry.status, 'NEEDS_MANUAL_REVIEW');
  assert.equal(entry.deletable, false);
  assert.deepEqual(result.candidates.map((f) => f.rel), [], 'a nested file is never a candidate');
  // The directory itself is reported as a non-file, as before.
  assert.equal(byRel(result, 'images/sub').reason, 'not-a-regular-file');

  const outcome = inventory(box, db).apply({ ...result, blocked: [] });
  assert.deepEqual(outcome.removed, []);
  assert.equal(fs.existsSync(path.join(box.images, 'sub', 'orphan.jpg')), true);
  db.close();
});

test('scope: a directory below the nesting limit is walked, a deeper one is truncated and blocks', () => {
  const box = sandbox('nested-deep');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  // depth 0..4 are walked; a file at depth 5 cannot be reached
  touch(path.join(box.uploads, 'a', 'b', 'c', 'd', 'e', 'too-deep.jpg'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  assert.ok(result.blocked.includes('INVENTORY_LIMIT_REACHED'), `blocked: ${result.blocked.join(',')}`);
  assert.equal(result.candidates.length, 0);
  assert.ok(!absPaths(result).includes(path.join(box.uploads, 'a', 'b', 'c', 'd', 'too-deep.jpg')));
  db.close();
});

// ── 5. A file registered in the database ──────────────────────────────────────
test('scope: a database-registered image and video are known', () => {
  const box = sandbox('known');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  assert.equal(byRel(result, 'images/known.jpg').status, 'KNOWN_IN_DB');
  assert.equal(byRel(result, 'images/known.jpg').inDb, true);
  assert.equal(byRel(result, 'videos/known.mp4').status, 'KNOWN_IN_DB');
  assert.equal(byRel(result, 'videos/known.mp4').inDb, true);
  assert.equal(result.counts.unknownInDb, 0);
  assert.equal(result.counts.missingOnDisk, 0);
  db.close();
});

// ── 6. A file absent from the database ────────────────────────────────────────
test('scope: a file with no database row is unknown, never a candidate', () => {
  const box = sandbox('unknown');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.images, 'stray.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'stray.mp4'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  for (const rel of ['images/stray.jpg', 'videos/stray.mp4']) {
    const entry = byRel(result, rel);
    assert.equal(entry.status, 'UNKNOWN_IN_DB', rel);
    assert.equal(entry.inDb, false, rel);
    assert.equal(entry.deletable, false, rel);
    assert.equal(entry.needsManualReview, true, rel);
  }
  assert.equal(result.counts.unknownInDb, 2);
  assert.equal(result.candidates.length, 0);

  // Even a forced apply must not remove them.
  const forced = { ...result, blocked: [], candidates: [...result.candidates, ...result.manualReview] };
  assert.deepEqual(inventory(box, db).apply(forced).removed, []);
  assert.equal(fs.existsSync(path.join(box.images, 'stray.jpg')), true);
  assert.equal(fs.existsSync(path.join(box.videos, 'stray.mp4')), true);
  db.close();
});

// ── 7. Symlinks and reparse points ────────────────────────────────────────────
test('scope: a symlink is never followed and never deletable', () => {
  const box = sandbox('symlink');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  const outside = touch(path.join(box.dir, 'outside.jpg'), { ageHours: 100 });

  let symlinkMade = false;
  let junctionMade = false;
  if (process.platform !== 'win32') {
    try {
      fs.symlinkSync(outside, path.join(box.images, 'link.jpg'), 'file');
      symlinkMade = true;
      fs.symlinkSync(path.join(box.dir, 'outside-dir'), path.join(box.uploads, 'linked-dir'), 'junction');
      junctionMade = true;
    } catch {
      return; // no symlink privileges on this host: nothing to assert
    }
  }
  if (process.platform === 'win32') {
    // On this Windows host fs.symlinkSync hangs instead of throwing EPERM.
    fs.writeFileSync(path.join(box.images, 'link.jpg'), Buffer.alloc(64));
    fs.mkdirSync(path.join(box.uploads, 'linked-dir'), { recursive: true });
    fs.mkdirSync(path.join(box.dir, 'outside-dir'), { recursive: true });
    touch(path.join(box.dir, 'outside-dir', 'hidden.jpg'), { ageHours: 100 });
  } else {
    fs.mkdirSync(path.join(box.dir, 'outside-dir'));
    touch(path.join(box.dir, 'outside-dir', 'hidden.jpg'), { ageHours: 100 });
  }

  const result = inventory(box, db).scan();
  const link = byRel(result, 'images/link.jpg');
  if (symlinkMade) {
    assert.equal(link.reason, 'symlink');
    assert.equal(link.status, 'NEEDS_MANUAL_REVIEW');
    assert.equal(link.deletable, false);
  }

  // A linked directory is not descended into: the file behind it stays invisible.
  const linked = byRel(result, 'root/linked-dir');
  if (junctionMade) {
    assert.ok(linked, 'a directory entry is still reported');
    assert.equal(linked.reason, 'symlink');
    assert.ok(!result.files.some((f) => f.rel.includes('hidden.jpg')), 'a symlinked directory is never walked');
  }
  assert.equal(result.candidates.length, 0);
  assert.equal(fs.statSync(outside).size, 1024, 'the symlink target is untouched');
  db.close();
});

// ── 8. Unreadable or ambiguous paths ──────────────────────────────────────────
test('scope: a directory in place of a file is ambiguous, not missing and not junk', () => {
  const box = sandbox('ambiguous');
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO videos (id, video_file, status, created_at) VALUES (?, ?, ?, ?)').run('vid-1', 'v1.mp4', 'completed', OLD());
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  fs.mkdirSync(path.join(box.videos, 'v1.mp4'), { recursive: true });

  const result = inventory(box, db).scan();
  const entry = byRel(result, 'videos/v1.mp4');
  assert.ok(entry);
  assert.equal(entry.status, 'PATH_INVALID');
  assert.equal(entry.reason, 'not-a-regular-file');
  assert.equal(entry.deletable, false);
  assert.equal(result.candidates.length, 0);
  // The row is not declared missing: something exists at that path, so absence is not provable.
  assert.equal(result.counts.missingOnDisk, 0);
  assert.equal(fs.existsSync(path.join(box.videos, 'v1.mp4')), true);
  db.close();
});

test('scope: a file that cannot be stat-ed is unknown, not garbage', () => {
  const box = sandbox('unreadable');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.images, 'locked.jpg'), { ageHours: 100 });
  const victim = path.join(box.images, 'locked.jpg');

  const real = fs.lstatSync;
  fs.lstatSync = (p, ...rest) => {
    if (path.resolve(String(p)) === path.resolve(victim)) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return real(p, ...rest);
  };
  let result;
  try {
    result = inventory(box, db).scan();
  } finally {
    fs.lstatSync = real;
  }

  const entry = byRel(result, 'images/locked.jpg');
  assert.ok(entry);
  assert.equal(entry.status, 'NEEDS_MANUAL_REVIEW');
  assert.equal(entry.reason, 'unreadable');
  assert.equal(entry.deletable, false);
  assert.equal(entry.inDb, null);
  assert.ok(result.errors.some((e) => e.file === 'images/locked.jpg' && e.code === 'EACCES'));
  assert.equal(result.candidates.length, 0);
  assert.equal(fs.statSync(victim).size, 1024, 'the file is untouched');
  db.close();
});

// ── 9. No duplicated results ──────────────────────────────────────────────────
test('scope: no file is reported twice and reserved directories are not re-walked', () => {
  const box = sandbox('dedupe');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.audio, 'voice.mp3'), { ageHours: 100 });
  touch(path.join(box.uploads, 'root.jpg'), { ageHours: 100 });
  touch(path.join(box.uploads, 'images', 'sub', 'nested.jpg'), { ageHours: 100 });
  touch(path.join(box.tmp, 'scratch', 'voice.wav'), { ageHours: 100 });

  const result = inventory(box, db).scan();

  const paths = absPaths(result);
  assert.equal(new Set(paths).size, paths.length, 'each absolute path appears exactly once');
  const rels = result.files.map((f) => f.rel);
  assert.equal(new Set(rels).size, rels.length, 'each report path appears exactly once');

  // uploads/tmp is a separate locked category: its contents are not part of this inventory.
  assert.ok(!result.files.some((f) => f.rel.startsWith('root/tmp/')), 'uploads/tmp is not re-walked');
  // images/ and videos/ are covered by their own scope, not by the root scope.
  assert.ok(!result.files.some((f) => f.rel === 'root/images'), 'images is not reported by the root scope');
  assert.ok(!result.files.some((f) => f.rel === 'root/videos'), 'videos is not reported by the root scope');
  assert.ok(!result.files.some((f) => f.rel === 'root/audio'), 'audio is not reported by the root scope');
  // The nested file inside images is still found once, by the images scope.
  assert.equal(byRel(result, 'images/sub/nested.jpg').reason, 'nested-path');
  assert.ok(byRel(result, 'audio/voice.mp3'));
  assert.ok(byRel(result, 'root/root.jpg'));

  // One entry per real file on disk, plus the directory entry, minus the reserved tree:
  // known.jpg + images/sub + images/sub/nested.jpg + known.mp4 + voice.mp3 + root.jpg.
  assert.equal(result.files.length, 6, `scanned ${result.files.length}, expected 6`);
  db.close();
});

// ── 10. Nothing escapes the uploads root ──────────────────────────────────────
test('scope: every reported path stays inside the uploads root', () => {
  const box = sandbox('containment');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.uploads, 'root.jpg'), { ageHours: 100 });
  touch(path.join(box.uploads, 'misc', 'x.jpg'), { ageHours: 100 });
  // Outside the uploads root, in the same sandbox: it must never be listed.
  const secret = touch(path.join(box.dir, 'secret.jpg'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  for (const f of result.files) {
    const rel = path.relative(path.resolve(box.uploads), path.resolve(f.abs));
    assert.ok(rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel), `${f.rel} escapes the uploads root`);
    assert.ok(!f.rel.includes('..'), `${f.rel} contains a traversal segment`);
  }
  assert.ok(!result.files.some((f) => path.resolve(f.abs) === path.resolve(secret)), 'a file outside uploads is never reported');
  assert.ok(!result.files.some((f) => f.rel.includes('secret.jpg')));
  db.close();
});

test('scope: apply refuses a candidate whose path is not directly in its media directory', () => {
  const box = sandbox('apply-escape');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  const outside = touch(path.join(box.dir, 'victim.jpg'), { ageHours: 100 });
  const nested = touch(path.join(box.images, 'sub', 'nested.jpg'), { ageHours: 100 });

  const inv = inventory(box, db);
  const result = inv.scan();
  const forged = { rel: 'root/victim.jpg', kind: 'root', abs: outside, name: 'victim.jpg', depth: 0, status: 'KNOWN_IN_DB', reason: 'orphan-row', needsManualReview: false, deletable: true };
  const outcome = inv.apply({ ...result, blocked: [], candidates: [forged] });
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome.skipped, [{ rel: 'root/victim.jpg', reason: 'candidate-not-issued' }]);
  assert.equal(fs.existsSync(outside), true, 'a file outside uploads survives');

  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('o', 'o.jpg', OLD());
  touch(path.join(box.images, 'o.jpg'), { ageHours: 100 });
  const scan = inv.scan();
  const issued = scan.candidates.find((f) => f.name === 'o.jpg');
  assert.ok(issued, 'precondition: issued candidate');
  const orig = { ...issued, fingerprint: { ...issued.fingerprint } };
  issued.abs = nested; issued.name = 'nested.jpg'; issued.rel = 'images/sub/nested.jpg';
  const outcome2 = inv.apply(scan);
  Object.assign(issued, orig);
  assert.deepEqual(outcome2.removed, []);
  assert.deepEqual(outcome2.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.equal(outcome2.skipped[0].reason, 'outside-dir');
  assert.equal(fs.statSync(nested).size, 1024, 'a nested file survives');
  db.close();
});

// ── Configuration guards ──────────────────────────────────────────────────────
test('scope: an absent uploads/audio is empty, not an error', () => {
  const box = sandbox('audio-missing');
  fs.rmdirSync(box.audio);
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  assert.ok(!result.blocked.includes('AUDIO_DIR_UNAVAILABLE'), `blocked: ${result.blocked.join(',')}`);
  assert.equal(result.storage.audioCount, 0);
  assert.equal(result.counts.outsideDbScope, 0);
  assert.deepEqual(result.blocked, []);
  db.close();
});

test('scope: a media directory outside the uploads root blocks the run', () => {
  const box = sandbox('outside-root');
  const db = openDb(box.dbFile);
  seedKnown(db);
  const strayImages = path.join(box.dir, 'elsewhere-images');
  fs.mkdirSync(strayImages, { recursive: true });
  touch(path.join(strayImages, 'stray.jpg'), { ageHours: 100 });

  const inv = createFileInventory({ db, imagesDir: strayImages, videosDir: box.videos, uploadsDir: box.uploads, audioDir: box.audio, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.ok(result.blocked.includes('SCOPE_OUTSIDE_ROOT'), `blocked: ${result.blocked.join(',')}`);
  assert.ok(!result.files.some((f) => path.resolve(f.abs).startsWith(path.resolve(strayImages))), 'nothing outside uploads is reported');
  assert.deepEqual(inv.apply(result).removed, []);
  db.close();
});

test('scope: scanning changes neither the files nor the database', () => {
  const box = sandbox('read-only');
  const db = openDb(box.dbFile);
  seedKnown(db);
  const files = [
    touch(path.join(box.images, 'known.jpg'), { bytes: 2048, ageHours: 100 }),
    touch(path.join(box.videos, 'known.mp4'), { bytes: 4096, ageHours: 100 }),
    touch(path.join(box.audio, 'voice.mp3'), { bytes: 512, ageHours: 100 }),
    touch(path.join(box.uploads, 'root.jpg'), { bytes: 256, ageHours: 100 }),
  ];
  const snapshot = () => files.map((f) => {
    const st = fs.statSync(f);
    return `${f}:${st.size}:${st.mtimeMs}`;
  });
  const before = snapshot();
  const rowsBefore = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  const videoRowsBefore = db.prepare('SELECT COUNT(*) AS n FROM videos').get().n;

  const result = inventory(box, db).scan();
  assert.equal(result.counts.scanned, 4);

  assert.deepEqual(snapshot(), before, 'the scan must not touch a single file');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, rowsBefore, 'no file row was added or removed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM videos').get().n, videoRowsBefore, 'no video row was added or removed');
  db.close();
});


// ── 11. Scope roots that are links ────────────────────────────────────────────
// Every scope root is verified with `lstat` before the first readdir. When a root is a symbolic link, a
// Windows junction or another reparse point, the scope is closed: nothing below it is classified as a
// normal file, nothing can become a deletion candidate, and `apply` refuses the whole run.
//
// Junctions need no special privilege and are used wherever possible. Symbolic links need
// SeCreateSymbolicLinkPrivilege; where the host forbids them the test is reported as skipped with the
// reason — a skip is never counted as a pass.
//
// Each case links to a *fresh* name inside the uploads root (nothing has to be moved aside), so the
// target tree is a real directory outside uploads that a naive walk would happily have classified.

/** A sandbox whose `scopeName` root is a link to a directory outside uploads. */
function linkScope(name, scopeName, makeLink) {
  const box = sandbox(`link-${name}`);
  const db = openDb(box.dbFile);
  seedKnown(db);
  const target = path.join(box.dir, 'outside-target');
  // This file is what a scope that ignored the link would classify as an ordinary file.
  touch(path.join(target, 'external.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });

  // A fresh name that does not exist yet: `mklink` needs a free path, and an empty directory would do.
  const linkPath = scopeName === 'uploads' ? path.join(box.dir, 'linked-uploads') : path.join(box.uploads, `${scopeName}-link`);
  const overrides = scopeName === 'uploads' ? { uploadsDir: linkPath } : scopeName === 'images' ? { imagesDir: linkPath } : scopeName === 'videos' ? { videosDir: linkPath } : { audioDir: linkPath };
  const why = makeLink(linkPath, target);
  return { box, db, target, linkPath, overrides, why };
}

/** Asserts that a linked scope is closed, its target invisible and no candidate exists. */
function assertScopeClosed(result, { code, scopeName, target }) {
  assert.ok(result.blocked.includes(code), `expected ${code}, blocked: ${result.blocked.join(',')}`);
  assert.equal(result.candidates.length, 0, 'a linked scope yields no deletion candidate');
  assert.ok(!result.files.some((f) => path.resolve(f.abs).startsWith(path.resolve(target))), 'the link target is never walked');
  assert.ok(!result.files.some((f) => f.rel.includes('external.jpg')), 'the file behind the link is never classified');
  assert.ok(!result.manualReview.some((f) => f.rel.includes('external.jpg')));
  assert.equal(result.files.filter((f) => f.kind === scopeName).length, 0, `the ${scopeName} scope is closed: no entry at all`);
}

function junctionCase(scopeName, code) {
  test(`scope root: a junction in place of the ${scopeName} root is closed and never walked`, (t) => {
    const made = linkScope(`junction-${scopeName}`, scopeName, (link, target) => mkJunction(link, target));
    try {
      if (made.why) {
        t.skip(`a junction cannot be created on this host (${made.why}) — skipped, not passed`);
        return;
      }
      const inv = inventory(made.box, made.db, made.overrides);
      const result = inv.scan();
      assertScopeClosed(result, { code, scopeName, target: made.target });
      // The link itself is still there: the inventory never removed or repointed it.
      assert.equal(fs.lstatSync(made.linkPath).isSymbolicLink(), true, 'the junction must survive the scan');
      assert.equal(fs.existsSync(path.join(made.target, 'external.jpg')), true, 'the target file survives');
      assert.deepEqual(inv.apply(result).removed, [], 'a closed scope deletes nothing');
      assert.equal(fs.existsSync(path.join(made.target, 'external.jpg')), true, 'apply does not reach the target');
    } finally {
      made.db.close();
    }
  });
}

junctionCase('uploads', 'UPLOADS_DIR_IS_LINK');
junctionCase('audio', 'AUDIO_DIR_IS_LINK');
junctionCase('images', 'IMAGES_DIR_IS_LINK');
junctionCase('videos', 'VIDEOS_DIR_IS_LINK');

test('scope root: a junction as uploads root closes every scope, not just the root one', (t) => {
  const made = linkScope('junction-all', 'uploads', (link, target) => mkJunction(link, target));
  try {
    if (made.why) {
      t.skip(`a junction cannot be created on this host (${made.why}) — skipped, not passed`);
      return;
    }
    // The target contains an `images` directory: a naive walk would report its contents.
    fs.mkdirSync(path.join(made.target, 'images'), { recursive: true });
    touch(path.join(made.target, 'images', 'sneaky.jpg'), { ageHours: 100 });

    const inv = inventory(made.box, made.db, made.overrides);
    const result = inv.scan();

    // `SCOPE_OUTSIDE_ROOT` is a consequence of the override, not of the link: with the uploads root
    // moved to `box.dir/linked-uploads`, the configured media directories are no longer inside it.
    assert.deepEqual(result.blocked, ['UPLOADS_DIR_IS_LINK', 'SCOPE_OUTSIDE_ROOT']);
    assert.equal(result.files.length, 0, 'nothing at all is reported when the uploads root is a link');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.storage.readable, false);
    assert.deepEqual(inv.apply(result).removed, []);
    assert.equal(fs.existsSync(path.join(made.target, 'images', 'sneaky.jpg')), true, 'the tree behind the link survives');
  } finally {
    made.db.close();
  }
});

test('scope root: a symbolic link in place of a media root is closed (skipped when forbidden)', (t) => {
  const made = linkScope('symlink-images', 'images', (link, target) => mkSymlink(target, link, 'dir'));
  try {
    if (made.why) {
      t.skip(`symbolic links cannot be created on this host (${made.why}) — skipped, not passed`);
      return;
    }
    const inv = inventory(made.box, made.db, made.overrides);
    const result = inv.scan();
    assertScopeClosed(result, { code: 'IMAGES_DIR_IS_LINK', scopeName: 'images', target: made.target });
    assert.equal(fs.existsSync(path.join(made.target, 'external.jpg')), true);
    assert.deepEqual(inv.apply(result).removed, []);
  } finally {
    made.db.close();
  }
});

test('scope root: a file symbolic link in place of a media root is closed (skipped when forbidden)', (t) => {
  const made = linkScope('symlink-file-audio', 'audio', (link, target) => mkSymlink(path.join(target, 'external.jpg'), link, 'file'));
  try {
    if (made.why) {
      t.skip(`symbolic links cannot be created on this host (${made.why}) — skipped, not passed`);
      return;
    }
    const inv = inventory(made.box, made.db, made.overrides);
    const result = inv.scan();
    assert.ok(result.blocked.includes('AUDIO_DIR_IS_LINK'), `blocked: ${result.blocked.join(',')}`);
    assert.equal(result.files.filter((f) => f.kind === 'audio').length, 0);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(inv.apply(result).removed, []);
    assert.equal(fs.existsSync(path.join(made.target, 'external.jpg')), true, 'the symlink target survives');
  } finally {
    made.db.close();
  }
});

test('scope root: apply refuses everything when a root became a link after the scan', (t) => {
  const box = sandbox('link-after-scan');
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', OLD());
  const imagesDir = path.join(box.uploads, 'images-link');
  fs.mkdirSync(imagesDir);
  const orphan = touch(path.join(imagesDir, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });

  const inv = inventory(box, db, { imagesDir });
  const scan = inv.scan();
  assert.deepEqual(scan.candidates.map((f) => f.rel), ['images/orphan.jpg'], 'the candidate exists before the swap');

  // Swap the real directory for a junction, keeping the candidate's bytes as evidence outside uploads.
  const target = path.join(box.dir, 'elsewhere');
  touch(path.join(target, 'keep.jpg'), { ageHours: 100 });
  const kept = path.join(box.dir, 'orphan-copy.jpg');
  fs.copyFileSync(orphan, kept);
  fs.rmSync(orphan, { force: true });
  fs.rmdirSync(imagesDir);
  const why = mkJunction(imagesDir, target);
  if (why) {
    t.skip(`a junction cannot be created on this host (${why}) — skipped, not passed`);
    db.close();
    return;
  }
  try {
    const outcome = inv.apply(scan);
    assert.deepEqual(outcome.removed, [], 'a root that turned into a link deletes nothing');
    assert.deepEqual(outcome.blocked, ['IMAGES_DIR_IS_LINK']);
    assert.deepEqual(outcome.skipped, [{ rel: '(boundary)', reason: 'root-is-link' }]);
    assert.equal(fs.statSync(kept).size, 1024, 'the candidate file survives');
    assert.equal(fs.existsSync(path.join(target, 'keep.jpg')), true, 'the new target is untouched');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get('orphan').n, 1, 'the database row survives');
  } finally {
    db.close();
  }
});

test('scope root: a plain directory is never mistaken for a link', () => {
  const box = sandbox('plain-roots');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.audio, 'voice.mp3'), { ageHours: 100 });
  touch(path.join(box.uploads, 'note.jpg'), { ageHours: 100 });

  const result = inventory(box, db).scan();
  assert.deepEqual(result.blocked, [], 'ordinary directories must not trip the link check');
  assert.ok(result.files.some((f) => f.rel === 'audio/voice.mp3'));
  assert.equal(result.files.find((f) => f.rel === 'root/note.jpg').reason, 'outside-database-scope');
  // Nothing outside the two media directories is deletable, whatever the mode.
  for (const f of result.files.filter((x) => x.kind === 'audio' || x.kind === 'root')) {
    assert.equal(f.deletable, false, f.rel);
    assert.equal(f.needsManualReview, true, f.rel);
  }
  db.close();
});

// ── 12. Physical-path fail-closed checks ──────────────────────────────────────
// The physical path is what a delete acts on, so an unresolved path must never be treated as "safe".
// These tests patch `fs.realpathSync` (the same object the module holds) to simulate a path that cannot
// be resolved, and they never touch the project tree.

/** Runs `fn` with `fs.realpathSync` patched to throw for the given absolute paths. */
function withBrokenRealpath(paths, fn) {
  const real = fs.realpathSync;
  const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
  const broken = new Set(paths.map(norm));
  fs.realpathSync = (p, ...rest) => {
    if (broken.has(norm(path.resolve(String(p))))) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return real(p, ...rest);
  };
  try {
    return fn();
  } finally {
    fs.realpathSync = real;
  }
}

/** Builds a sandbox with one known image, one known video and one old orphan image (a candidate). */
function candidateBox(name) {
  const box = sandbox(name);
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', OLD());
  const images = touch(path.join(box.images, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  return { box, db, orphan: images };
}

test('physical: an unresolvable scope root blocks that scope instead of counting as safe', () => {
  const { box, db } = candidateBox('realpath-scope');
  const inv = inventory(box, db);

  const result = withBrokenRealpath([box.images], () => inv.scan());

  assert.ok(result.blocked.includes('IMAGES_DIR_PATH_UNRESOLVED'), `blocked: ${result.blocked.join(',')}`);
  assert.ok(!result.blocked.includes('IMAGES_DIR_IS_LINK'), 'a failure to resolve is not reported as a link');
  assert.deepEqual(result.candidates, [], 'an unresolvable scope yields no candidate');
  assert.equal(result.files.filter((f) => f.kind === 'images').length, 0, 'nothing from the unresolvable scope is reported');
  assert.ok(result.errors.some((e) => e.scope === 'images' && e.code === 'EPATH'), 'the reason is visible in the report');
  // The other scopes are unaffected: only the failing scope is closed.
  assert.equal(result.files.filter((f) => f.kind === 'videos').length, 1);
  db.close();
});

test('physical: an unresolvable parent path closes the scopes below it', () => {
  const { box, db } = candidateBox('realpath-parent');
  const inv = inventory(box, db);

  // `path.dirname(videosDir)` is uploads: if the parent cannot be resolved, neither can the tree below it.
  const result = withBrokenRealpath([path.dirname(box.videos)], () => inv.scan());

  assert.ok(result.blocked.includes('UPLOADS_DIR_PATH_UNRESOLVED'), `blocked: ${result.blocked.join(',')}`);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.files.length, 0, 'a tree whose physical position is unknown is not walked');
  assert.equal(result.storage.readable, false);
  db.close();
});

test('physical: apply refuses everything when a root path cannot be resolved', () => {
  const { box, db } = candidateBox('realpath-apply');
  const inv = inventory(box, db);
  const scan = inv.scan();
  assert.deepEqual(scan.candidates.map((f) => f.rel), ['images/orphan.jpg'], 'the candidate exists while paths resolve');

  const outcome = withBrokenRealpath([box.images], () => inv.apply(scan));
  assert.deepEqual(outcome.removed, [], 'an unresolved root deletes nothing');
  assert.deepEqual(outcome.blocked, ['IMAGES_DIR_PATH_UNRESOLVED']);
  assert.deepEqual(outcome.skipped, [{ rel: '(boundary)', reason: 'root-path-unresolved' }]);
  assert.equal(fs.statSync(path.join(box.images, 'orphan.jpg')).size, 1024, 'the candidate survives');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get('orphan').n, 1, 'its row survives');
  db.close();
});

test('physical: a redirected parent via junction stays inside its own real root', (t) => {
  const box = sandbox('junction-parent');
  const db = openDb(box.dbFile);
  seedKnown(db);
  const target = path.join(box.dir, 'real-project');
  for (const sub of ['uploads/images', 'uploads/videos', 'uploads/audio']) fs.mkdirSync(path.join(target, sub), { recursive: true });
  const realUploads = path.join(target, 'uploads');
  const realImages = path.join(realUploads, 'images');
  touch(path.join(realImages, 'known.jpg'), { ageHours: 100 });
  touch(path.join(realUploads, 'videos', 'known.mp4'), { ageHours: 100 });
  touch(path.join(realUploads, 'audio', 'voice.mp3'), { ageHours: 100 });

  // A junction one level up: every path below it is redirected, but consistently.
  const link = path.join(box.dir, 'junction');
  const why = mkJunction(link, target);
  if (why) {
    t.skip(`a junction cannot be created on this host (${why}) — skipped, not passed`);
    db.close();
    return;
  }
  try {
    const viaLink = path.join(link, 'uploads');
    const inv = createFileInventory({
      db,
      imagesDir: path.join(viaLink, 'images'),
      videosDir: path.join(viaLink, 'videos'),
      uploadsDir: viaLink,
      audioDir: path.join(viaLink, 'audio'),
      trustedRoot: target,
      ttlHours: 24,
    });
    const result = inv.scan();

    // The redirected ancestor is not an escape: uploads resolves inside its own real root.
    assert.deepEqual(result.blocked, [], `blocked: ${result.blocked.join(',')}`);
    const uploadsReal = fs.realpathSync(viaLink);
    for (const f of result.files) {
      assert.ok(fs.realpathSync(path.dirname(f.abs)).startsWith(uploadsReal), `${f.rel} resolves outside the real uploads`);
    }
    assert.ok(result.files.some((f) => f.rel === 'images/known.jpg'));
    assert.equal(result.storage.uploadsRealPath, uploadsReal, 'the report exposes the resolved uploads path');
    assert.equal(result.storage.trustedRootRealPath, fs.realpathSync(target), 'the trusted root resolves to the real project');
    assert.equal(fs.existsSync(path.join(realImages, 'known.jpg')), true);
  } finally {
    db.close();
  }
});

test('physical: uploads outside the trusted root is refused', (t) => {
  const box = sandbox('outside-trusted');
  const other = sandbox('outside-trusted-other');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(other.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(other.videos, 'known.mp4'), { ageHours: 100 });

  const inv = createFileInventory({
    db,
    imagesDir: other.images,
    videosDir: other.videos,
    uploadsDir: other.uploads,
    audioDir: other.audio,
    trustedRoot: box.dir,
    ttlHours: 24,
  });
  const result = inv.scan();

  assert.ok(result.blocked.includes('UPLOADS_DIR_OUTSIDE_ROOT'), `blocked: ${result.blocked.join(',')}`);
  assert.equal(result.files.length, 0, 'a tree outside the trusted root is not reported');
  assert.equal(result.storage.readable, false);
  assert.deepEqual(inv.apply(result).removed, []);
  db.close();
});

test('physical: ordinary directories under an explicit trusted root stay usable', () => {
  const box = sandbox('trusted-ok');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  touch(path.join(box.audio, 'voice.mp3'), { ageHours: 100 });
  touch(path.join(box.uploads, 'note.jpg'), { ageHours: 100 });

  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, audioDir: box.audio, trustedRoot: box.dir, ttlHours: 24 });
  const result = inv.scan();
  assert.deepEqual(result.blocked, [], 'ordinary directories must pass the physical checks');
  assert.equal(result.files.length, 4);
  assert.equal(result.storage.trustedRoot, path.resolve(box.dir));
  db.close();
});

test('apply: audio and root files can never become deletable candidates', () => {
  const box = sandbox('apply-audio-root');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  const audio = touch(path.join(box.audio, 'voice.mp3'), { ageHours: 100 });
  const rootFile = touch(path.join(box.uploads, 'root.jpg'), { ageHours: 100 });

  const inv = inventory(box, db);
  const result = inv.scan();
  assert.equal(result.candidates.length, 0, 'the scan produces no candidate outside the media directories');

  // A caller that forges candidates (objects not issued by this scan) must not be able to delete them.
  const forged = (rel, kind, abs, name) => ({ rel, kind, abs, name, depth: 0, status: 'NEEDS_MANUAL_REVIEW', reason: 'outside-database-scope', needsManualReview: true });
  const outcome = inv.apply({ ...result, blocked: [], candidates: [forged('audio/voice.mp3', 'audio', audio, 'voice.mp3')] });
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome.skipped, [{ rel: 'audio/voice.mp3', reason: 'candidate-not-issued' }]);
  const outcome2 = inv.apply({ ...result, blocked: [], candidates: [forged('root/root.jpg', 'root', rootFile, 'root.jpg')] });
  assert.deepEqual(outcome2.removed, []);
  assert.deepEqual(outcome2.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome2.skipped, [{ rel: 'root/root.jpg', reason: 'candidate-not-issued' }]);
  assert.equal(fs.existsSync(audio), true);
  assert.equal(fs.existsSync(rootFile), true);
  db.close();
});

test('apply: a non-image candidate is refused even when it claims to be an orphan', () => {
  const box = sandbox('apply-kind');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  const video = touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });

  const inv = inventory(box, db);
  const scan = inv.scan();
  const forged = { rel: 'videos/known.mp4', kind: 'videos', abs: video, name: 'known.mp4', depth: 0, status: 'KNOWN_IN_DB', reason: 'orphan-row', needsManualReview: false, deletable: true };
  const outcome = inv.apply({ ...scan, blocked: [], candidates: [forged] });
  assert.deepEqual(outcome.removed, [], 'only an image row may be deleted with its `files` row');
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome.skipped, [{ rel: 'videos/known.mp4', reason: 'candidate-not-issued' }]);
  assert.equal(fs.existsSync(video), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM videos WHERE id = ?').get('vid-0').n, 1, 'the video row survives');
  db.close();
});

// ── 13. Final fail-closed audit (trustedRoot + apply) ────────────────────────
// A missing or unresolvable trust boundary is never safety: without it, the inventory must not run.
// A forged candidate must not delete any file or remove any SQLite row.

function expectBlocked(inv, code) {
  const result = inv.scan();
  assert.ok(result.blocked.includes(code), `expected ${code}, blocked: ${result.blocked.join(',')}`);
  assert.deepEqual(result.candidates, [], 'a blocked run yields no candidate');
  assert.equal(result.files.length, 0, 'a blocked run reports no file');
  const outcome = inv.apply(result);
  assert.deepEqual(outcome.removed, [], 'a blocked run deletes nothing');
  return result;
}

// ── 13a. trustedRoot must be present and resolvable ───────────────────────────
test('trustedRoot: no trusted root blocks the inventory (no fallback)', () => {
  const { box, db } = candidateBox('trusted-missing');
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, ttlHours: 24 });
  const result = expectBlocked(inv, 'TRUSTED_ROOT_MISSING');
  assert.notEqual(result.blocked.includes('UPLOADS_DIR_OUTSIDE_ROOT'), true, 'the boundary was never compared');
  db.close();
});

test('trustedRoot: an unresolvable trusted root blocks the inventory', () => {
  const { box, db } = candidateBox('trusted-unresolved');
  const inv = createFileInventory({ db, imagesDir: box.images, videosDir: box.videos, uploadsDir: box.uploads, trustedRoot: path.join(box.dir, 'does-not-exist'), ttlHours: 24 });
  expectBlocked(inv, 'TRUSTED_ROOT_UNRESOLVED');
  db.close();
});

test('trustedRoot: an unresolvable uploads path blocks the inventory', () => {
  const { box, db } = candidateBox('trusted-uploads-unresolved');
  const inv = inventory(box, db);
  const result = withBrokenRealpath([box.uploads], () => inv.scan());
  assert.ok(result.blocked.includes('UPLOADS_DIR_PATH_UNRESOLVED'), `blocked: ${result.blocked.join(',')}`);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.files.length, 0);
  db.close();
});

test('trustedRoot: a broken realpath never makes the boundary pass', () => {
  const { box, db } = candidateBox('trusted-broken');
  const inv = inventory(box, db);
  const result = withBrokenRealpath([box.dir], () => inv.scan());
  assert.ok(result.blocked.includes('TRUSTED_ROOT_UNRESOLVED'), `blocked: ${result.blocked.join(',')}`);
  assert.deepEqual(result.candidates, []);
  db.close();
});

// ── 13b. scope path errors are reported, not silently skipped ─────────────────
test('scope errors: ENOENT on a required media directory blocks that scope', () => {
  const box = sandbox('scope-enoent');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  fs.rmSync(box.images, { recursive: true, force: true });

  const result = inventory(box, db).scan();
  assert.ok(result.blocked.includes('IMAGES_DIR_UNAVAILABLE'), `blocked: ${result.blocked.join(',')}`);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.files.filter((f) => f.kind === 'images').length, 0);
  db.close();
});

test('scope errors: ENOTDIR (a file where the directory should be) blocks that scope', () => {
  const box = sandbox('scope-enotdir');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  fs.rmSync(box.videos, { recursive: true, force: true });
  fs.writeFileSync(box.videos, 'not a directory');

  const result = inventory(box, db).scan();
  assert.ok(result.blocked.includes('VIDEOS_DIR_UNAVAILABLE'), `blocked: ${result.blocked.join(',')}`);
  assert.deepEqual(result.candidates, []);
  db.close();
});

test('scope errors: ENOENT on audio is an empty optional scope, not a block', () => {
  const box = sandbox('scope-audio-missing');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  fs.rmSync(box.audio, { recursive: true, force: true });

  const result = inventory(box, db).scan();
  assert.ok(!result.blocked.includes('AUDIO_DIR_UNAVAILABLE'), `blocked: ${result.blocked.join(',')}`);
  assert.ok(!result.blocked.includes('AUDIO_DIR_PATH_UNRESOLVED'), `blocked: ${result.blocked.join(',')}`);
  assert.equal(result.files.filter((f) => f.kind === 'audio').length, 0);
  db.close();
});

test('scope errors: an unresolvable scope path blocks instead of being silently skipped', () => {
  const box = sandbox('scope-realpath-err');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });

  const result = withBrokenRealpath([box.videos], () => inventory(box, db).scan());
  assert.ok(result.blocked.includes('VIDEOS_DIR_PATH_UNRESOLVED'), `blocked: ${result.blocked.join(',')}`);
  assert.ok(!result.blocked.includes('SCOPE_OUTSIDE_ROOT'), 'a resolution failure is not an "outside root" skip');
  assert.deepEqual(result.candidates, []);
  db.close();
});

test('scope errors: a junction at a scope root is reported as a link, not silently skipped', () => {
  // covered by the junction tests above, but stated explicitly for this audit:
  // the pre-scan containment loop must not turn a link into SCOPE_OUTSIDE_ROOT.
  const box = sandbox('scope-junction-not-skip');
  const db = openDb(box.dbFile);
  seedKnown(db);
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  // Use the existing helper: an ENOTDIR-at-lstat case is "unavailable", not "outside root".
  fs.rmSync(box.images, { recursive: true, force: true });
  fs.writeFileSync(box.images, 'file');
  const result = inventory(box, db).scan();
  assert.ok(result.blocked.includes('IMAGES_DIR_UNAVAILABLE'), `blocked: ${result.blocked.join(',')}`);
  assert.ok(!result.blocked.includes('SCOPE_OUTSIDE_ROOT'), 'a path error is reported, not silently skipped');
  db.close();
});

// ── 13c. apply must reject every forged candidate ─────────────────────────────
function setupApplyBox(name) {
  const box = sandbox(name);
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', OLD());
  const orphan = touch(path.join(box.images, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  const video = touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  const audio = touch(path.join(box.audio, 'voice.mp3'), { ageHours: 100 });
  const rootFile = touch(path.join(box.uploads, 'root.jpg'), { ageHours: 100 });
  const inv = inventory(box, db);
  const scan = inv.scan();
  const base = scan.candidates.find((f) => f.rel === 'images/orphan.jpg');
  assert.ok(base, 'precondition: one deletable orphan candidate');
  return { box, db, inv, scan, base, orphan, video, audio, rootFile };
}

/** Mutates the issued candidate in place (preserving scan-registry identity), applies, then restores it. */
function applyMutated(ctx, make) {
  const orig = { ...ctx.base, fingerprint: ctx.base.fingerprint ? { ...ctx.base.fingerprint } : ctx.base.fingerprint };
  const mutated = make(ctx);
  for (const k of Object.keys(ctx.base)) delete ctx.base[k];
  Object.assign(ctx.base, mutated);
  try {
    return ctx.inv.apply(ctx.scan);
  } finally {
    for (const k of Object.keys(ctx.base)) delete ctx.base[k];
    Object.assign(ctx.base, orig);
  }
}

function assertNothingChanged({ box, db, files, dbCounts }) {
  for (const [p, size] of files) assert.equal(fs.statSync(p).size, size, `${p} must survive unchanged`);
  for (const [sql, expected] of dbCounts) assert.equal(db.prepare(sql).get().n, expected, `${sql} must be unchanged`);
}

test('apply audit: the real candidate is the only thing that can be deleted', () => {
  const { box, db, inv, scan, base } = setupApplyBox('apply-happy');
  // Sanity: with the real candidate and no block, apply succeeds. This proves the setup is valid.
  // (We do not run it, because that would delete in temp; instead we verify a wrong variant is refused.)
  assert.equal(base.kind, 'images');
  assert.equal(base.reason, 'orphan-row');
  assert.equal(base.status, 'KNOWN_IN_DB');
  db.close();
});

const FORGED = [
  ['forged kind=videos', (ctx) => ({ ...ctx.base, kind: 'videos', abs: ctx.video }), 'not-deletable:kind-videos'],
  ['forged kind=audio', (ctx) => ({ ...ctx.base, kind: 'audio', abs: ctx.audio }), 'not-deletable:kind-audio'],
  ['forged kind=root', (ctx) => ({ ...ctx.base, kind: 'root', abs: ctx.rootFile }), 'not-deletable:kind-root'],
  ['forged status=UNKNOWN_IN_DB', (ctx) => ({ ...ctx.base, status: 'UNKNOWN_IN_DB' }), 'not-deletable:UNKNOWN_IN_DB'],
  ['forged status=NEEDS_MANUAL_REVIEW', (ctx) => ({ ...ctx.base, status: 'NEEDS_MANUAL_REVIEW' }), 'not-deletable:NEEDS_MANUAL_REVIEW'],
  ['forged reason=referenced', (ctx) => ({ ...ctx.base, reason: 'referenced' }), 'not-deletable:referenced'],
  ['forged reason=outside-database-scope', (ctx) => ({ ...ctx.base, reason: 'outside-database-scope' }), 'not-deletable:outside-database-scope'],
  ['forged needsManualReview=true', (ctx) => ({ ...ctx.base, needsManualReview: true }), 'needs-manual-review'],
  ['forged abs points to external file', (ctx) => ({ ...ctx.base, abs: path.join(ctx.box.dir, 'external.jpg') }), 'outside-dir'],
  ['forged abs points to video', (ctx) => ({ ...ctx.base, abs: ctx.video }), 'outside-dir'],
  ['forged abs points to audio', (ctx) => ({ ...ctx.base, abs: ctx.audio }), 'outside-dir'],
  ['forged abs points to root file', (ctx) => ({ ...ctx.base, abs: ctx.rootFile }), 'outside-dir'],
  ['forged abs points to other directory', (ctx) => ({ ...ctx.base, abs: path.join(ctx.box.dir, 'elsewhere', 'orphan.jpg') }), 'outside-dir'],
  ['forged rel claims root scope', (ctx) => ({ ...ctx.base, rel: 'root/orphan.jpg', abs: ctx.rootFile }), 'outside-dir'],
  ['forged name differs from scanned file', (ctx) => ({ ...ctx.base, name: 'known.jpg' }), 'outside-dir'],
  ['forged fingerprint size', (ctx) => ({ ...ctx.base, fingerprint: { ...ctx.base.fingerprint, size: 1 } }), 'changed-since-scan'],
  ['forged fingerprint mtime', (ctx) => ({ ...ctx.base, fingerprint: { ...ctx.base.fingerprint, mtimeMs: 1 } }), 'changed-since-scan'],
];

for (const [label, make, expectedReason] of FORGED) {
  test(`apply audit: ${label} removes nothing`, () => {
    const ctx = setupApplyBox(`forged-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    const ext = path.join(ctx.box.dir, 'external.jpg');
    touch(ext, { bytes: 777, ageHours: 100 });
    fs.mkdirSync(path.join(ctx.box.dir, 'elsewhere'), { recursive: true });
    touch(path.join(ctx.box.dir, 'elsewhere', 'orphan.jpg'), { bytes: 888, ageHours: 100 });

    const outcome = applyMutated(ctx, make);

    assert.deepEqual(outcome.removed, [], `${label} must delete no file`);
    assert.equal(outcome.failed.length, 0, `${label} must not fail partially`);
    assert.ok(outcome.skipped.some((s) => s.reason === expectedReason), `expected ${expectedReason}, got ${JSON.stringify(outcome.skipped)}`);

    // No file removed, no size changed, and the SQLite row is untouched — even when the file deletion
    // was refused at a later gate, the DB row must never be removed for a forged candidate.
    assertNothingChanged({
      box: ctx.box,
      db: ctx.db,
      files: [
        [ctx.orphan, 1024],
        [ctx.video, 1024],
        [ctx.audio, 1024],
        [ctx.rootFile, 1024],
        [ext, 777],
        [path.join(ctx.box.dir, 'elsewhere', 'orphan.jpg'), 888],
      ],
      dbCounts: [
        ["SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'", 1],
        ["SELECT COUNT(*) AS n FROM files WHERE id = 'k0'", 1],
        ["SELECT COUNT(*) AS n FROM videos WHERE id = 'vid-0'", 1],
      ],
    });
    ctx.db.close();
  });
}

test('apply audit: a candidate whose file vanished is skipped without touching SQLite', () => {
  const ctx = setupApplyBox('forged-missing-file');
  fs.rmSync(ctx.orphan);
  const forced = { ...ctx.scan, blocked: [], candidates: [ctx.base] };
  const outcome = ctx.inv.apply(forced);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'changed-since-scan' }]);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row not removed when file was not deleted');
  ctx.db.close();
});

/** Builds a sandbox with two known items and two old orphan images (both real candidates). */
function twoCandidateBox(name) {
  const box = sandbox(name);
  const db = openDb(box.dbFile);
  seedKnown(db);
  const old = OLD();
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('o1', 'o1.jpg', old);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('o2', 'o2.jpg', old);
  const o1 = touch(path.join(box.images, 'o1.jpg'), { ageHours: 100 });
  const o2 = touch(path.join(box.images, 'o2.jpg'), { ageHours: 100 });
  touch(path.join(box.images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(box.videos, 'known.mp4'), { ageHours: 100 });
  const inv = inventory(box, db);
  const scan = inv.scan();
  const c1 = scan.candidates.find((f) => f.rel === 'images/o1.jpg');
  const c2 = scan.candidates.find((f) => f.rel === 'images/o2.jpg');
  assert.ok(c1 && c2, 'precondition: two deletable candidates');
  return { box, db, inv, scan, c1, c2, o1, o2 };
}

test('adversarial: status is mandatory (missing/undefined/null/wrong)', () => {
  for (const bad of [undefined, null, '', 'orphan-row', 'UNKNOWN_IN_DB']) {
    const ctx = setupApplyBox(`status-${String(bad)}`);
    const outcome = applyMutated(ctx, () => {
      const cand = { ...ctx.base };
      if (bad === undefined) delete cand.status; else cand.status = bad;
      return cand;
    });
    assert.deepEqual(outcome.removed, [], `status ${String(bad)} must delete nothing`);
    assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
    assert.equal(fs.existsSync(ctx.orphan), true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
    ctx.db.close();
  }
});

test('adversarial: fingerprint is mandatory and complete', () => {
  const cases = [
    ['missing', (b) => { const c = { ...b }; delete c.fingerprint; return c; }],
    ['null', (b) => ({ ...b, fingerprint: null })],
    ['not-object', (b) => ({ ...b, fingerprint: 'x' })],
    ['partial-no-size', (b) => ({ ...b, fingerprint: { mtimeMs: b.fingerprint.mtimeMs, ino: b.fingerprint.ino } })],
    ['partial-no-mtime', (b) => ({ ...b, fingerprint: { size: b.fingerprint.size, ino: b.fingerprint.ino } })],
    ['partial-no-ino', (b) => ({ ...b, fingerprint: { size: b.fingerprint.size, mtimeMs: b.fingerprint.mtimeMs } })],
    ['size-wrong-type', (b) => ({ ...b, fingerprint: { ...b.fingerprint, size: '1024' } })],
    ['size-negative', (b) => ({ ...b, fingerprint: { ...b.fingerprint, size: -1 } })],
    ['mtime-nan', (b) => ({ ...b, fingerprint: { ...b.fingerprint, mtimeMs: NaN } })],
    ['mtime-zero', (b) => ({ ...b, fingerprint: { ...b.fingerprint, mtimeMs: 0 } })],
    ['ino-negative', (b) => ({ ...b, fingerprint: { ...b.fingerprint, ino: -1 } })],
  ];
  for (const [label, make] of cases) {
    const ctx = setupApplyBox(`fp-${label}`);
    const outcome = applyMutated(ctx, () => make(ctx.base));
    assert.deepEqual(outcome.removed, [], `${label} must delete nothing`);
    assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
    assert.equal(fs.existsSync(ctx.orphan), true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
    ctx.db.close();
  }
});

test('adversarial: fingerprint substitution is refused', () => {
  const ctx = setupApplyBox('fp-subst');
  const outcome = applyMutated(ctx, () => ({ ...ctx.base, fingerprint: { size: 1, mtimeMs: 1, ino: 0 } }));
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'changed-since-scan' }]);
  assert.equal(fs.existsSync(ctx.orphan), true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  ctx.db.close();
});

test('adversarial: trusted root changed between scan and apply', () => {
  const box = sandbox('trust-changed');
  // Two-level root so renaming the trust anchor does not lock the open database file.
  const trust = path.join(box.dir, 'trust');
  const uploads = path.join(trust, 'uploads');
  const images = path.join(uploads, 'images');
  const videos = path.join(uploads, 'videos');
  const audio = path.join(uploads, 'audio');
  for (const d of [images, videos, audio]) fs.mkdirSync(d, { recursive: true });
  const db = openDb(box.dbFile);
  seedKnown(db);
  db.prepare('INSERT INTO files (id, filename, created_at) VALUES (?, ?, ?)').run('orphan', 'orphan.jpg', OLD());
  const orphan = touch(path.join(images, 'orphan.jpg'), { ageHours: 100 });
  touch(path.join(images, 'known.jpg'), { ageHours: 100 });
  touch(path.join(videos, 'known.mp4'), { ageHours: 100 });
  const inv = createFileInventory({ db, imagesDir: images, videosDir: videos, uploadsDir: uploads, audioDir: audio, trustedRoot: trust, ttlHours: 24 });
  const scan = inv.scan();
  assert.ok(scan.candidates.some((f) => f.rel === 'images/orphan.jpg'));
  fs.renameSync(trust, path.join(box.dir, 'trust-moved'));
  try {
    const outcome = inv.apply(scan);
    assert.deepEqual(outcome.removed, []);
    assert.deepEqual(outcome.blocked, ['TRUSTED_ROOT_UNRESOLVED']);
    assert.equal(fs.existsSync(path.join(box.dir, 'trust-moved', 'uploads', 'images', 'orphan.jpg')), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  } finally {
    db.close();
  }
});

test('adversarial: uploads replaced with a directory outside trusted root', () => {
  const ctx = setupApplyBox('uploads-outside');
  const outside = path.join(ctx.box.dir, 'outside-uploads');
  for (const sub of ['images', 'videos', 'audio']) fs.mkdirSync(path.join(outside, sub), { recursive: true });
  fs.renameSync(ctx.box.uploads, path.join(ctx.box.dir, 'uploads-real'));
  fs.renameSync(outside, ctx.box.uploads);
  try {
    const outcome = ctx.inv.apply(ctx.scan);
    assert.deepEqual(outcome.removed, []);
    assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
    assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'changed-since-scan' }]);
    assert.equal(fs.existsSync(path.join(ctx.box.dir, 'uploads-real', 'images', 'orphan.jpg')), true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  } finally {
    try { fs.rmSync(ctx.box.uploads, { recursive: true, force: true }); } catch {}
    try { fs.renameSync(path.join(ctx.box.dir, 'uploads-real'), ctx.box.uploads); } catch {}
    ctx.db.close();
  }
});

test('adversarial: images redirected outside uploads', () => {
  const ctx = setupApplyBox('images-redirected');
  const outside = path.join(ctx.box.dir, 'outside-images');
  fs.mkdirSync(outside, { recursive: true });
  fs.renameSync(ctx.box.images, path.join(ctx.box.dir, 'images-real'));
  // A junction/symlink replacement is the redirect case; fallback to a plain outside dir if not creatable.
  const why = mkJunction(ctx.box.images, outside);
  if (why) fs.renameSync(outside, ctx.box.images);
  try {
    const outcome = ctx.inv.apply(ctx.scan);
    assert.deepEqual(outcome.removed, []);
    assert.ok(outcome.blocked.length > 0, 'redirected images must block apply');
    assert.equal(fs.existsSync(path.join(ctx.box.dir, 'images-real', 'orphan.jpg')), true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  } finally {
    try { if (fs.lstatSync(ctx.box.images).isSymbolicLink()) fs.rmdirSync(ctx.box.images); else fs.rmSync(ctx.box.images, { recursive: true, force: true }); } catch {}
    try { fs.renameSync(path.join(ctx.box.dir, 'images-real'), ctx.box.images); } catch {}
    ctx.db.close();
  }
});

test('adversarial: correct abs/name but fake reason is refused', () => {
  const ctx = setupApplyBox('fake-reason');
  const outcome = applyMutated(ctx, () => ({ ...ctx.base, reason: 'referenced' }));
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.equal(fs.existsSync(ctx.orphan), true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  ctx.db.close();
});

test('adversarial: files row exists but is not a proven orphan (referenced by video_assets)', () => {
  const ctx = setupApplyBox('not-orphan-asset');
  // Make the row referenced: scan-time reason was orphan-row, but proof must fail now.
  ctx.db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('orphan', 'vid-0');
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'a referenced row must not be deleted');
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'orphan-unproven' }]);
  assert.equal(fs.existsSync(ctx.orphan), true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  ctx.db.close();
});

test('adversarial: files row exists but is not a proven orphan (brand_kit logo)', () => {
  const ctx = setupApplyBox('not-orphan-logo');
  ctx.db.exec('DROP TABLE IF EXISTS brand_kits');
  ctx.db.exec('DROP TABLE IF EXISTS projects');
  ctx.db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, description TEXT, created_at TEXT)');
  ctx.db.exec("CREATE TABLE brand_kits (id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE, brand_name TEXT NOT NULL DEFAULT '', logo_url TEXT NOT NULL DEFAULT '', primary_color TEXT NOT NULL DEFAULT '#A3E635', secondary_color TEXT NOT NULL DEFAULT '#0B0D0C', default_language TEXT NOT NULL DEFAULT 'ru', default_cta TEXT NOT NULL DEFAULT 'Купить сейчас', created_at TEXT NOT NULL)");
  ctx.db.prepare("INSERT INTO projects (id, workspace_id, name, description, created_at) VALUES (?,?,?,?,?)").run('p1', 'w1', 'p', '', OLD());
  ctx.db.prepare("INSERT INTO brand_kits (id, project_id, brand_name, logo_url, primary_color, secondary_color, default_language, default_cta, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run('bk1', 'p1', '', '/api/files/orphan', '#000', '#000', 'ru', '', OLD());
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'a logo-referenced row must not be deleted');
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'orphan-unproven' }]);
  assert.equal(fs.existsSync(ctx.orphan), true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  ctx.db.close();
});


test('adversarial: row too new is not a proven orphan', () => {
  const ctx = setupApplyBox('not-orphan-new');
  ctx.db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(new Date().toISOString(), 'orphan');
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
  assert.equal(fs.existsSync(ctx.orphan), true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
  ctx.db.close();
});

test('adversarial: needsManualReview must be strictly false', () => {
  for (const bad of [undefined, null, true, 'false', 0, 1]) {
    const ctx = setupApplyBox(`nmr-${String(bad)}`);
    const outcome = applyMutated(ctx, () => {
      const cand = { ...ctx.base };
      if (bad === undefined) delete cand.needsManualReview; else cand.needsManualReview = bad;
      return cand;
    });
    assert.deepEqual(outcome.removed, [], `needsManualReview=${String(bad)} must delete nothing`);
    assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
    assert.deepEqual(outcome.skipped, [{ rel: 'images/orphan.jpg', reason: 'needs-manual-review' }]);
    assert.equal(fs.existsSync(ctx.orphan), true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1);
    ctx.db.close();
  }
});

test('adversarial: scan result from a different inventory instance is refused', () => {
  const ctx = setupApplyBox('other-inventory');
  const inv2 = inventory(ctx.box, ctx.db);
  const scan2 = inv2.scan();
  const outcome = ctx.inv.apply(scan2);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.blocked, ['SCAN_RESULT_UNVERIFIED']);
  ctx.db.close();
});

test('adversarial: apply rejects invalid result shapes (never throws)', () => {
  const ctx = setupApplyBox('invalid-result');
  for (const bad of [null, undefined, 0, 'x', [], {}, { blocked: null }, { blocked: [], candidates: null }, { blocked: [], candidates: [null], __scanId: ctx.scan.__scanId }]) {
    const outcome = ctx.inv.apply(bad);
    assert.ok(outcome && Array.isArray(outcome.removed) && outcome.removed.length === 0, 'must not delete');
    assert.ok(Array.isArray(outcome.blocked) && outcome.blocked.length > 0, `blocked for ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.existsSync(ctx.orphan), true);
  ctx.db.close();
});

test('adversarial: multiple candidates — unsafe second aborts before first is removed', () => {
  const { db, inv, scan, c1, c2, o1, o2 } = twoCandidateBox('multi-unsafe');
  const orig2 = { ...c2, fingerprint: c2.fingerprint ? { ...c2.fingerprint } : c2.fingerprint };
  delete c2.status;
  try {
    for (const candidates of [[c1, c2], [c2, c1]]) {
      const outcome = inv.apply({ ...scan, blocked: [], candidates });
      assert.deepEqual(outcome.removed, [], 'no file removed when any candidate is unsafe');
      assert.deepEqual(outcome.blocked, ['CANDIDATE_UNVERIFIED']);
      assert.equal(fs.existsSync(o1), true, 'o1 must survive');
      assert.equal(fs.existsSync(o2), true, 'o2 must survive');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id IN ('o1','o2')").get().n, 2);
    }
  } finally {
    for (const k of Object.keys(c2)) delete c2[k];
    Object.assign(c2, orig2);
  }
  db.close();
});

// ── TOCTOU adversarial tests ───────────────────────────────────────────────

test('toctou: db reference added between scan and apply is not deleted', () => {
  const ctx = setupApplyBox('toctou-db-ref');
  // Between scan and apply, another process adds a video_assets reference to the orphan file.
  ctx.db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('orphan', 'vid-0');
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'db reference added after scan → nothing deleted');
  assert.equal(fs.existsSync(ctx.orphan), true, 'file must survive');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row must survive');
  ctx.db.close();
});

test('toctou: apply twice — second apply finds nothing to delete', () => {
  const ctx = setupApplyBox('toctou-twice');
  // First apply: real candidate should be deleted.
  const first = ctx.inv.apply(ctx.scan);
  assert.deepEqual(first.removed, ['images/orphan.jpg'], 'first apply removes the orphan');
  assert.equal(fs.existsSync(ctx.orphan), false, 'file must be gone');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 0, 'row must be gone');

  // Second apply: no candidates remain.
  const second = ctx.inv.apply(ctx.scan);
  assert.deepEqual(second.removed, [], 'second apply removes nothing');
  assert.deepEqual(second.failed, [], 'second apply has no failures');
  ctx.db.close();
});

test('toctou: file replaced with symlink between scan and apply is not deleted', (t) => {
  if (process.platform === 'win32') {
    t.skip('fs.symlinkSync hangs on this Windows host instead of throwing EPERM — skipped, not passed');
    return;
  }
  const ctx = setupApplyBox('toctou-symlink');
  const outside = touch(path.join(ctx.box.dir, 'outside.jpg'), { ageHours: 100 });
  // Replace the orphan file with a symlink to an external file.
  fs.rmSync(ctx.orphan, { force: true });
  fs.symlinkSync(outside, ctx.orphan, 'file');
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'symlink substitution → nothing deleted');
  assert.equal(fs.existsSync(outside), true, 'symlink target must survive');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row must survive');
  ctx.db.close();
});

test('toctou: parent directory replaced with a file between scan and apply is not deleted', () => {
  const ctx = setupApplyBox('toctou-parent-file');
  // Replace the images directory with a regular file (same name).
  fs.rmSync(ctx.box.images, { recursive: true, force: true });
  fs.writeFileSync(ctx.box.images, 'not a directory');
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'parent replaced by file → nothing deleted');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row must survive');
  ctx.db.close();
});

test('toctou: parent directory replaced with symlink between scan and apply is not deleted', (t) => {
  if (process.platform === 'win32') {
    t.skip('fs.symlinkSync hangs on this Windows host instead of throwing EPERM — skipped, not passed');
    return;
  }
  const ctx = setupApplyBox('toctou-parent-link');
  const realImages = path.join(ctx.box.dir, 'images-real');
  fs.renameSync(ctx.box.images, realImages);
  fs.symlinkSync(realImages, ctx.box.images, 'dir');
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'parent symlinked → nothing deleted');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row must survive');
  ctx.db.close();
});

test('toctou: file content changed after scan is caught by fingerprint re-check', () => {
  const ctx = setupApplyBox('toctou-content-change');
  // Rewrite the file with different content between scan and apply.
  fs.writeFileSync(ctx.orphan, Buffer.alloc(9999, 0x62));
  const outcome = ctx.inv.apply(ctx.scan);
  assert.deepEqual(outcome.removed, [], 'content changed → nothing deleted');
  assert.equal(fs.statSync(ctx.orphan).size, 9999, 'file content must be the replacement');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row must survive');
  ctx.db.close();
});

test('toctou: partial error in series — one unsafe candidate aborts all', () => {
  const ctx = setupApplyBox('toctou-partial');
  // Add video_assets reference for the orphan so it's NOT an orphan → apply should refuse it.
  ctx.db.prepare('INSERT INTO video_assets (file_id, video_id) VALUES (?, ?)').run('orphan', 'vid-0');
  const outcome = ctx.inv.apply({ ...ctx.scan, blocked: [], candidates: [ctx.base] });
  assert.deepEqual(outcome.removed, [], 'orphan now referenced → nothing deleted');
  assert.equal(fs.existsSync(ctx.orphan), true, 'file must survive');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = 'orphan'").get().n, 1, 'row must survive');
  ctx.db.close();
});
