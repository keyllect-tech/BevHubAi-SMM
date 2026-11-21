import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolationConfig } from '../server/isolation-config.js';

function sandbox() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bevhub-isolation-config-'));
  const projectRoot = path.join(parent, 'repository');
  fs.mkdirSync(projectRoot);
  return { parent, projectRoot, testRoot: path.join(parent, 'isolated-root') };
}

function isolatedConfig(box, overrides = {}, options = {}) {
  return createIsolationConfig({
    env: {
      ISOLATED_TEST_MODE: 'true',
      ISOLATED_TEST_ROOT: box.testRoot,
      ...overrides,
    },
    cwd: box.projectRoot,
    projectRoot: box.projectRoot,
    ...options,
  });
}

test('isolated config derives immutable storage paths without creating its root', () => {
  const box = sandbox();
  let dotenvCalls = 0;
  const config = isolatedConfig(box, {}, { loadProductionDotenv: () => { dotenvCalls += 1; } });

  assert.equal(config.mode, 'isolated-test');
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.paths), true);
  assert.equal(config.paths.databaseFile, path.join(box.testRoot, 'data', 'bevhub.db'));
  assert.equal(config.paths.uploadsDir, path.join(box.testRoot, 'uploads'));
  assert.equal(config.paths.tmpDir, path.join(box.testRoot, 'uploads', 'tmp'));
  assert.equal(config.paths.backupDir, path.join(box.testRoot, 'data', 'backups'));
  assert.equal(fs.existsSync(box.testRoot), false);
  assert.equal(dotenvCalls, 0);
});

test('isolated config rejects traversal and absolute external storage paths', () => {
  const box = sandbox();
  assert.throws(() => isolatedConfig(box, { UPLOADS_DIR: '../real-uploads' }), /traversal/);
  assert.throws(() => isolatedConfig(box, { DATABASE_FILE: path.join(box.parent, 'real.db') }), /absolute/);

  const config = isolatedConfig(box);
  assert.throws(() => config.assertPath(path.resolve(box.testRoot, '..', 'real-file')), /outside configured storage roots/);
});

test('isolated config rejects UNC, device, drive-relative, and NTFS ADS paths', () => {
  const box = sandbox();
  for (const candidate of [
    String.raw`\\server\share\uploads`,
    String.raw`\\.\C:\uploads`,
    String.raw`C:uploads`,
    String.raw`uploads\image.jpg:stream`,
  ]) {
    assert.throws(() => isolatedConfig(box, { UPLOADS_DIR: candidate }), /Storage path rejected/);
  }
  const box2 = sandbox();
  assert.throws(
    () => createIsolationConfig({
      env: { ISOLATED_TEST_MODE: 'true', ISOLATED_TEST_ROOT: `${box2.parent}${path.sep}..${path.sep}escaped` },
      cwd: box2.projectRoot,
      projectRoot: box2.projectRoot,
    }),
    /parent traversal/,
  );
});

test('isolated config rejects a symlink or junction in an existing path', () => {
  const box = sandbox();
  fs.mkdirSync(box.testRoot);
  const outside = path.join(box.parent, 'outside-target');
  fs.mkdirSync(outside);
  const link = path.join(box.testRoot, 'redirect');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

  const config = isolatedConfig(box);
  assert.throws(() => config.assertPath(path.join(link, 'file.txt')), /link|redirect/i);
});

test('isolated config allows a missing descendant but does not create it', () => {
  const box = sandbox();
  const config = isolatedConfig(box);
  const missing = path.join(box.testRoot, 'not-created', 'nested', 'file.db');

  assert.equal(config.assertPath(missing), missing);
  assert.equal(fs.existsSync(path.join(box.testRoot, 'not-created')), false);
});

test('isolated config fails closed when an ancestor cannot be inspected', () => {
  const box = sandbox();
  const blocked = path.join(box.parent, 'blocked');
  const testRoot = path.join(blocked, 'isolated-root');
  const fsApi = {
    lstatSync(candidate, ...args) {
      if (path.resolve(candidate) === path.resolve(blocked)) {
        const error = new Error('inaccessible');
        error.code = 'EACCES';
        throw error;
      }
      return fs.lstatSync(candidate, ...args);
    },
    realpathSync: fs.realpathSync.bind(fs),
    statSync: fs.statSync.bind(fs),
  };

  assert.throws(
    () => createIsolationConfig({
      env: { ISOLATED_TEST_MODE: 'true', ISOLATED_TEST_ROOT: testRoot },
      cwd: box.projectRoot,
      projectRoot: box.projectRoot,
      fsApi,
    }),
    /Cannot verify storage path ancestor/,
  );
});

test('isolation modes are mutually exclusive and require strict boolean values', () => {
  const box = sandbox();
  assert.throws(() => isolatedConfig(box, { ISOLATED_DESTRUCTIVE_TEST_MODE: 'true' }), /mutually exclusive/);
  assert.throws(() => isolatedConfig(box, { ISOLATED_TEST_MODE: 'maybe' }), /strict boolean/);
});

