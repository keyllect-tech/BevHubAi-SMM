import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_ENV = ['DATABASE_FILE', 'UPLOADS_DIR', 'TMP_DIR', 'BACKUP_DIR'];
const DOTENV_ENV_RE = /^DOTENV_/i;
const PRELOAD_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--env-file-if-exists',
]);

function tokenizeNodeOptions(value) {
  const tokens = [];
  let token = '';
  let quote = null;
  let active = false;

  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (quote) {
      if (character === '\\' && (value[i + 1] === quote || value[i + 1] === '\\')) {
        token += value[++i];
      } else if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      active = true;
    } else if (/\s/.test(character)) {
      if (active) {
        tokens.push(token);
        token = '';
        active = false;
      }
    } else {
      token += character;
      active = true;
    }
  }

  if (quote) throw new Error('NODE_OPTIONS contains an unterminated quoted value');
  if (active) tokens.push(token);
  return tokens;
}

function isPreloadOption(token) {
  const equalsAt = token.indexOf('=');
  const option = (equalsAt === -1 ? token : token.slice(0, equalsAt)).replace(/_/g, '-');
  return PRELOAD_OPTIONS.has(option);
}

// This only fails closed after Node has parsed startup options; it cannot undo a preload already run.
// A guarantee before Node starts requires a controlled parent launcher with sanitized argv/env.
function hasPreloadOptions(nodeOptions, execArgv) {
  return [...tokenizeNodeOptions(nodeOptions), ...execArgv].some(isPreloadOption);
}

