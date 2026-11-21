import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import childProcess from 'node:child_process';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMediaSmokePlan, reportSmokeFailure } from './media-smoke.mjs';
import {
  createChildProcessRegistry,
  createIdempotentShutdown,
  createStopCommandParser,
  createVideoDiagnosticCompletion,
  createUiMediaDiagnostics,
  safeCleanupErrorCode,
  safeScriptSummary,
  summarizeVideoCreatePayload,
  summarizeVideoCreateResponse,
  verifyLoopbackPortReleased,
  writeShutdownReport,
} from './ui-media-smoke-diagnostics.mjs';

const execFileAsync = (file, args, options) => new Promise((resolve, reject) => {
  childProcess.execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let disposableRootForFailure = null;
let disposableRootCreated = false;
let activeDiagnostics = null;
let activeApiServer = null;
let activeViteServer = null;
let activeDatabase = null;
let activeShutdown = null;
let activeRemoveStopChannel = null;
let activeRemoveFatalHandlers = null;
let activeRemoveSignalHandlers = null;
let activeChildProcessRegistry = null;
let activeResourcesClosePromise = null;
let activeShutdownReportOptions = null;
const VIDEO_CREATE_CONTEXT = Symbol('videoCreateDiagnosticContext');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ENV_NAMES = [
  'SystemRoot',
  'WINDIR',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'MEDIA_SMOKE_LAUNCHER',
  'ISOLATED_TEST_MODE',
  'ISOLATED_DESTRUCTIVE_TEST_MODE',
  'ISOLATED_TEST_ROOT',
  'TTS_PROVIDER',
  'TTS_PROVIDER_ORDER',
  'EDGE_TTS_DISABLED',
  'API_PROXY_TARGET',
];
function assertEnvironment() {
  if (process.env.MEDIA_SMOKE_LAUNCHER !== '1') {
    throw new Error('Start this harness only through scripts/run-ui-media-smoke.ps1');
  }
  if (process.argv.length !== 2) throw new Error('Command-line arguments are not accepted');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This harness requires Windows x64');
}

function replaceEnvironment({ systemRoot, nodeDirectory, testRoot }) {
  const allowed = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: [
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(systemRoot, 'System32'),
      nodeDirectory,
    ].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: path.join(testRoot, 'system-temp'),
    TMP: path.join(testRoot, 'system-temp'),
    MEDIA_SMOKE_LAUNCHER: '1',
    ISOLATED_TEST_MODE: 'true',
    ISOLATED_DESTRUCTIVE_TEST_MODE: 'false',
    ISOLATED_TEST_ROOT: testRoot,
    TTS_PROVIDER: 'local',
    TTS_PROVIDER_ORDER: 'windows-sapi',
    EDGE_TTS_DISABLED: 'true',
    API_PROXY_TARGET: '',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const name of SAFE_ENV_NAMES) {
    if (allowed[name] !== undefined) process.env[name] = allowed[name];
  }
}

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function createSyntheticPng() {
  const width = 512;
  const height = 512;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      raw[offset++] = 22 + Math.floor((x / width) * 70);
      raw[offset++] = 60 + Math.floor((y / height) * 100);
      raw[offset++] = 90 + Math.floor(((x + y) / (width + height)) * 100);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(isolation, filePath, value, { exclusive = false } = {}) {
  isolation.assertPath(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: exclusive ? 'wx' : 'w',
  });
}

function requestPath(req) {
  try {
    return new URL(req.originalUrl || req.url, 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

function observeResponse(req, res, source, diagnostics, onComplete = () => {}) {
  const request = diagnostics.recordRequest({
    method: req.method,
    url: req.originalUrl || req.url,
    status: null,
    source,
  });
  let recorded = false;
  const complete = (status) => {
    if (recorded) return;
    recorded = true;
    if (!request) return;
    diagnostics.setRequestStatus(request, status);
    onComplete(status);
  };
  res.once('finish', () => complete(res.statusCode));
  res.once('close', () => complete(res.writableFinished ? res.statusCode : null));
}

function trackApiRequests(app, diagnostics, db, isShuttingDown, completeVideoCreate = () => {}) {
  app.use((req, res, next) => {
    if (isShuttingDown()) {
      next();
      return;
    }
    const pathname = requestPath(req);
    const method = req.method.toUpperCase();
    const isRegistration = method === 'POST' && pathname === '/api/auth/register';
    const isVideoCreation = method === 'POST' && pathname === '/api/videos';
    const videoContext = isVideoCreation ? { payload: null, responseBody: null } : null;
    if (videoContext) req[VIDEO_CREATE_CONTEXT] = videoContext;
    let responseBody = null;

    observeResponse(req, res, 'API', diagnostics, (status) => {
      if (isShuttingDown()) return;
      if (isRegistration) {
        const user = status >= 200 && status < 300
          ? db.prepare('SELECT id FROM users ORDER BY created_at DESC LIMIT 1').get()
          : null;
        diagnostics.completeRegistration(status, responseBody, user);
      } else if (isVideoCreation && status >= 200 && status < 300) {
        const video = db.prepare('SELECT id FROM videos ORDER BY created_at DESC LIMIT 1').get();
        diagnostics.setVideoId(video?.id);
      } else if (status >= 400) {
        diagnostics.setFailure(`api-http-${status}`, 'api-error');
      } else if (status >= 200 && status < 300 && pathname === '/api/projects' && method === 'POST') {
        diagnostics.setStage('project-created');
      } else if (status >= 200 && status < 300 && pathname === '/api/files' && method === 'POST') {
        diagnostics.setStage('image-uploaded');
      } else if (status >= 200 && status < 300 && pathname === '/api/scripts' && method === 'POST') {
        diagnostics.setStage('script-generated');
      }

      if (/^\/api\/videos\/[^/]+\/file$/.test(pathname)) {
        diagnostics.setDownloadStatus(method, status);
      }
      if (isVideoCreation) {
        const result = summarizeVideoCreateResponse(
          status,
          res.getHeader('content-type'),
          videoContext.responseBody,
          videoContext.payload,
        );
        try {
          completeVideoCreate(result);
        } catch (error) {
          console.error(`[UI MEDIA SMOKE] Could not complete video diagnostic (${safeCleanupErrorCode(error, 'close-error')}).`);
        }
      }
    });
    if (isRegistration) {
      diagnostics.markRegistrationSent();
      const sendJson = res.json.bind(res);
      res.json = (body) => {
        if (!isShuttingDown()) responseBody = body;
        return sendJson(body);
      };
    } else if (isVideoCreation) {
      const sendJson = res.json.bind(res);
      res.json = (body) => {
        if (!isShuttingDown()) videoContext.responseBody = body;
        return sendJson(body);
      };
    }
    next();
  });
}

export function inspectVideoFiles(fileIds, db, workspaceId, imagesDir, isolation) {
  return fileIds.map((fileId) => {
    if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) {
      return { workspaceOwned: false, presentOnDisk: false };
    }
    const row = db.prepare('SELECT filename FROM files WHERE id = ? AND workspace_id = ?').get(fileId, workspaceId);
    if (!row) return { workspaceOwned: false, presentOnDisk: false };
    if (typeof row.filename !== 'string' || path.basename(row.filename) !== row.filename) {
      throw new Error('stored image path is invalid');
    }
    const candidate = path.resolve(imagesDir, row.filename);
    const safePath = isolation.assertPath(candidate);
    if (path.dirname(safePath) !== path.resolve(imagesDir)) {
      throw new Error('stored image path is outside the image directory');
    }
    return { workspaceOwned: true, presentOnDisk: fs.existsSync(safePath) };
  });
}

function captureVideoCreatePayload(app, db, imagesDir, isolation, isShuttingDown) {
  app.use('/api', (req, _res, next) => {
    const context = req[VIDEO_CREATE_CONTEXT];
    if (!context || isShuttingDown()) {
      next();
      return;
    }
    let checks = null;
    let checkState = 'unavailable';
    try {
      const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
      checks = inspectVideoFiles(fileIds, db, req.workspace.id, imagesDir, isolation);
      checkState = 'checked';
    } catch (error) {
      console.error(`[UI MEDIA SMOKE] Image ownership diagnostic unavailable (${safeCleanupErrorCode(error, 'cleanup-error')}).`);
    }
    context.payload = summarizeVideoCreatePayload(req.body, checks, checkState);
    next();
  });
}

function uiRequestDiagnosticsPlugin(diagnostics) {
  return {
    name: 'ui-media-smoke-request-diagnostics',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        observeResponse(req, res, 'UI', diagnostics);
        next();
      });
    },
  };
}