test('isolated config rejects dotenv overrides and Node preload option aliases', () => {
  const box = sandbox();
  assert.throws(() => isolatedConfig(box, { DOTENV_CONFIG_PATH: path.join(box.parent, '.env') }), /DOTENV_CONFIG_PATH/);
  const nodeOptionsCases = [
    '-r preload.cjs',
    '-r=preload.cjs',
    '--require preload.cjs',
    '--require=preload.cjs',
    '--import preload.mjs',
    '--import=preload.mjs',
    '--loader loader.mjs',
    '--loader=loader.mjs',
    '--experimental-loader loader.mjs',
    '--experimental-loader=loader.mjs',
    '--experimental_loader loader.mjs',
    '--experimental_loader=loader.mjs',
    '--require preload.cjs --import preload.mjs',
    '--require "./preload with spaces.cjs"',
  ];
  for (const NODE_OPTIONS of nodeOptionsCases) {
    assert.throws(() => isolatedConfig(box, { NODE_OPTIONS }), /preload/, NODE_OPTIONS);
  }
  const execArgvCases = [
    ['-r', 'preload.cjs'],
    ['--require', 'preload.cjs'],
    ['--require=preload.cjs'],
    ['--import=preload.mjs'],
    ['--loader', 'loader.mjs'],
    ['--experimental-loader=loader.mjs'],
    ['--env-file', '.env'],
    ['--env_file', '.env'],
    ['--env-file=.env'],
    ['--env_file=.env'],
    ['--env-file-if-exists', '.env'],
    ['--env_file_if_exists', '.env'],
    ['--env-file-if-exists=.env'],
    ['--env_file_if_exists=.env'],
    ['--require=first.cjs', '--import=second.mjs'],
  ];
  for (const execArgv of execArgvCases) {
    assert.throws(() => isolatedConfig(box, {}, { execArgv }), /preload/, execArgv.join(' '));
  }
  for (const NODE_OPTIONS of [
    '--title="text containing --require"',
    '--title="text containing --experimental_loader and --env_file"',
    '--title=--require',
  ]) {
    assert.doesNotThrow(() => isolatedConfig(box, { NODE_OPTIONS }), NODE_OPTIONS);
  }
  for (const execArgv of [
    ['--title=--require'],
    ['--title=--experimental_loader'],
    ['--title=--env_file_if_exists'],
    ['--title', 'a title containing --require'],
  ]) {
    assert.doesNotThrow(() => isolatedConfig(box, {}, { execArgv }), execArgv.join(' '));
  }
  assert.throws(() => isolatedConfig(box, { NODE_OPTIONS: '--require "unterminated' }), /unterminated/);
});

test('isolated config does not accept a production path or production allowlist', () => {
  const box = sandbox();
  assert.throws(
    () => isolatedConfig(box, { BACKUP_DIR: path.join(box.parent, 'production-backups') }),
    /absolute/,
  );
  assert.throws(() => isolatedConfig(box, { STORAGE_ALLOWED_ROOTS: box.parent }), /cannot be inherited/);
  assert.throws(
    () => createIsolationConfig({
      env: { ISOLATED_TEST_MODE: 'true', ISOLATED_TEST_ROOT: path.join(os.homedir(), 'bevhub-production-data') },
      cwd: box.projectRoot,
      projectRoot: box.projectRoot,
    }),
    /temporary directory/,
  );
});

test('production mode allows absolute deployment paths only under configured roots', () => {
  const box = sandbox();
  const deploymentRoot = path.join(box.parent, 'deployment');
  fs.mkdirSync(deploymentRoot);
  const config = createIsolationConfig({
    env: {
      STORAGE_ALLOWED_ROOTS: deploymentRoot,
      DATABASE_FILE: path.join(deploymentRoot, 'data', 'app.db'),
    },
    cwd: box.projectRoot,
    projectRoot: box.projectRoot,
    loadProductionDotenv: () => {},
  });

  assert.equal(config.mode, 'production');
  assert.equal(config.paths.databaseFile, path.join(deploymentRoot, 'data', 'app.db'));
  assert.throws(() => config.assertPath(path.join(box.parent, 'not-allowed.db')), /outside configured storage roots/);
});

test('production Windows paths reject ADS and ambiguous forms without weakening the allowlist', { skip: process.platform !== 'win32' }, () => {
  const box = sandbox();
  const config = createIsolationConfig({
    env: {},
    cwd: box.projectRoot,
    projectRoot: box.projectRoot,
    loadProductionDotenv: () => {},
  });
  const rejected = [
    ['NTFS ADS', path.win32.join(box.projectRoot, 'data', 'bevhub.db:stream')],
    ['relative ADS', 'data\\bevhub.db:stream'],
    ['drive-relative', String.raw`C:relative.db`],
    ['UNC', String.raw`\\server\share\data\bevhub.db`],
    ['extended device path', String.raw`\\?\C:\data\bevhub.db`],
    ['device namespace', String.raw`\\.\C:\data\bevhub.db`],
    ['drive-root-relative', String.raw`\data\bevhub.db`],
    ['slash UNC', '//server/share/data/bevhub.db'],
    ['reserved DOS device', path.win32.join(box.projectRoot, 'NUL')],
    ['reserved device with extension', path.win32.join(box.projectRoot, 'CON.txt')],
    ['trailing dot component', path.win32.join(box.projectRoot, 'data', 'folder.')],
    ['trailing space component', path.win32.join(box.projectRoot, 'data', 'folder ')],
  ];

  for (const [name, candidate] of rejected) {
    assert.throws(
      () => config.resolvePath(candidate, { base: box.projectRoot }),
      /Storage path rejected/,
      `${name} must be rejected`,
    );
  }

  const allowedAbsolute = path.win32.join(box.projectRoot, 'data', 'safe.db');
  assert.equal(config.resolvePath(allowedAbsolute), allowedAbsolute);

  const similarlyNamedSibling = path.win32.join(box.parent, 'repository-backup', 'safe.db');
  assert.throws(() => config.resolvePath(similarlyNamedSibling), /outside configured storage roots/);
});
