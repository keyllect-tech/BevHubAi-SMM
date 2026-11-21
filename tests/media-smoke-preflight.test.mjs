import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMediaSmokePlan, reportSmokeFailure, validateMediaSmokePaths } from '../scripts/media-smoke.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanEnv = {};
const candidateRoot = () => path.join(os.tmpdir(), `bevhub-media-smoke-preflight-${crypto.randomUUID()}`);

test('preflight refuses the project root as the disposable root', () => {
  assert.throws(
    () => createMediaSmokePlan({ candidateRoot: projectRoot, projectRoot, cwd: projectRoot, env: cleanEnv }),
    /dedicated descendant|must not overlap|outside configured storage roots/i,
  );
});

test('preflight refuses overlapping database and upload paths', () => {
  const plan = createMediaSmokePlan({ candidateRoot: candidateRoot(), projectRoot, cwd: projectRoot, env: cleanEnv });
  const overlappingPaths = {
    ...plan.paths,
    databaseFile: path.join(plan.paths.uploadsDir, 'bevhub.db'),
  };
  assert.throws(
    () => validateMediaSmokePaths({ isolation: plan.isolation, testRoot: plan.testRoot, videoId: plan.videoId, paths: overlappingPaths }),
    /fixed disposable layout|overlap/i,
  );
});

test('preflight refuses inherited production storage overrides', () => {
  assert.throws(
    () =>
      createMediaSmokePlan({
        candidateRoot: candidateRoot(),
        projectRoot,
        cwd: projectRoot,
        env: { UPLOADS_DIR: 'uploads' },
      }),
    /UPLOADS_DIR is not allowed/,
  );
});

test('preflight refuses a missing disposable root', () => {
  assert.throws(
    () => createMediaSmokePlan({ projectRoot, cwd: projectRoot, env: cleanEnv }),
    /disposable root was not generated/,
  );
});

test('the entrypoint imports neither production bootstrap nor production server', () => {
  const source = fs.readFileSync(new URL('../scripts/media-smoke.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from|import\()\s*['"][^'"]*(?:server\.js|isolation-bootstrap\.js)/);
});

test('preflight import and path planning do not launch external processes or create the root', async () => {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const names = ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
  const originals = new Map(names.map((name) => [name, childProcess[name]]));
  let calls = 0;
  for (const name of names) childProcess[name] = () => {
    calls++;
    throw new Error(`unexpected external process launch: ${name}`);
  };
  syncBuiltinESMExports();

  const root = candidateRoot();
  try {
    const entrypoint = await import(new URL(`../scripts/media-smoke.mjs?preflight=${Date.now()}`, import.meta.url));
    const plan = entrypoint.createMediaSmokePlan({ candidateRoot: root, projectRoot, cwd: projectRoot, env: cleanEnv });
    assert.equal(calls, 0);
    assert.throws(() => fs.lstatSync(root), { code: 'ENOENT' });
    assert.equal(plan.testRoot, path.resolve(root));
  } finally {
    for (const [name, original] of originals) childProcess[name] = original;
    syncBuiltinESMExports();
  }
});

test('failure reporting retains the disposable root and reports its exact path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bevhub-media-smoke-failure-'));
  const messages = [];
  try {
    reportSmokeFailure(root, { rootCreated: true, log: (message) => messages.push(message) });
    assert.equal(fs.lstatSync(root).isDirectory(), true);
    assert.equal(messages.length, 1);
    assert.match(messages[0], new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(messages[0], /retained/);
  } finally {
    fs.rmdirSync(root);
  }
});

test('the CLI contains no recursive or directory deletion call', () => {
  const source = fs.readFileSync(new URL('../scripts/media-smoke.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fs\.)?(?:rmSync|rmdirSync)\s*\(/);
});
