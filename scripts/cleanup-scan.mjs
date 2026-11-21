#!/usr/bin/env node
// Read-only inventory of the media directories: what is on disk, what the database knows, and which
// files a cleanup *would* consider. It never deletes, never moves and never writes to the database —
// the database handle is opened read-only, so even a schema migration cannot happen from here.
//
// Usage: node scripts/cleanup-scan.mjs [--json] [--out=path]
import fs from 'fs';
import path from 'path';
import { isolationConfig } from '../server/isolation-bootstrap.js';
import { DatabaseSync } from 'node:sqlite';
import { readCleanupPolicy, describePolicy, CATEGORY_ENV } from '../server/cleanup-policy.js';
import { createFileInventory } from '../server/file-inventory.js';

const ROOT = isolationConfig.projectRoot;
const { databaseFile: DB_FILE, uploadsDir: UPLOADS_DIR, imagesDir: IMAGES_DIR, videosDir: VIDEOS_DIR, audioDir: AUDIO_DIR } = isolationConfig.paths;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const outArg = args.find((a) => a.startsWith('--out='));
const outFile = outArg
  ? isolationConfig.resolvePath(outArg.slice('--out='.length), {
      base: isolationConfig.isIsolated ? isolationConfig.testRoot : ROOT,
      name: 'cleanup report output',
    })
  : null;

const policy = readCleanupPolicy(process.env);

const describeDbProblem = (err) => {
  if (err?.code) return err.code;
  const message = String(err?.message || '');
  if (message.includes('ENOENT')) return 'ENOENT';
  if (message.includes('readonly') || message.includes('SQLITE_READONLY')) return 'SQLITE_READONLY';
  return 'ESQLITE';
};

// A read-only handle: it cannot create the file, and it cannot change a single row.
let db = null;
let dbError = null;
try {
  isolationConfig.assertPath(DB_FILE);
  db = new DatabaseSync(DB_FILE, { readOnly: true });
} catch (err) {
  dbError = describeDbProblem(err);
}

const inventory = createFileInventory({
  db,
  imagesDir: IMAGES_DIR,
  videosDir: VIDEOS_DIR,
  uploadsDir: UPLOADS_DIR,
  audioDir: AUDIO_DIR,
  trustedRoot: ROOT,
  ttlHours: Number(process.env.ORPHAN_FILE_TTL_HOURS) || 24,
});

// `probeDatabase` needs a live handle; a missing database is reported as unavailable, not as "no files".
const result = db ? inventory.scan() : {
  checkedAt: new Date().toISOString(),
  ttlHours: Number(process.env.ORPHAN_FILE_TTL_HOURS) || 24,
  storage: { uploadsDir: UPLOADS_DIR, imagesDir: IMAGES_DIR, videosDir: VIDEOS_DIR, audioDir: AUDIO_DIR, trustedRoot: ROOT, uploadsRealPath: null, trustedRootRealPath: null, readable: true, imageCount: 0, videoCount: 0, audioCount: 0, rootCount: 0 },
  database: { available: false, files: 0, videos: 0, orphanRows: 0, errors: [{ query: 'open', code: dbError, message: 'database could not be opened read-only' }] },
  files: [],
  candidates: [],
  manualReview: [],
  missing: [],
  blocked: ['DB_UNAVAILABLE'],
  counts: { scanned: 0, deletable: 0, knownInDb: 0, unknownInDb: 0, needsManualReview: 0, pathInvalid: 0, tooNew: 0, referenced: 0, orphanRows: 0, nested: 0, outsideDbScope: 0, missingOnDisk: 0, errors: 1 },
  errors: [{ scope: 'database', code: dbError, message: 'database could not be opened read-only' }],
};

// Paths are relative to the storage root: the report must not carry absolute paths around.
const report = inventory.toReport(result);
report.cleanupMode = { global: policy.globalEnabled, orphan: policy.orphan.mode, uploadTemp: policy.uploadTemp.mode, backups: policy.backups.mode, missingLinks: policy.missingLinks.mode, generationTemp: policy.generationTemp.mode };
report.wouldDelete = result.candidates.map((f) => ({ rel: f.rel, size: f.size, mtime: f.mtime, reason: f.reason }));

if (db) {
  try {
    db.close();
  } catch {
    /* nothing left to do */
  }
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/') || '.';
  console.log(`inventory of ${rel(UPLOADS_DIR)} (ttl ${report.ttlHours}h)`);
  console.log(`database ${rel(DB_FILE)}: ${result.database.available ? `ok — ${result.database.files} file row(s), ${result.database.videos} video row(s)` : `UNAVAILABLE (${dbError})`}`);
  console.log(`files scanned: ${result.counts.scanned} (${result.storage.imageCount} images, ${result.storage.videoCount} videos, ${result.storage.audioCount} audio, ${result.storage.rootCount} in the uploads root)`);
  console.log(`  known in db:          ${result.counts.knownInDb}`);
  console.log(`  unknown in db:        ${result.counts.unknownInDb}   (never deleted automatically)`);
  console.log(`  outside db scope:     ${result.counts.outsideDbScope}   (audio and uploads root: manual review only)`);
  console.log(`  nested below root:    ${result.counts.nested}   (manual review only)`);
  console.log(`  needs manual review:  ${result.counts.needsManualReview}`);
  console.log(`  path invalid:         ${result.counts.pathInvalid}`);
  console.log(`  too new to touch:     ${result.counts.tooNew}`);
  console.log(`  referenced:           ${result.counts.referenced}`);
  console.log(`  orphan rows:          ${result.counts.orphanRows}   (only these are candidates)`);
  console.log(`  missing on disk:      ${result.counts.missingOnDisk}`);
  console.log(`  errors:               ${result.counts.errors}`);
  console.log(`blocked: ${report.blocked.length ? report.blocked.join(', ') : 'none'}`);
  console.log(`cleanup policy: ${describePolicy(policy)}`);
  for (const [key, envName] of Object.entries(CATEGORY_ENV)) {
    if (policy[key].mode === 'apply') console.log(`  ${key}: APPLY is configured via ${envName}`);
  }
  if (report.wouldDelete.length) {
    console.log('candidates (would be deleted only with an explicit apply mode):');
    for (const f of report.wouldDelete) console.log(`  ${f.rel}  ${(f.size / 1024 / 1024).toFixed(2)} MB  ${f.mtime}  ${f.reason}`);
  } else {
    console.log('candidates: none');
  }
  if (report.manualReview.length) {
    console.log(`needs manual review (${report.manualReview.length}) — these are never deleted automatically:`);
    for (const f of report.manualReview.slice(0, 20)) console.log(`  ${f.rel}  ${f.status}  ${f.reason}`);
    if (report.manualReview.length > 20) console.log(`  ... and ${report.manualReview.length - 20} more`);
  }
  if (report.missing.length) {
    console.log(`missing on disk (${report.missing.length}) — reported only, no row was changed:`);
    for (const f of report.missing.slice(0, 20)) console.log(`  ${f.rel}`);
    if (report.missing.length > 20) console.log(`  ... and ${report.missing.length - 20} more`);
  }
}
if (outFile) console.log(`report written to ${path.relative(ROOT, outFile) || outFile}`);