function modeEnabled(name, env) {
  const value = env[name];
  if (value == null || String(value).trim() === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a strict boolean`);
}

export function detectIsolationMode(env = process.env) {
  const isolated = modeEnabled('ISOLATED_TEST_MODE', env);
  const destructive = modeEnabled('ISOLATED_DESTRUCTIVE_TEST_MODE', env);
  if (isolated && destructive) {
    throw new Error('ISOLATED_TEST_MODE and ISOLATED_DESTRUCTIVE_TEST_MODE are mutually exclusive');
  }
  if (!isolated && !destructive && env.ISOLATED_TEST_ROOT) {
    throw new Error('ISOLATED_TEST_ROOT requires an isolated mode');
  }
  return destructive ? 'isolated-destructive-test' : isolated ? 'isolated-test' : 'production';
}

function failPath(reason) {
  throw new Error(`Storage path rejected: ${reason}`);
}

function rejectUnsafeWindowsPathSyntax(value, name, platform) {
  if (platform !== 'win32') return;
  if (typeof value !== 'string' || value.length === 0) failPath(`${name} must be a non-empty path`);

  const normalized = value.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\')) failPath(`${name} cannot use UNC or device paths`);
  if (/^[a-z]:(?![\\/])/i.test(normalized)) failPath(`${name} cannot use drive-relative paths`);
  if (/^[\\/]/.test(normalized)) failPath(`${name} cannot use drive-root-relative paths`);

  const withoutDrive = normalized.replace(/^[a-z]:/i, '');
  if (withoutDrive.includes(':')) failPath(`${name} cannot use NTFS alternate data streams`);
  for (const component of normalized.split('\\')) {
    if (!component || /^[a-z]:$/i.test(component)) continue;
    if (/[. ]$/.test(component)) failPath(`${name} cannot use Windows components ending in a dot or space`);
    const baseName = component.split('.')[0];
    if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(baseName)) {
      failPath(`${name} cannot use a reserved Windows device name`);
    }
  }
}

function samePath(a, b, platform) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithin(root, target, platform) {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return first !== '..';
}

function rejectUnsafeIsolatedSyntax(value) {
  if (typeof value !== 'string' || value.length === 0) failPath('empty path');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    failPath('absolute, UNC, device, or drive-relative path is not allowed in isolated mode');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('//') || normalized.includes('\0')) failPath('UNC, device, or invalid path syntax');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) failPath('parent traversal is not allowed in isolated mode');
  if (parts.some((part) => part.includes(':'))) failPath('NTFS alternate data streams are not allowed');
}

function rejectUnsafeIsolatedRoot(value) {
  if (typeof value !== 'string' || value.length === 0) failPath('ISOLATED_TEST_ROOT is required');
  if (value.startsWith('\\\\') || value.startsWith('//') || /^\\\\[?.]\\/.test(value)) {
    failPath('ISOLATED_TEST_ROOT cannot be UNC or a Windows device path');
  }
  const withoutDrive = value.replace(/^[a-z]:/i, '');
  const parts = withoutDrive.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) failPath('ISOLATED_TEST_ROOT cannot contain parent traversal');
  if (parts.some((part) => part.includes(':'))) failPath('ISOLATED_TEST_ROOT cannot contain an NTFS alternate data stream');
}

/**
 * Resolves every existing component independently. This is a point-in-time check, not a handle-based
 * guarantee: Node's path-based filesystem calls cannot prevent replacement after validation. Windows
 * reparse tags not exposed by lstat/realpath also require a native handle-based helper to identify fully.
 */
function physicalPath(candidate, fsApi, platform) {
  const absolute = path.resolve(candidate);
  if (!path.isAbsolute(absolute)) failPath('path is not absolute');

  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let lexical = parsed.root;
  let canonical;
  let missing = false;

  try {
    const rootStat = fsApi.lstatSync(lexical);
    if (rootStat.isSymbolicLink()) failPath('filesystem root is a link or reparse point');
    canonical = path.resolve(fsApi.realpathSync(lexical));
  } catch (error) {
    if (error && error.code === 'ENOENT') failPath('filesystem root does not exist');
    throw error;
  }

  for (const segment of segments) {
    lexical = path.join(lexical, segment);
    if (missing) {
      canonical = path.join(canonical, segment);
      continue;
    }

    let stat;
    try {
      stat = fsApi.lstatSync(lexical);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        missing = true;
        canonical = path.join(canonical, segment);
        continue;
      }
      throw new Error(`Cannot verify storage path ancestor (${error.code || 'filesystem error'})`);
    }
    if (stat.isSymbolicLink()) failPath('symlink or reparse point in path ancestors');

    let resolved;
    try {
      resolved = path.resolve(fsApi.realpathSync(lexical));
    } catch (error) {
      throw new Error(`Cannot resolve storage path ancestor (${error.code || 'filesystem error'})`);
    }
    const expected = path.resolve(path.join(canonical, segment));
    if (!samePath(resolved, expected, platform)) {
      failPath('physical path redirects through a junction, reparse point, or mount');
    }
    canonical = resolved;
  }

  return { lexical: absolute, canonical: path.resolve(canonical), missing };
}

function validateIsolatedStorageOverride(name, value) {
  if (value == null || value === '') return;
  rejectUnsafeIsolatedSyntax(value);
  if (path.win32.isAbsolute(value)) failPath(`${name} must be relative to ISOLATED_TEST_ROOT`);
}

export function createIsolationConfig({
  env = process.env,
  cwd = process.cwd(),
  projectRoot = MODULE_ROOT,
  fsApi = fs,
  platform = process.platform,
  execArgv = [],
  loadProductionDotenv,
} = {}) {
  let mode = detectIsolationMode(env);

  if (mode !== 'production') {
    for (const key of Object.keys(env)) {
      if (DOTENV_ENV_RE.test(key)) throw new Error(`${key} is not allowed in isolated mode`);
    }
    if (hasPreloadOptions(env.NODE_OPTIONS || '', execArgv)) {
      throw new Error('Node preload and --env-file options must be removed before isolated startup');
    }
  } else if (loadProductionDotenv) {
    loadProductionDotenv();
    const afterDotenvMode = detectIsolationMode(env);
    if (afterDotenvMode !== 'production') {
      throw new Error('Isolation mode must be selected by the parent process, not by dotenv');
    }
    mode = afterDotenvMode;
  }

  const isolated = mode !== 'production';
  rejectUnsafeWindowsPathSyntax(projectRoot, 'project root', platform);
  const root = path.resolve(projectRoot);
  let testRoot = null;
  let allowedRoots;

  if (isolated) {
    const rawTestRoot = env.ISOLATED_TEST_ROOT;
    if (!rawTestRoot || !path.isAbsolute(rawTestRoot) || path.win32.isAbsolute(rawTestRoot) && platform !== 'win32') {
      throw new Error('ISOLATED_TEST_ROOT must be an absolute path on the current platform');
    }
    rejectUnsafeIsolatedRoot(rawTestRoot);
    for (const name of STORAGE_ENV) validateIsolatedStorageOverride(name, env[name]);
    if (env.STORAGE_ALLOWED_ROOTS) throw new Error('STORAGE_ALLOWED_ROOTS cannot be inherited by isolated mode');

    testRoot = path.resolve(rawTestRoot);
    const rootPhysical = physicalPath(root, fsApi, platform);
    const testPhysical = physicalPath(testRoot, fsApi, platform);
    const temporaryRoot = physicalPath(os.tmpdir(), fsApi, platform);
    if (!isWithin(temporaryRoot.canonical, testPhysical.canonical, platform) || samePath(temporaryRoot.canonical, testPhysical.canonical, platform)) {
      throw new Error('ISOLATED_TEST_ROOT must be a dedicated descendant of the operating-system temporary directory');
    }
    if (
      isWithin(rootPhysical.canonical, testPhysical.canonical, platform) ||
      isWithin(testPhysical.canonical, rootPhysical.canonical, platform)
    ) {
      throw new Error('ISOLATED_TEST_ROOT must not overlap the project root');
    }
    allowedRoots = [{ lexical: testRoot, canonical: testPhysical.canonical }];
  } else {
    const configuredRoots = env.STORAGE_ALLOWED_ROOTS
      ? env.STORAGE_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean)
      : [];
    const roots = [
      root,
      ...configuredRoots.map((entry) => {
        rejectUnsafeWindowsPathSyntax(entry, 'STORAGE_ALLOWED_ROOTS entry', platform);
        return path.resolve(cwd, entry);
      }),
    ];
    allowedRoots = [];
    for (const allowedRoot of roots) {
      const checked = physicalPath(allowedRoot, fsApi, platform);
      if (checked.missing) failPath('deployment allowlist roots must already exist');
      if (!fsApi.statSync(checked.lexical).isDirectory()) failPath('deployment allowlist entry is not a directory');
      if (!allowedRoots.some((entry) => samePath(entry.canonical, checked.canonical, platform))) {
        allowedRoots.push(checked);
      }
    }
  }

  /**
   * Checks current lexical and physical containment. Callers must still account for TOCTOU between
   * this check and the filesystem operation; this API does not pin Windows directory handles.
   */
  const assertPath = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) failPath('empty path');
    rejectUnsafeWindowsPathSyntax(candidate, 'storage path', platform);
    if (isolated && candidate.replace(/\\/g, '/').split('/').some((part) => part === '..')) {
      failPath('parent traversal is not allowed in isolated mode');
    }
    const lexical = path.resolve(candidate);
    const lexicalRoot = allowedRoots.find((entry) => isWithin(entry.lexical, lexical, platform));
    if (!lexicalRoot) failPath('path is outside configured storage roots');

    const targetPhysical = physicalPath(lexical, fsApi, platform);
    const rootPhysical = physicalPath(lexicalRoot.lexical, fsApi, platform);
    if (!isWithin(rootPhysical.canonical, targetPhysical.canonical, platform)) {
      failPath('canonical path is outside configured storage roots');
    }
    return targetPhysical.lexical;
  };

  const resolvePath = (value, { base = isolated ? testRoot : root, name = 'path' } = {}) => {
    if (isolated) validateIsolatedStorageOverride(name, value);
    rejectUnsafeWindowsPathSyntax(value, name, platform);
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
    return assertPath(resolved);
  };

  const readStoragePath = (name, fallback, base) => {
    const value = env[name] || fallback;
    return resolvePath(value, { base, name });
  };

  const defaults = isolated
    ? {
        databaseFile: 'data/bevhub.db',
        uploadsDir: 'uploads',
      }
    : {
        databaseFile: path.join(root, 'data', 'bevhub.db'),
        uploadsDir: 'uploads',
      };
  const databaseFile = readStoragePath('DATABASE_FILE', defaults.databaseFile, isolated ? testRoot : cwd);
  const uploadsDir = readStoragePath('UPLOADS_DIR', defaults.uploadsDir, isolated ? testRoot : root);
  const tmpDir = env.TMP_DIR
    ? readStoragePath('TMP_DIR', '', isolated ? testRoot : root)
    : assertPath(path.join(uploadsDir, 'tmp'));
  const backupDir = env.BACKUP_DIR
    ? readStoragePath('BACKUP_DIR', '', isolated ? testRoot : root)
    : assertPath(path.join(path.dirname(databaseFile), 'backups'));
  const imagesDir = assertPath(path.join(uploadsDir, 'images'));
  const videosDir = assertPath(path.join(uploadsDir, 'videos'));
  const audioDir = assertPath(path.join(uploadsDir, 'audio'));

  const paths = Object.freeze({
    databaseFile,
    uploadsDir,
    imagesDir,
    videosDir,
    audioDir,
    tmpDir,
    backupDir,
  });
  const config = {
    mode,
    isIsolated: isolated,
    isDestructiveTest: mode === 'isolated-destructive-test',
    projectRoot: root,
    testRoot,
    paths,
    assertPath,
    resolvePath,
  };
  return Object.freeze(config);
}
