import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimExclusiveOutput,
  publishTargetCandidates,
  publishRenderedVideo,
  jobPaths,
  cleanupFailedRender,
  removeRunWorkDir,
} from '../server/generation.js';
import { readCleanupPolicy } from '../server/cleanup-policy.js';

const roots = [];
function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bevhub-b02-${name}-`));
  roots.push(dir);
  const uploads = path.join(dir, 'uploads');
  const videos = path.join(uploads, 'videos');
  const tmp = path.join(uploads, 'tmp');
  fs.mkdirSync(videos, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  return { dir, uploads, videos, tmp };
}
function touch(file, bytes = 32) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return file;
}
function statSig(p) {
  const s = fs.statSync(p);
  return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino || 0 };
}

test.after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('claimExclusiveOutput: creates a new slot and refuses an existing file without changing it', () => {
  const box = sandbox('claim-new');
  const target = path.join(box.videos, 'out.part.mp4');
  const res = claimExclusiveOutput(target);
  assert.deepEqual(res, { claimed: true });
  assert.equal(fs.existsSync(target), true);

  const before = fs.readFileSync(target);
  const sigBefore = statSig(target);
  const res2 = claimExclusiveOutput(target);
  assert.equal(res2.claimed, false);
  assert.equal(res2.code, 'EEXIST');
  assert.deepEqual(fs.readFileSync(target), before);
  const sigAfter = statSig(target);
  assert.equal(sigAfter.size, sigBefore.size);
});

test('claimExclusiveOutput: parallel claims on the same path yield exactly one winner', async () => {
  const box = sandbox('claim-race');
  const target = path.join(box.videos, 'race.part.mp4');
  const attempts = 40;
  const results = await Promise.all(Array.from({ length: attempts }, () => Promise.resolve().then(() => claimExclusiveOutput(target))));
  const winners = results.filter((r) => r.claimed === true);
  const losers = results.filter((r) => r.claimed === false && r.code === 'EEXIST');
  assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
  assert.equal(losers.length, attempts - 1);
  assert.equal(fs.existsSync(target), true);
});

test('publishTargetCandidates: prefers requested name then fresh alternatives', () => {
  const finalPath = path.join('C:', 'tmp', 'video.mp4');
  const list = publishTargetCandidates(finalPath);
  assert.equal(list[0], finalPath);
  assert.ok(list.length >= 5);
  assert.ok(list.slice(1).every((p) => p !== finalPath && p.endsWith('.mp4')));
  assert.equal(new Set(list).size, list.length);
});

test('publish: existing final file is never overwritten and render is published to an alternative', async () => {
  const box = sandbox('pub-existing');
  const finalPath = path.join(box.videos, 'vid.mp4');
  touch(finalPath, 111);
  const original = fs.readFileSync(finalPath);
  const sig = statSig(finalPath);

  const partPath = path.join(box.videos, 'vid.run.part.mp4');
  fs.writeFileSync(partPath, Buffer.alloc(222, 0x62));
  const probe = async () => ({ ok: true, durationSec: 12.3 });

  const out = await publishRenderedVideo(partPath, finalPath, { probe });
  assert.equal(out.requestedPath, finalPath);
  assert.equal(out.renamed, true);
  assert.notEqual(out.finalPath, finalPath);
  assert.equal(path.dirname(out.finalPath), box.videos);
  assert.equal(fs.existsSync(out.finalPath), true);
  assert.equal(fs.readFileSync(out.finalPath).length, 222);
  assert.equal(fs.existsSync(partPath), false, 'part is removed after successful publish');
  assert.deepEqual(fs.readFileSync(finalPath), original, 'existing file bytes unchanged');
  assert.equal(statSig(finalPath).size, sig.size, 'existing file size unchanged');
});

test('publish: validation failure does not damage an existing final file', async () => {
  const box = sandbox('pub-validate-fail');
  const finalPath = path.join(box.videos, 'vid.mp4');
  touch(finalPath, 333);
  const original = fs.readFileSync(finalPath);

  const partPath = path.join(box.videos, 'vid.run.part.mp4');
  fs.writeFileSync(partPath, Buffer.alloc(444, 0x63));
  const probe = async () => ({ ok: false, reason: 'no-video-stream' });

  await assert.rejects(
    () => publishRenderedVideo(partPath, finalPath, { probe }),
    (err) => err && err.rendered === false
  );
  assert.deepEqual(fs.readFileSync(finalPath), original, 'existing file untouched');
  assert.equal(fs.existsSync(partPath), true, 'invalid part kept for inspection by caller');
  assert.equal(fs.readFileSync(partPath).length, 444);
});

test('publish: two parallel publishes targeting the same final name do not overwrite each other', async () => {
  const box = sandbox('pub-parallel');
  const finalPath = path.join(box.videos, 'same.mp4');
  const probe = async () => ({ ok: true, durationSec: 5 });

  const mk = (label) => {
    const p = path.join(box.videos, `same.${label}.part.mp4`);
    fs.writeFileSync(p, Buffer.from(label));
    return p;
  };
  const [a, b] = await Promise.all([
    publishRenderedVideo(mk('AAA'), finalPath, { probe }),
    publishRenderedVideo(mk('BBB'), finalPath, { probe }),
  ]);

  const outs = [a.finalPath, b.finalPath];
  assert.equal(new Set(outs).size, 2, 'must publish to two distinct files');
  assert.ok(outs.includes(finalPath), 'one publish should claim the preferred name when free');
  const contents = new Set(outs.map((p) => fs.readFileSync(p, 'utf8')));
  assert.deepEqual(contents, new Set(['AAA', 'BBB']));
  assert.equal(fs.existsSync(path.join(box.videos, 'same.AAA.part.mp4')), false);
  assert.equal(fs.existsSync(path.join(box.videos, 'same.BBB.part.mp4')), false);
});

test('publish: parallel publishes do not overwrite a pre-existing final file', async () => {
  const box = sandbox('pub-parallel-existing');
  const finalPath = path.join(box.videos, 'same.mp4');
  touch(finalPath, 77);
  const original = fs.readFileSync(finalPath);
  const probe = async () => ({ ok: true, durationSec: 5 });

  const mk = (label) => {
    const p = path.join(box.videos, `same.${label}.part.mp4`);
    fs.writeFileSync(p, Buffer.from(label));
    return p;
  };
  const [a, b] = await Promise.all([
    publishRenderedVideo(mk('AAA'), finalPath, { probe }),
    publishRenderedVideo(mk('BBB'), finalPath, { probe }),
  ]);

  assert.notEqual(a.finalPath, finalPath);
  assert.notEqual(b.finalPath, finalPath);
  assert.notEqual(a.finalPath, b.finalPath);
  assert.deepEqual(fs.readFileSync(finalPath), original, 'pre-existing file preserved');
  assert.deepEqual(new Set([fs.readFileSync(a.finalPath,'utf8'), fs.readFileSync(b.finalPath,'utf8')]), new Set(['AAA','BBB']));
});

test('jobPaths: per-run part path is unique and claimable; existing part-like file is not overwritten by claim', () => {
  const box = sandbox('jobpaths');
  const args = { tmpDir: box.tmp, videosDir: box.videos, videoId: '11111111-2222-3333-4444-555555555555' };
  const a = jobPaths(args);
  const b = jobPaths(args);
  assert.notEqual(a.partPath, b.partPath);
  assert.equal(a.finalPath, b.finalPath);
  // simulate a foreign/pre-existing file at a specific path: claim must refuse and not change it
  fs.writeFileSync(a.partPath, Buffer.from('foreign'));
  const c = claimExclusiveOutput(a.partPath);
  assert.equal(c.claimed, false);
  assert.equal(c.code, 'EEXIST');
  assert.equal(fs.readFileSync(a.partPath, 'utf8'), 'foreign');
});

test('run/cleanup integration: a failed render after claim leaves no damaged existing target and respects temp cleanup policy', () => {
  const box = sandbox('failed-render');
  const partPath = path.join(box.videos, 'x.run.part.mp4');
  const startedAt = Date.now() - 10_000;
  // claim placeholder as run() would do, then simulate ffmpeg producing nothing useful (failure before valid render)
  assert.equal(claimExclusiveOutput(partPath).claimed, true);
  // policy disabled -> placeholder/temp kept
  const off = cleanupFailedRender({ partPath, rendered: false, policy: readCleanupPolicy({}), startedAt });
  assert.equal(off.removed, false);
  assert.equal(fs.existsSync(partPath), true);
  // policy enabled, own file, rendered false -> removed
  const on = readCleanupPolicy({ CLEANUP_ENABLED: 'true', CLEANUP_TMP_MODE: 'apply' });
  const onRes = cleanupFailedRender({ partPath, rendered: false, policy: on, startedAt });
  assert.deepEqual(onRes, { removed: true, reason: 'removed' });
  assert.equal(fs.existsSync(partPath), false);
});

test('workDir ownership: removeRunWorkDir never removes a directory this run did not create', () => {
  const box = sandbox('workdir-owner');
  const args = { tmpDir: box.tmp, videosDir: box.videos, videoId: '11111111-2222-3333-4444-555555555555' };
  const { workDir } = jobPaths(args);
  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'voice.wav'), 'x');
  const res = removeRunWorkDir({ workDir, ownsWorkDir: false, label: 't', log: { warn(){} } });
  assert.equal(res.removed, false);
  assert.equal(res.reason, 'not-owner');
  assert.equal(fs.existsSync(path.join(workDir, 'voice.wav')), true);
});