function installStopChannel(setShutdownHandler) {
  const onData = createStopCommandParser(() => {
    setShutdownHandler();
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  return () => {
    process.stdin.off('data', onData);
    process.stdin.pause();
  };
}

const RESOURCE_CLOSE_TIMEOUT_MS = 5000;

function createSafeCloseLogger(log) {
  const sink = typeof log === 'function' ? log : console.warn;
  return (message) => {
    try {
      sink(message);
    } catch {
      // Reporting a cleanup problem must never abort the remaining cleanup steps.
    }
  };
}

async function waitForResourceClose(label, close, timeoutMs, log) {
  if (typeof close !== 'function') return null;
  const timedOut = {};
  let timer;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(close),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (outcome === timedOut) {
      // The timeout only bounds how long this step waits. It does not prove that the
      // resource stopped; a stalled close may still hold sockets, ports, or handles.
      log(`[UI MEDIA SMOKE] ${label} close wait timed out (ETIMEDOUT); the resource may still be active.`);
      return false;
    }
    return true;
  } catch (error) {
    log(`[UI MEDIA SMOKE] ${label} close failed (${safeCleanupErrorCode(error, 'close-error')}); the resource may still be active.`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runResourceCloseActions(exitCode, actions) {
  const timeoutMs = Number.isFinite(actions.closeTimeoutMs) && actions.closeTimeoutMs >= 0
    ? actions.closeTimeoutMs
    : RESOURCE_CLOSE_TIMEOUT_MS;
  const log = createSafeCloseLogger(actions.log);
  const closeResults = { viteClosed: null, apiClosed: null, databaseClosed: null };
  const steps = [
    ['viteClosed', 'close', 'Vite', actions.closeVite],
    [null, 'cleanup', 'API connections', actions.closeAllApiConnections],
    ['apiClosed', 'close', 'API server', actions.closeApi],
    ['databaseClosed', 'close', 'SQLite', actions.closeDatabase],
    [null, 'cleanup', 'Stop channel', actions.removeStopChannel],
    [null, 'cleanup', 'Child-process hooks', actions.restoreChildProcessHooks],
    [null, 'cleanup', 'Signal handlers', actions.removeSignalHandlers],
    [null, 'cleanup', 'Fatal handlers', actions.removeFatalHandlers],
    [null, 'cleanup', 'Exit code', () => actions.setExitCode?.(exitCode)],
  ];

  // Every step is isolated from the others: a timeout, a rejected close, or a throwing
  // action only produces a safe diagnostic code and never prevents the following steps
  // from running. Listener and hook removal is always attempted on this same guaranteed
  // cleanup path, and SQLite is closed regardless of how the Vite and API server closes
  // ended. A close timeout only bounds the wait; it never asserts that a resource stopped.
  for (const [resultKey, kind, label, action] of steps) {
    try {
      if (kind === 'close') {
        const closed = await waitForResourceClose(label, action, timeoutMs, log);
        if (resultKey) closeResults[resultKey] = closed;
      } else if (typeof action === 'function') {
        action();
      }
    } catch (error) {
      log(kind === 'close'
        ? `[UI MEDIA SMOKE] ${label} close failed (${safeCleanupErrorCode(error, 'close-error')}); the resource may still be active.`
        : `[UI MEDIA SMOKE] ${label} cleanup failed (${safeCleanupErrorCode(error, 'cleanup-error')}).`);
      if (kind === 'close' && resultKey) closeResults[resultKey] = false;
    }
  }
  return closeResults;
}

export function closeActiveResources(exitCode = 1, injectedActions) {
  const hasInjectedActions = injectedActions !== undefined;
  if (!hasInjectedActions && activeResourcesClosePromise) return activeResourcesClosePromise;
  if (hasInjectedActions) return runResourceCloseActions(exitCode, injectedActions);

  const viteServer = activeViteServer;
  const apiServer = activeApiServer;
  const database = activeDatabase;
  const childProcessRegistry = activeChildProcessRegistry;
  const actions = {
    closeVite: viteServer ? () => viteServer.close() : null,
    closeAllApiConnections: apiServer ? () => apiServer.closeAllConnections() : null,
    closeApi: apiServer
      ? () => new Promise((resolve, reject) => {
        apiServer.close((error) => error ? reject(error) : resolve());
      })
      : null,
    closeDatabase: database ? () => database.close() : null,
    removeStopChannel: activeRemoveStopChannel,
    restoreChildProcessHooks: childProcessRegistry ? () => childProcessRegistry.restore() : null,
    removeSignalHandlers: activeRemoveSignalHandlers,
    removeFatalHandlers: activeRemoveFatalHandlers,
    setExitCode: (code) => { process.exitCode = code; },
  };
  activeViteServer = null;
  activeApiServer = null;
  activeDatabase = null;
  activeChildProcessRegistry = null;
  activeRemoveStopChannel = null;
  activeRemoveSignalHandlers = null;
  activeRemoveFatalHandlers = null;
  activeResourcesClosePromise = runResourceCloseActions(exitCode, actions);
  return activeResourcesClosePromise;
}

export async function shutdownResources(exitCode, reason, result = 'failed', dependencies = {}) {
  const diagnostics = dependencies.diagnostics === undefined ? activeDiagnostics : dependencies.diagnostics;
  const childProcessRegistry = dependencies.childProcessRegistry === undefined
    ? activeChildProcessRegistry
    : dependencies.childProcessRegistry;
  const closeResources = dependencies.closeResources || closeActiveResources;
  const setExitCode = dependencies.setExitCode || ((code) => { process.exitCode = code; });
  if (diagnostics) {
    let lastStage = diagnostics.state.videoCreation ? diagnostics.state.lastStage : 'completed';
    if (reason) {
      lastStage = reason === 'graceful-shutdown'
        ? 'graceful-shutdown'
        : diagnostics.state.lastStage;
    }
    try {
      diagnostics.beginShutdown({
        failureReason: reason || undefined,
        lastStage,
      });
    } catch (error) {
      console.error(`[UI MEDIA SMOKE] Diagnostics freeze failed (${safeCleanupErrorCode(error, 'cleanup-error')}).`);
    }
  }

  let childProcessCleanup = { children: [], blockedLaunches: [] };
  if (childProcessRegistry) {
    try {
      childProcessCleanup = await childProcessRegistry.stopOwnedChildren();
    } catch (error) {
      childProcessCleanup = childProcessRegistry.snapshot();
      childProcessCleanup.cleanupError = 'child-process-cleanup-failed';
      console.error(`[UI MEDIA SMOKE] Child-process cleanup failed (${safeCleanupErrorCode(error, 'child-process-cleanup-failed')}).`);
    }
  }
  const childProcessFailures = childProcessCleanup.children
    .filter((child) => child.status !== 'closed' || child.stopFailureReason)
    .map((child) => ({
      pid: child.pid,
      reason: child.stopFailureReason || `process-${child.status}`,
    }));
  const childProcessCleanupFailed = childProcessFailures.length > 0
    || Boolean(childProcessCleanup.cleanupError);
  for (const failure of childProcessFailures) {
    console.error(`[UI MEDIA SMOKE] Child process ${failure.pid} did not stop cleanly: ${failure.reason}`);
  }
  if (diagnostics) {
    try {
      diagnostics.finalize({
        result: childProcessCleanupFailed ? 'failed' : result,
        harnessPid: dependencies.harnessPid === undefined ? process.pid : dependencies.harnessPid,
        childProcessCleanup,
        ...(childProcessCleanupFailed ? { failureReason: 'child-process-cleanup-failed' } : {}),
      });
    } catch (error) {
      console.error(`[UI MEDIA SMOKE] Could not finalize report (${safeCleanupErrorCode(error, 'close-error')}).`);
    }
  }
  let closeResults = null;
  try {
    closeResults = await closeResources(
      childProcessCleanupFailed ? 1 : exitCode,
      dependencies.closeActions,
    );
  } catch (error) {
    console.error(`[UI MEDIA SMOKE] Resource shutdown failed (${safeCleanupErrorCode(error, 'close-error')}).`);
  }
  const shutdownReportOptions = dependencies.shutdownReport || activeShutdownReportOptions;
  if (shutdownReportOptions?.isolation && shutdownReportOptions?.reportPath) {
    const verifyPortReleased = dependencies.verifyPortReleased || verifyLoopbackPortReleased;
    const verifyPort = async (port) => {
      if (!Number.isInteger(port)) return null;
      try {
        return await verifyPortReleased(port);
      } catch (error) {
        console.error(`[UI MEDIA SMOKE] Port release check failed (${safeCleanupErrorCode(error, 'close-error')}).`);
        return false;
      }
    };
    const [apiPortReleased, uiPortReleased] = await Promise.all([
      verifyPort(shutdownReportOptions.apiPort),
      verifyPort(shutdownReportOptions.uiPort),
    ]);
    const closeSummary = closeResults || {};
    const childProcessesClosed = childProcessCleanup.children.every((child) =>
      child.status === 'closed' && !child.stopFailureReason);
    const allChecksPassed = childProcessesClosed
      && closeSummary.apiClosed === true
      && closeSummary.viteClosed === true
      && closeSummary.databaseClosed === true
      && apiPortReleased === true
      && uiPortReleased === true;
    const shutdownReport = {
      result: allChecksPassed ? 'verified' : 'incomplete',
      harnessPid: dependencies.harnessPid === undefined ? process.pid : dependencies.harnessPid,
      childProcessCount: childProcessCleanup.children.length,
      childProcessesClosed,
      apiServerClosed: closeSummary.apiClosed ?? null,
      uiServerClosed: closeSummary.viteClosed ?? null,
      databaseClosed: closeSummary.databaseClosed ?? null,
      apiPortReleased,
      uiPortReleased,
      createdAt: new Date().toISOString(),
    };
    try {
      writeShutdownReport(
        shutdownReportOptions.isolation,
        shutdownReportOptions.reportPath,
        shutdownReport,
      );
      console.log(`[UI MEDIA SMOKE] Shutdown verification: ${shutdownReport.result}.`);
    } catch (error) {
      console.error(`[UI MEDIA SMOKE] Could not write shutdown report (${safeCleanupErrorCode(error, 'close-error')}).`);
      setExitCode(1);
    }
    if (!allChecksPassed) setExitCode(1);
    activeShutdownReportOptions = null;
  }
}

function installFatalHandlers(diagnostics) {
  const onFatal = () => {
    console.error('[UI MEDIA SMOKE] Uncaught harness exception; disposable root retained.');
    const shutdown = activeShutdown || (() => shutdownResources(1, 'uncaught-exception'));
    Promise.resolve(shutdown(1, 'uncaught-exception')).catch(() => {
      void closeActiveResources(1);
    });
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  return () => {
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  };
}

function installSignalHandlers(onStop) {
  const onSigint = () => { void onStop(130, 'graceful-shutdown'); };
  const onSigterm = () => { void onStop(143, 'graceful-shutdown'); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

async function listen(server, host) {
  server.listen(0, host);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server.address().port;
}

async function main() {
  assertEnvironment();
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error('Windows system root is unavailable');
  const nodeDirectory = path.dirname(process.execPath);
  const candidateRoot = path.join(os.tmpdir(), `bevhub-ui-media-smoke-${crypto.randomUUID()}`);
  disposableRootForFailure = candidateRoot;
  const isolation = createMediaSmokePlan({
    candidateRoot,
    env: process.env,
    cwd: PROJECT_ROOT,
    projectRoot: PROJECT_ROOT,
    execArgv: process.execArgv,
  }).isolation;
  const root = isolation.testRoot;
  const fixtureDir = path.join(root, 'fixtures');
  const tempDir = path.join(root, 'system-temp');
  const fixturePath = path.join(fixtureDir, 'synthetic.png');
  const manifestPath = path.join(root, 'manifest.json');
  const reportPath = path.join(root, 'report.json');
  isolation.assertPath(root);
  if (fs.existsSync(root)) throw new Error('Generated disposable root already exists');
  fs.mkdirSync(root);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Created disposable root is not a plain directory: ${root}`);
  }
  disposableRootCreated = true;
  const diagnostics = createUiMediaDiagnostics({ isolation, reportPath, disposableRoot: root });
  activeDiagnostics = diagnostics;
  activeShutdownReportOptions = {
    isolation,
    reportPath: path.join(root, 'shutdown-report.json'),
    apiPort: null,
    uiPort: null,
  };
  diagnostics.persist({ result: 'running', harnessPid: process.pid });
  activeRemoveFatalHandlers = installFatalHandlers(diagnostics);
  for (const directory of [
    path.dirname(isolation.paths.databaseFile),
    isolation.paths.uploadsDir,
    isolation.paths.imagesDir,
    isolation.paths.videosDir,
    isolation.paths.tmpDir,
    isolation.paths.audioDir,
    isolation.paths.backupDir,
    fixtureDir,
    tempDir,
  ]) {
    isolation.assertPath(directory);
    fs.mkdirSync(directory);
  }
  isolation.assertPath(fixturePath);
  const image = createSyntheticPng();
  fs.writeFileSync(fixturePath, image, { flag: 'wx' });
  replaceEnvironment({ systemRoot, nodeDirectory, testRoot: root });
  process.chdir(root);
  activeChildProcessRegistry = createChildProcessRegistry({
    childProcessApi: childProcess,
    syncBuiltinESMExports,
  });

  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    disposableRoot: root,
    databaseFile: isolation.paths.databaseFile,
    uploadsDir: isolation.paths.uploadsDir,
    tmpDir: isolation.paths.tmpDir,
    backupDir: isolation.paths.backupDir,
    fixtureImage: fixturePath,
    fixtureSizeBytes: image.length,
    productionServerImported: false,
    productionBootstrapImported: false,
    externalAiEnabled: false,
    ttsProvider: 'not-used',
    renderer: 'not-used',
    diagnosticOnly: true,
  };
  writeJson(isolation, manifestPath, manifest, { exclusive: true });

  const [database, authModule, media, content, rateModule, videoApi, generation] = await Promise.all([
    import('../server/db.js'),
    import('../server/auth.js'),
    import('../server/media.js'),
    import('../server/content.js'),
    import('../server/rate-limit.js'),
    import('../server/video-api.js'),
    import('../server/generation.js'),
  ]);
  if (media.TTS_MODE !== 'local') throw new Error('TTS did not initialize in local-only mode');
  if (path.resolve(media.FFMPEG_BIN).toLowerCase().includes(path.resolve(root).toLowerCase())) {
    throw new Error('FFmpeg path unexpectedly points into the disposable root');
  }

  const db = database.openDatabase(isolation.paths.databaseFile);
  activeDatabase = db;
  const auth = authModule.createAuth(db);
  const rate = rateModule.createRateLimiter(db);
  const queue = {
    enqueue() {},
    isActive() { return false; },
  };
  const generatedScript = async (input) => {
    const generated = content.generateTemplateScript(input);
    return {
      script: generated.script,
      source: {
        id: 'template',
        kind: 'template',
        provider: null,
        label: 'BevHub Engine (шаблон)',
        model: null,
        warning: generated.warning,
        reason: 'AI providers are disabled for this isolated run.',
      },
      attempts: [],
    };
  };
  let shuttingDown = false;
  let closeHarness;
  let shutdownRequested = false;
  const removeStopChannel = installStopChannel(() => {
    shutdownRequested = true;
    if (closeHarness) void closeHarness(130, 'graceful-shutdown');
  });
  activeRemoveStopChannel = removeStopChannel;
  const app = express();
  const completeVideoCreate = createVideoDiagnosticCompletion({
    diagnostics,
    onComplete: () => {
      if (closeHarness) {
        void closeHarness(0, null).catch((error) => {
          console.error(`[UI MEDIA SMOKE] Diagnostic shutdown failed (${safeCleanupErrorCode(error, 'close-error')}).`);
          process.exitCode = 1;
          void closeActiveResources(1);
        });
      }
    },
  });
  trackApiRequests(
    app,
    diagnostics,
    db,
    () => shuttingDown,
    completeVideoCreate,
  );
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      ttsMode: 'local',
      maleVoiceLanguages: [],
      aiActive: false,
      aiProviders: [],
      ttsProviders: [{ id: 'windows-sapi', languages: ['ru'], configured: true, available: true }],
    });
  });
  app.get('/api/__smoke/image.png', (_req, res) => {
    isolation.assertPath(fixturePath);
    res.type('image/png').sendFile(fixturePath);
  });
  app.use('/api/auth', auth.router);
  app.use('/api', auth.requireAuth);
  captureVideoCreatePayload(app, db, isolation.paths.imagesDir, isolation, () => shuttingDown);
  app.get('/api/dashboard', (req, res) => {
    const workspaceId = req.workspace.id;
    const { subscription, usage } = videoApi.workspaceUsage(db, workspaceId);
    const videos = db
      .prepare(`${videoApi.VIDEO_SELECT} WHERE v.workspace_id = ? ORDER BY v.created_at DESC LIMIT 10`)
      .all(workspaceId)
      .map(videoApi.serializeVideo);
    const projectsCount = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ?').get(workspaceId).count;
    const totalVideos = db.prepare('SELECT COUNT(*) AS count FROM videos WHERE workspace_id = ?').get(workspaceId).count;
    res.json({ subscription, usage, videos, totalVideos, projectsCount });
  });
  app.use(
    '/api',
    videoApi.createVideoApiRouter({
      db,
      queue,
      rate,
      imagesDir: isolation.paths.imagesDir,
      videosDir: isolation.paths.videosDir,
      cleanText: media.cleanText,
      detectImageType: media.detectImageType,
      validateImageDecodes: media.validateImageDecodes,
      generateScript: generatedScript,
      isAiActive: () => false,
      maleVoiceAvailable: media.maleVoiceAvailable,
      LANGUAGES: media.LANGUAGES,
      STYLES: media.STYLES,
      CATEGORIES: media.CATEGORIES,
      normalizeUzbekText: media.normalizeUzbekText,
      detectLanguage: media.detectLanguage,
      detectCategory: media.detectCategory,
      pickStyle: media.pickStyle,
      defaultCta: media.defaultCta,
      interruptedMessage: generation.INTERRUPTED_MESSAGE,
    }),
  );
  app.use((err, _req, res, _next) => {
    console.error(`[UI MEDIA SMOKE] API error (${err.status || 500}): ${err.code || 'synthetic-api-error'}`);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Synthetic harness error' });
  });

  const apiServer = createServer(app);
  activeApiServer = apiServer;
  const apiPort = await listen(apiServer, '127.0.0.1');
  activeShutdownReportOptions.apiPort = apiPort;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  process.env.API_PROXY_TARGET = apiOrigin;
  const [viteModule, tailwindModule, autoprefixerModule] = await Promise.all([
    import('vite'),
    import('tailwindcss'),
    import('autoprefixer'),
  ]);
  const vite = await viteModule.createServer({
    root: PROJECT_ROOT,
    envDir: root,
    cacheDir: path.join(root, '.vite-cache'),
    clearScreen: false,
    logLevel: 'error',
    plugins: [uiRequestDiagnosticsPlugin(diagnostics)],
    css: {
      postcss: {
        plugins: [
          tailwindModule.default({ config: path.join(PROJECT_ROOT, 'tailwind.config.js') }),
          autoprefixerModule.default(),
        ],
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  });
  activeViteServer = vite;
  await vite.listen();
  const uiUrl = vite.resolvedUrls?.local?.[0];
  if (!uiUrl) throw new Error('Vite did not provide a local UI URL');
  activeShutdownReportOptions.uiPort = Number(new URL(uiUrl).port) || null;

  writeJson(isolation, manifestPath, { ...manifest, apiOrigin, uiUrl });
  console.log('[UI MEDIA SMOKE] Isolated UI and API harness is ready.');
  console.log(`[UI MEDIA SMOKE] UI: ${uiUrl}`);
  console.log(`[UI MEDIA SMOKE] Register a synthetic user in the UI; no account was pre-created.`);
  console.log(`[UI MEDIA SMOKE] API: ${apiOrigin} (loopback only; Vite proxy)`);
  console.log(`[UI MEDIA SMOKE] Disposable root: ${root}`);
  console.log('[UI MEDIA SMOKE] Create a project in the UI, then create a video and upload the supplied image:');
  console.log(`[UI MEDIA SMOKE] ${apiOrigin}/api/__smoke/image.png`);
  console.log('[UI MEDIA SMOKE] AI providers are disabled. Script generation uses the offline template; the video queue is disabled for this diagnostic run.');
  diagnostics.setStage('harness-ready');

  let reportComplete = false;
  let checking = false;
  let monitor = null;
  let overallTimeout = null;

  closeHarness = createIdempotentShutdown(async (exitCode = 0, reason = exitCode === 0 ? null : 'harness-stopped') => {
    shuttingDown = true;
    clearInterval(monitor);
    clearTimeout(overallTimeout);
    const result = exitCode === 0 ? (reportComplete ? 'video-rendered' : 'completed') : 'failed';
    await shutdownResources(exitCode, reason, result);
    console.log(`[UI MEDIA SMOKE] Diagnostic report: ${reportPath}`);
    console.log(`[UI MEDIA SMOKE] Shutdown report: ${path.join(root, 'shutdown-report.json')}`);
    console.log(`[UI MEDIA SMOKE] Disposable root retained: ${root}`);
  });
  activeShutdown = closeHarness;
  activeRemoveSignalHandlers = installSignalHandlers(closeHarness);

  async function makeFinalReport(video, job) {
    if (shuttingDown) return;
    const outputPath = isolation.assertPath(path.join(isolation.paths.videosDir, video.video_file));
    const expectedPath = path.resolve(path.join(isolation.paths.videosDir, `${video.id}.mp4`));
    if (path.resolve(outputPath) !== expectedPath) throw new Error('Published MP4 is not at the expected synthetic path');
    const fileStat = fs.statSync(outputPath);
    if (!fileStat.isFile() || fileStat.size < 20 * 1024) throw new Error('Rendered MP4 is missing or unexpectedly small');
    const probeResult = await execFileAsync(
      media.FFPROBE_BIN,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath],
      { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    if (shuttingDown) return;
    const probe = JSON.parse(probeResult.stdout);
    const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = probe.streams?.find((stream) => stream.codec_type === 'audio');
    const durationSec = Number(probe.format?.duration || 0);
    if (videoStream?.codec_name !== 'h264') throw new Error('FFprobe did not confirm an H.264 video stream');
    if (audioStream?.codec_name !== 'aac') throw new Error('FFprobe did not confirm an AAC audio stream');
    if (videoStream.width !== 1080 || videoStream.height !== 1920) throw new Error('FFprobe reported unexpected video dimensions');
    if (!Number.isFinite(durationSec) || durationSec < 14 || durationSec > 16) throw new Error(`Unexpected video duration: ${durationSec}`);
    const report = {
      result: 'video-rendered',
      createdAt: new Date().toISOString(),
      disposableRoot: root,
      projectId: video.project_id,
      videoId: video.id,
      script: safeScriptSummary(video),
      tts: {
        kind: video.audio_kind,
        voiceLanguage: video.voice_language,
        exactLanguage: Boolean(video.voice_exact),
        status: video.audio_kind === 'tts-windows-sapi' ? 'verified' : 'unexpected-provider',
      },
      rendering: { status: 'verified', renderer: 'bundled-ffmpeg' },
      mp4Path: outputPath,
      sizeBytes: fileStat.size,
      sha256: sha256File(outputPath),
      durationSec,
      resolution: `${videoStream.width}x${videoStream.height}`,
      videoCodec: videoStream.codec_name,
      audioCodec: audioStream.codec_name,
      generationStatus: video.status,
      jobStatus: job?.status || null,
      httpDownload: { ...diagnostics.state.httpDownload },
      requests: diagnostics.state.requests.slice(),
      apiDownloadEndpointTested: diagnostics.state.httpDownload.getStatus === 200,
    };
    if (report.tts.status !== 'verified' || report.generationStatus !== 'completed' || report.jobStatus !== 'completed') {
      throw new Error('Generation did not complete with the expected local SAPI voice');
    }
    diagnostics.setVideoId(video.id);
    diagnostics.setJobStatus(job?.status);
    diagnostics.persist(report);
    console.log('[UI MEDIA SMOKE] Generation verified by the UI and FFprobe:');
    console.log(JSON.stringify(report, null, 2));
    reportComplete = true;
  }

  async function inspectGeneration() {
    if (checking || shuttingDown) return;
    checking = true;
    try {
      const video = db.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT 1').get();
      if (!video) return;
      const job = db.prepare('SELECT * FROM generation_jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1').get(video.id);
      diagnostics.setVideoId(video.id);
      diagnostics.setJobStatus(job?.status);
      if (video.status === 'failed' || job?.status === 'failed') {
        diagnostics.setFailure('generation-failed', 'job-failed');
        console.error('[UI MEDIA SMOKE] Generation failed.');
        console.error(`[UI MEDIA SMOKE] Disposable root retained: ${root}`);
        await closeHarness(1, 'generation-failed');
        return;
      }
      if (video.status === 'completed' && job?.status === 'completed' && !reportComplete) {
        await makeFinalReport(video, job);
      }
      if (shuttingDown) return;
      if (reportComplete && diagnostics.state.httpDownload.getStatus === 200) {
        diagnostics.persist({
          result: 'video-rendered',
          apiDownloadEndpointTested: true,
        });
        console.log(`[UI MEDIA SMOKE] UI-triggered HTTP download verified; report: ${reportPath}`);
        await closeHarness(0, null);
      }
    } catch (error) {
      if (shuttingDown) return;
      console.error(`[UI MEDIA SMOKE] Verification failed: ${error.code || 'verification-error'}`);
      console.error(`[UI MEDIA SMOKE] Disposable root retained: ${root}`);
      try {
        diagnostics.setFailure('verification-failed', 'verification-failed');
      } catch (writeError) {
        console.error(`[UI MEDIA SMOKE] Could not write report (${writeError.code || writeError.message}); root: ${root}`);
      }
      await closeHarness(1, 'verification-failed');
    } finally {
      checking = false;
    }
  }

  monitor = setInterval(() => {
    inspectGeneration().catch((error) => {
      if (shuttingDown) return;
      console.error(`[UI MEDIA SMOKE] Monitor failed: ${error.code || 'monitor-error'}`);
      try {
        diagnostics.setFailure('monitor-failed', 'monitor-failed');
      } catch (reportError) {
        console.error(`[UI MEDIA SMOKE] Could not update report (${reportError.code || 'write-error'}); root: ${root}`);
      }
    });
  }, 1000);
  monitor.unref();
  overallTimeout = setTimeout(() => {
    console.error(`[UI MEDIA SMOKE] Timed out; disposable root retained: ${root}`);
    void closeHarness(1, 'timeout');
  }, 20 * 60 * 1000);
  overallTimeout.unref();
  if (shutdownRequested) await closeHarness(130, 'graceful-shutdown');
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  try {
    await main();
  } catch (error) {
    console.error(`[UI MEDIA SMOKE] Harness failed (${error.code || 'harness-error'}).`);
    if (activeDiagnostics) {
      try {
        activeDiagnostics.setFailure('harness-startup-failed', 'harness-startup-failed');
      } catch (writeError) {
        console.error(`[UI MEDIA SMOKE] Could not update report (${writeError.code || 'write-error'}).`);
      }
    }
    if (activeShutdown) {
      try {
        await activeShutdown(1, 'harness-startup-failed');
      } catch {
        await closeActiveResources(1);
      }
    } else {
      await shutdownResources(1, 'harness-startup-failed');
    }
    if (disposableRootForFailure) {
      reportSmokeFailure(disposableRootForFailure, { rootCreated: disposableRootCreated });
    }
    process.exitCode = 1;
  }
}
