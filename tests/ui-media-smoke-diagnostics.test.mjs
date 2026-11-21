import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  createChildProcessRegistry,
  createIdempotentShutdown,
  createStopCommandParser,
  createVideoDiagnosticCompletion,
  createUiMediaDiagnostics,
  safeEndpointLabel,
  safeScriptSummary,
  summarizeVideoCreatePayload,
  summarizeVideoCreateResponse,
  verifyLoopbackPortReleased,
  writeAtomicReport,
  writeShutdownReport,
} from '../scripts/ui-media-smoke-diagnostics.mjs';
import {
  closeActiveResources,
  inspectVideoFiles,
  shutdownResources,
} from '../scripts/ui-media-smoke.mjs';

function createFixture(t, fileSystem = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bevhub-ui-diagnostics-'));
  const reportPath = path.join(root, 'report.json');
  const isolation = {
    assertPath(candidate) {
      const resolved = path.resolve(candidate);
      const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('path is outside disposable root');
      }
      return resolved;
    },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    reportPath,
    isolation,
    diagnostics: createUiMediaDiagnostics({ isolation, reportPath, disposableRoot: root, fileSystem }),
  };
}

function readReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

test('timeout before registration persists stage and empty registration/user state', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.recordRequest({ method: 'GET', url: '/src/main.tsx', source: 'UI' });
  diagnostics.setFailure('timeout', 'harness-ready');

  const report = readReport(reportPath);
  assert.equal(report.failureReason, 'timeout');
  assert.equal(report.lastStage, 'harness-ready');
  assert.equal(report.registrationSent, false);
  assert.equal(report.registrationStatus, null);
  assert.equal(report.syntheticUserCreated, false);
  assert.equal(report.userId, null);
  assert.equal(report.videoId, null);
  assert.equal(report.lastJobStatus, null);
  assert.equal(report.requests[0].source, 'UI');
  assert.equal(report.requests[0].status, null);
});

test('registration API error stores status and a safe response without credentials', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.markRegistrationSent();
  diagnostics.recordRequest({
    method: 'POST',
    url: '/api/auth/register?password=secret-pass&token=secret-token',
    status: 400,
    source: 'API',
  });
  diagnostics.completeRegistration(
    400,
    { error: 'Некорректный email', password: 'secret-pass', token: 'secret-token' },
    null,
  );
  diagnostics.persist({ result: 'failed' });

  const serialized = fs.readFileSync(reportPath, 'utf8');
  const report = JSON.parse(serialized);
  assert.equal(report.registrationSent, true);
  assert.equal(report.registrationStatus, 400);
  assert.deepEqual(report.safeRegistrationResponse, { category: 'rejected', message: 'Некорректный email' });
  assert.equal(report.syntheticUserCreated, false);
  assert.equal(report.requests[0].status, 400);
  assert.doesNotMatch(serialized, /secret-pass|secret-token/);
});

test('successful registration records the synthetic user without copying the response body', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.markRegistrationSent();
  diagnostics.completeRegistration(201, {
    user: { id: 'public-user-id', email: 'synthetic@example.test' },
    token: 'secret-token',
  }, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

  const serialized = fs.readFileSync(reportPath, 'utf8');
  const report = JSON.parse(serialized);
  assert.equal(report.registrationStatus, 201);
  assert.deepEqual(report.safeRegistrationResponse, { category: 'accepted' });
  assert.equal(report.syntheticUserCreated, true);
  assert.equal(report.userId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.doesNotMatch(serialized, /synthetic@example\.test|secret-token/);
});

test('video creation persists the synthetic video ID', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.setVideoId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

  const report = readReport(reportPath);
  assert.equal(report.videoId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(report.lastStage, 'video-created');
});

test('completed job status is persisted as the latest status', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.setJobStatus('processing');
  diagnostics.setJobStatus('completed');

  const report = readReport(reportPath);
  assert.equal(report.lastJobStatus, 'completed');
  assert.equal(report.lastStage, 'job-completed');
  assert.equal(report.failureReason, null);
});

test('HTTP download records the request and successful GET status', (t) => {
  const { root, diagnostics, reportPath } = createFixture(t);
  const videoId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  diagnostics.persist({
    result: 'video-rendered',
    mp4Path: path.join(root, 'uploads', 'videos', `${videoId}.mp4`),
  });
  const request = diagnostics.recordRequest({
    method: 'GET',
    url: `/api/videos/${videoId}/file?download=1`,
    source: 'API',
  });
  diagnostics.setRequestStatus(request, 200);
  diagnostics.setDownloadStatus('GET', 200);
  diagnostics.persist({ apiDownloadEndpointTested: true });

  const report = readReport(reportPath);
  assert.equal(report.result, 'video-rendered');
  assert.equal(report.mp4Path, path.join(root, 'uploads', 'videos', `${videoId}.mp4`));
  assert.equal(report.apiDownloadEndpointTested, true);
  assert.equal(report.httpDownload.getStatus, 200);
  assert.equal(report.lastStage, 'http-download-completed');
  assert.equal(report.requests[0].method, 'GET');
  assert.equal(report.requests[0].endpoint, 'api.videos.file');
  assert.equal(report.requests[0].status, 200);
  assert.equal(report.requests[0].source, 'API');
});

test('diagnostic endpoints omit query values, URL credentials, and secret path segments', () => {
  assert.equal(
    safeEndpointLabel('https://user:pass@example.test/api/videos/secret-token/file?token=abc', 'API'),
    'api.videos.file',
  );
  assert.equal(safeEndpointLabel('/api/reset/secret-token', 'API'), 'api.other');
  assert.equal(safeEndpointLabel('/videos/secret-token', 'UI'), 'ui.video-detail');
});

test('HTTP journal updates in-flight status and preserves source and timestamp', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  const request = diagnostics.recordRequest({
    method: 'GET',
    url: '/api/health?probe=1',
    source: 'API',
  });
  diagnostics.setRequestStatus(request, 200);
  diagnostics.persist();

  const event = readReport(reportPath).requests[0];
  assert.equal(event.method, 'GET');
  assert.equal(event.endpoint, 'api.health');
  assert.equal(event.status, 200);
  assert.equal(event.source, 'API');
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('HTTP journal replaces unrecognized method values with a safe label', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.recordRequest({
    method: 'X-SECRET-CREDENTIAL',
    url: '/api/health',
    source: 'API',
  });
  diagnostics.persist();

  const serialized = fs.readFileSync(reportPath, 'utf8');
  assert.equal(readReport(reportPath).requests[0].method, 'OTHER');
  assert.doesNotMatch(serialized, /X-SECRET-CREDENTIAL/);
});

test('late callbacks cannot mutate or rewrite the finalized report', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.persist({ result: 'running' });
  diagnostics.beginShutdown({ failureReason: 'timeout', lastStage: 'harness-ready' });
  diagnostics.finalize({ result: 'completed' });
  const finalized = fs.readFileSync(reportPath, 'utf8');

  diagnostics.setFailure('late-error', 'late-callback');
  diagnostics.markRegistrationSent();
  diagnostics.completeRegistration(201, { token: 'late-secret' }, { id: 'late-user' });
  diagnostics.setVideoId('late-video');
  diagnostics.setJobStatus('completed');
  diagnostics.recordRequest({ method: 'POST', url: '/api/auth/register?token=late-secret', source: 'API' });
  diagnostics.persist({ result: 'late-update' });

  assert.equal(fs.readFileSync(reportPath, 'utf8'), finalized);
  assert.equal(diagnostics.state.failureReason, 'timeout');
  assert.equal(diagnostics.state.videoId, null);
  assert.equal(diagnostics.state.requests.length, 0);
});

test('repeated shutdown finalizes report only once', async (t) => {
  let renames = 0;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (...args) => {
          renames++;
          return target.renameSync(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { diagnostics } = createFixture(t, fileSystem);
  const shutdown = createIdempotentShutdown(async () => {
    diagnostics.beginShutdown();
    diagnostics.finalize({ result: 'completed' });
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await shutdown();

  assert.equal(renames, 1);
});

test('report keeps only metadata for hook, body, and cta', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  const reportValues = {
    script: safeScriptSummary({
      script_source: 'template',
      script_hook: 'hook-secret-value',
      script_body: 'body-secret-value',
      script_cta: 'cta-secret-value',
    }),
  };
  diagnostics.persist(reportValues);

  const serialized = fs.readFileSync(reportPath, 'utf8');
  const report = JSON.parse(serialized);
  assert.deepEqual(report.script, {
    source: 'template',
    hook: { present: true, type: 'string', length: 17 },
    body: { present: true, type: 'string', length: 17 },
    cta: { present: true, type: 'string', length: 16 },
  });
  assert.doesNotMatch(serialized, /hook-secret-value|body-secret-value|cta-secret-value/);
});

test('atomic report replacement preserves the previous report on rename failure', (t) => {
  const { isolation, reportPath } = createFixture(t);
  writeAtomicReport(isolation, reportPath, { version: 1 });
  writeAtomicReport(isolation, reportPath, { version: 2 });
  const failingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return () => {
          throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.throws(
    () => writeAtomicReport(isolation, reportPath, { version: 3 }, { fileSystem: failingFileSystem }),
    { code: 'EIO' },
  );
  assert.deepEqual(readReport(reportPath), { version: 2 });
});

test('report writer rejects paths outside the disposable root', (t) => {
  const { root, isolation } = createFixture(t);
  const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);

  assert.throws(() => writeAtomicReport(isolation, outsidePath, { result: 'invalid' }), /outside disposable root/);
  assert.equal(fs.existsSync(outsidePath), false);
});

test('stop command parser waits for a complete line and triggers shutdown once', () => {
  let stopCalls = 0;
  const parser = createStopCommandParser(() => { stopCalls++; });

  parser('__UI_MEDIA_SMOKE_STOP__\r');
  assert.equal(stopCalls, 0);
  parser('\n__UI_MEDIA_SMOKE_STOP__\n');
  parser('__UI_MEDIA_SMOKE_STOP__\n');

  assert.equal(stopCalls, 1);
});

test('closeActiveResources continues API and DB cleanup after a Vite close timeout', async () => {
  const operations = [];
  const logs = [];
  await closeActiveResources(0, {
    closeTimeoutMs: 5,
    closeVite: () => {
      operations.push('vite');
      return new Promise(() => {});
    },
    closeAllApiConnections: () => operations.push('api-connections'),
    closeApi: () => operations.push('api'),
    closeDatabase: () => operations.push('database'),
    removeStopChannel: () => operations.push('stdin-listener'),
    restoreChildProcessHooks: () => operations.push('child-process-hooks'),
    removeSignalHandlers: () => operations.push('signal-listeners'),
    removeFatalHandlers: () => operations.push('fatal-listeners'),
    setExitCode: (code) => operations.push(`exit-${code}`),
    log: (message) => logs.push(message),
  });

  assert.deepEqual(operations, [
    'vite',
    'api-connections',
    'api',
    'database',
    'stdin-listener',
    'child-process-hooks',
    'signal-listeners',
    'fatal-listeners',
    'exit-0',
  ]);
  assert.match(logs[0], /ETIMEDOUT.*resource may still be active/);
});

test('closeActiveResources continues DB cleanup after an API close timeout', async () => {
  const operations = [];
  const logs = [];
  await closeActiveResources(0, {
    closeTimeoutMs: 5,
    closeVite: () => operations.push('vite'),
    closeAllApiConnections: () => operations.push('api-connections'),
    closeApi: () => {
      operations.push('api');
      return new Promise(() => {});
    },
    closeDatabase: () => operations.push('database'),
    log: (message) => logs.push(message),
  });

  assert.deepEqual(operations, ['vite', 'api-connections', 'api', 'database']);
  assert.match(logs[0], /API server close wait timed out \(ETIMEDOUT\)/);
});

test('closeActiveResources attempts later cleanup after one resource throws', async () => {
  const operations = [];
  const logs = [];
  await closeActiveResources(0, {
    closeTimeoutMs: 10,
    closeVite: () => {
      operations.push('vite');
      throw Object.assign(new Error('secret error detail'), { code: 'SECRET_PATH_TOKEN' });
    },
    closeAllApiConnections: () => {
      operations.push('api-connections');
      throw Object.assign(new Error('secret connection detail'), { code: 'EPIPE' });
    },
    closeApi: () => operations.push('api'),
    closeDatabase: () => operations.push('database'),
    removeStopChannel: () => operations.push('stdin-listener'),
    restoreChildProcessHooks: () => operations.push('child-process-hooks'),
    removeSignalHandlers: () => operations.push('signal-listeners'),
    removeFatalHandlers: () => operations.push('fatal-listeners'),
    setExitCode: (code) => operations.push(`exit-${code}`),
    log: (message) => logs.push(message),
  });

  assert.deepEqual(operations, [
    'vite',
    'api-connections',
    'api',
    'database',
    'stdin-listener',
    'child-process-hooks',
    'signal-listeners',
    'fatal-listeners',
    'exit-0',
  ]);
  assert.equal(logs.some((message) => message.includes('SECRET_PATH_TOKEN')), false);
  assert.equal(logs.some((message) => message.includes('secret error detail')), false);
  assert.equal(logs.some((message) => message.includes('EPIPE')), true);
});

test('closeActiveResources releases every listener and hook even when logging throws', async () => {
  const operations = [];
  await closeActiveResources(1, {
    closeTimeoutMs: 5,
    closeVite: () => {
      operations.push('vite');
      return new Promise(() => {});
    },
    closeAllApiConnections: () => operations.push('api-connections'),
    closeApi: () => operations.push('api'),
    closeDatabase: () => {
      operations.push('database');
      throw Object.assign(new Error('db detail'), { code: 'EBUSY' });
    },
    removeStopChannel: () => operations.push('stdin-listener'),
    restoreChildProcessHooks: () => operations.push('child-process-hooks'),
    removeSignalHandlers: () => operations.push('signal-listeners'),
    removeFatalHandlers: () => operations.push('fatal-listeners'),
    setExitCode: (code) => operations.push(`exit-${code}`),
    log: () => {
      throw new Error('logger detail');
    },
  });

  assert.deepEqual(operations, [
    'vite',
    'api-connections',
    'api',
    'database',
    'stdin-listener',
    'child-process-hooks',
    'signal-listeners',
    'fatal-listeners',
    'exit-1',
  ]);
});

test('shutdownResources freezes, finalizes, then closes injected fake resources', async (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  const operations = [];
  diagnostics.persist({ result: 'running', harnessPid: 12345 });
  const childProcessRegistry = {
    async stopOwnedChildren() {
      operations.push('children');
      assert.equal(diagnostics.setFailure('timeout', 'harness-ready'), false);
      return { children: [], blockedLaunches: [] };
    },
  };
  await shutdownResources(0, null, 'completed', {
    diagnostics,
    childProcessRegistry,
    harnessPid: 12345,
    closeActions: {
      closeTimeoutMs: 10,
      closeVite: () => {
        operations.push('vite');
        assert.equal(readReport(reportPath).result, 'completed');
      },
      closeApi: () => operations.push('api'),
      closeDatabase: () => operations.push('database'),
      log() {},
    },
  });

  assert.deepEqual(operations, ['children', 'vite', 'api', 'database']);
  assert.equal(readReport(reportPath).lastStage, 'completed');
  assert.equal(diagnostics.setStage('completed'), false);
});

test('persist rejects fields outside the report allowlist', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  assert.throws(() => diagnostics.persist({ stack: 'private stack value' }), /unsupported report field/);
  assert.equal(fs.existsSync(reportPath), false);
});

test('finalize rejects arbitrary fields without locking out a valid final report', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.beginShutdown();
  assert.throws(() => diagnostics.finalize({ environment: { TOKEN: 'private' } }), /unsupported report field/);
  diagnostics.finalize({ result: 'completed', harnessPid: 12345 });

  const serialized = fs.readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(serialized, /private|TOKEN|environment/);
  assert.equal(readReport(reportPath).result, 'completed');
});

test('cleanupError and lastJobStatus accept only safe enum values', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  assert.throws(() => diagnostics.setJobStatus('secret-job-status'), /invalid generation job status/);
  assert.throws(
    () => diagnostics.persist({
      childProcessCleanup: { children: [], blockedLaunches: [], cleanupError: 'SECRET_TOKEN' },
    }),
    /invalid report field: childProcessCleanup/,
  );
  diagnostics.setJobStatus('processing');
  diagnostics.persist({
    childProcessCleanup: {
      children: [],
      blockedLaunches: [],
      cleanupError: 'child-process-cleanup-failed',
    },
  });

  const serialized = fs.readFileSync(reportPath, 'utf8');
  assert.equal(readReport(reportPath).lastJobStatus, 'processing');
  assert.doesNotMatch(serialized, /secret-job-status|SECRET_TOKEN/);
});

test('allowlisted report fields still reject values outside their enum', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  assert.throws(
    () => diagnostics.persist({ jobStatus: 'secret-job-value' }),
    /invalid report field: jobStatus/,
  );
  assert.throws(
    () => diagnostics.persist({ result: 'arbitrary-result' }),
    /invalid report field: result/,
  );
  assert.throws(
    () => diagnostics.persist({ lastJobStatus: 'secret-job-status' }),
    /unsupported report field: lastJobStatus/,
  );
  assert.throws(
    () => diagnostics.finalize({ lastStage: 'harness-ready', failureReason: 'private failure text' }),
    /unsupported report field: (lastStage|failureReason)/,
  );
  assert.equal(fs.existsSync(reportPath), false);
});

test('unrecognized request methods collapse to the neutral OTHER label in the report', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.recordRequest({
    method: 'X-SECRET-CREDENTIAL',
    url: '/api/health',
    source: 'API',
  });
  diagnostics.persist();

  const serialized = fs.readFileSync(reportPath, 'utf8');
  assert.equal(readReport(reportPath).requests[0].method, 'OTHER');
  assert.doesNotMatch(serialized, /X-SECRET-CREDENTIAL/);
});

test('child-process cleanup signals only PIDs registered through the harness registry', async () => {
  const killedPids = [];
  const ownedChild = new EventEmitter();
  ownedChild.pid = 7301;
  ownedChild.kill = (signal) => {
    killedPids.push({ pid: ownedChild.pid, signal });
    ownedChild.emit('close', 0, signal);
    return true;
  };
  const unrelatedChild = new EventEmitter();
  unrelatedChild.pid = 8402;
  unrelatedChild.kill = () => {
    killedPids.push({ pid: unrelatedChild.pid, signal: 'unexpected' });
    return true;
  };
  const childProcessApi = {
    spawn: () => ownedChild,
    exec: () => ownedChild,
    execFile: () => ownedChild,
    fork: () => ownedChild,
  };
  const originalSpawn = childProcessApi.spawn;
  const registry = createChildProcessRegistry({
    childProcessApi,
    syncBuiltinESMExports() {},
    stopTimeoutMs: 10,
    forceStopTimeoutMs: 10,
  });

  childProcessApi.spawn('ffmpeg.exe');
  const summary = await registry.stopOwnedChildren();
  assert.deepEqual(killedPids, [{ pid: 7301, signal: 'SIGTERM' }]);
  assert.equal(summary.children.length, 1);
  assert.equal(summary.children[0].pid, 7301);
  assert.equal(summary.children[0].status, 'closed');
  assert.equal(unrelatedChild.pid, 8402);
  assert.throws(() => childProcessApi.spawn('powershell.exe -Command secret'), { code: 'ERR_HARNESS_SHUTTING_DOWN' });
  assert.equal(registry.snapshot().blockedLaunches[0].command, 'powershell');

  registry.restore();
  assert.equal(childProcessApi.spawn, originalSpawn);
});

test('child-process timeout report identifies only the registered PID and stop failure', async () => {
  const ownedChild = new EventEmitter();
  ownedChild.pid = 7301;
  const signals = [];
  ownedChild.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') ownedChild.emit('close', null, signal);
    return true;
  };
  const childProcessApi = { spawn: () => ownedChild };
  const registry = createChildProcessRegistry({
    childProcessApi,
    syncBuiltinESMExports() {},
    stopTimeoutMs: 1,
    forceStopTimeoutMs: 10,
  });

  childProcessApi.spawn('ffmpeg.exe');
  const summary = await registry.stopOwnedChildren();

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(
    summary.children.map(({ pid, stopFailureReason }) => ({ pid, stopFailureReason })),
    [{ pid: 7301, stopFailureReason: 'graceful-stop-timeout' }],
  );
  registry.restore();
});

test('PowerShell stop helper handles stdin IOException with a bounded wait', (t) => {
  const launcherPath = fileURLToPath(new URL('../scripts/run-ui-media-smoke.ps1', import.meta.url));
  const source = fs.readFileSync(launcherPath, 'utf8');

  assert.match(source, /catch \[System\.IO\.IOException\]/);
  assert.match(source, /WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.match(source, /return \$Process\.ExitCode/);
  assert.match(source, /did not exit within/);
  assert.match(source, /exit \$exitCode/);
  assert.doesNotMatch(source, /taskkill\s+\/IM|Stop-Process\s+-Name/i);

  if (process.platform !== 'win32') {
    t.skip('PowerShell helper runtime test requires Windows');
    return;
  }
  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const scriptPath = launcherPath.replace(/'/g, "''");
  const command = `. '${scriptPath}'
$serverPipe = [System.IO.Pipes.AnonymousPipeServerStream]::new([System.IO.Pipes.PipeDirection]::Out)
$clientPipe = [System.IO.Pipes.AnonymousPipeClientStream]::new([System.IO.Pipes.PipeDirection]::In, $serverPipe.ClientSafePipeHandle)
$clientPipe.Dispose()
$fakeInput = New-Object System.IO.StreamWriter($serverPipe)
$fakeProcess = [pscustomobject]@{ HasExited = $false; WaitTimeout = 0; Id = 4321; ExitCode = 23; StandardInput = $fakeInput }
$fakeProcess | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($timeout); $this.WaitTimeout = $timeout; $this.HasExited = $true; return $true }
$result = Stop-NodeChildProcess -Process $fakeProcess
if ($result -ne 23 -or $fakeProcess.WaitTimeout -ne 15000) { exit 7 }
[Console]::Out.WriteLine("PASS")`;
  const output = execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.match(output, /PASS/);
});

test('diagnostics module import has no server, database, or process-launch side effects', async () => {
  const moduleUrl = new URL('../scripts/ui-media-smoke-diagnostics.mjs', import.meta.url);
  const source = fs.readFileSync(fileURLToPath(moduleUrl), 'utf8');

  assert.doesNotMatch(source, /^(?:openDatabase|spawn|execFile)\s*\(/m);
  const originalCreateServer = net.createServer;
  let serverCreations = 0;
  net.createServer = (...args) => {
    serverCreations++;
    return originalCreateServer(...args);
  };
  try {
    await import(new URL(`${moduleUrl.href}?side-effect-check=${Date.now()}`));
  } finally {
    net.createServer = originalCreateServer;
  }
  assert.equal(serverCreations, 0);
});

test('video payload diagnostics retain only allowlisted metadata', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  const imageId = '11111111-1111-4111-8111-111111111111';
  const payload = {
    clientRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    productName: 'private product text',
    description: 'private description text',
    price: 'private price',
    cta: 'private call to action',
    websiteUrl: 'https://example.test/private-path?token=private-token',
    language: 'ru',
    style: 'product',
    voiceType: 'female',
    category: 'food',
    fileIds: [imageId, 'private-file-id'],
    script: {
      hook: 'private hook',
      benefit1: 'private benefit one',
      benefit2: 'private benefit two',
      cta: 'private script CTA',
    },
    scriptSource: 'template',
  };
  const payloadSummary = summarizeVideoCreatePayload(payload, [
    { workspaceOwned: true, presentOnDisk: true },
    { workspaceOwned: false, presentOnDisk: false },
  ], 'checked');
  const response = summarizeVideoCreateResponse(
    400,
    'application/json; charset=utf-8',
    { error: 'Фото не найдено. Загрузите его заново.' },
    payloadSummary,
  );
  diagnostics.setVideoCreationResult(response);

  const serialized = fs.readFileSync(reportPath, 'utf8');
  const videoCreation = readReport(reportPath).videoCreation;
  assert.equal(videoCreation.status, 400);
  assert.equal(videoCreation.contentType, 'application/json');
  assert.deepEqual(videoCreation.response, {
    category: 'rejected',
    error: 'Фото не найдено. Загрузите его заново.',
  });
  assert.deepEqual(videoCreation.payload.clientRequestId, { present: true, validUuid: true });
  assert.equal(videoCreation.payload.projectId, 'present');
  assert.equal(videoCreation.payload.productName.length, payload.productName.length);
  assert.equal(videoCreation.payload.description.length, payload.description.length);
  assert.deepEqual(videoCreation.payload.websiteUrl, { present: true, valid: true });
  assert.deepEqual(videoCreation.payload.fileIds, {
    count: 2,
    allUuid: false,
    workspaceOwnedCount: 1,
    presentOnDiskCount: 1,
    checkState: 'checked',
  });
  assert.deepEqual(videoCreation.payload.script, {
    present: true,
    hook: true,
    benefit1: true,
    benefit2: true,
    cta: true,
  });
  assert.doesNotMatch(
    serialized,
    /private product text|private description text|private price|private call to action|private-token|private-file-id|private hook|private benefit|private script CTA/,
  );
});

test('unknown video response text is omitted while status and content type are retained', () => {
  const result = summarizeVideoCreateResponse(
    500,
    'text/html; charset=utf-8',
    { error: 'secret response value and token' },
  );

  assert.deepEqual(result, {
    status: 500,
    contentType: 'text/html',
    response: { category: 'unrecognized', error: null },
    payload: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret response value|token/);
});

test('the first completed video diagnostic persists before triggering stop exactly once', (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  let stopCalls = 0;
  const complete = createVideoDiagnosticCompletion({
    diagnostics,
    onComplete: () => { stopCalls++; },
  });
  const result = summarizeVideoCreateResponse(400, 'application/json', {
    error: 'Укажите название товара',
  });

  assert.equal(complete(result), true);
  assert.equal(complete(result), false);
  assert.equal(stopCalls, 1);
  assert.deepEqual(readReport(reportPath).videoCreation.response, {
    category: 'rejected',
    error: 'Укажите название товара',
  });
});

test('final shutdown preserves the API validation failure stage and reason', async (t) => {
  const { diagnostics, reportPath } = createFixture(t);
  diagnostics.setFailure('api-http-400', 'api-error');
  diagnostics.setVideoCreationResult(summarizeVideoCreateResponse(
    400,
    'application/json',
    { error: 'Укажите название товара' },
  ));

  await shutdownResources(0, null, 'completed', {
    diagnostics,
    harnessPid: 12345,
    childProcessRegistry: { async stopOwnedChildren() { return { children: [], blockedLaunches: [] }; } },
    closeResources: async () => ({ viteClosed: true, apiClosed: true, databaseClosed: true }),
  });

  const report = readReport(reportPath);
  assert.equal(report.lastStage, 'api-error');
  assert.equal(report.failureReason, 'api-http-400');
  assert.equal(report.videoCreation.status, 400);
});

test('image diagnostics check only file rows owned by the synthetic workspace', (t) => {
  const { root, isolation } = createFixture(t);
  const imagesDir = path.join(root, 'uploads', 'images');
  fs.mkdirSync(path.join(root, 'uploads'));
  fs.mkdirSync(imagesDir);
  const ownedId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  const imageName = `${ownedId}.png`;
  fs.writeFileSync(path.join(imagesDir, imageName), 'synthetic image');
  const db = {
    prepare() {
      return {
        get(id, workspaceId) {
          return id === ownedId && workspaceId === 'synthetic-workspace'
            ? { filename: imageName }
            : undefined;
        },
      };
    },
  };

  assert.deepEqual(
    inspectVideoFiles([ownedId, otherId, 'not-a-uuid'], db, 'synthetic-workspace', imagesDir, isolation),
    [
      { workspaceOwned: true, presentOnDisk: true },
      { workspaceOwned: false, presentOnDisk: false },
      { workspaceOwned: false, presentOnDisk: false },
    ],
  );
});

test('loopback port verification distinguishes an occupied port from a released port', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  assert.equal(await verifyLoopbackPortReleased(port), false);
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  assert.equal(await verifyLoopbackPortReleased(port), true);
});

test('shutdownResources writes verified closure and port-release results after cleanup', async (t) => {
  const { root, isolation, diagnostics, reportPath } = createFixture(t);
  const shutdownReportPath = path.join(root, 'shutdown-report.json');
  diagnostics.persist({ result: 'running', harnessPid: 12345 });
  const operations = [];

  await shutdownResources(0, null, 'completed', {
    diagnostics,
    harnessPid: 12345,
    childProcessRegistry: { async stopOwnedChildren() { return { children: [], blockedLaunches: [] }; } },
    shutdownReport: {
      isolation,
      reportPath: shutdownReportPath,
      apiPort: 31234,
      uiPort: 31235,
    },
    verifyPortReleased: async (port) => {
      operations.push(`port-${port}`);
      return true;
    },
    closeActions: {
      closeTimeoutMs: 10,
      closeVite: () => operations.push('vite'),
      closeApi: () => operations.push('api'),
      closeDatabase: () => operations.push('database'),
      setExitCode: (code) => operations.push(`exit-${code}`),
      log() {},
    },
  });

  assert.deepEqual(operations, [
    'vite',
    'api',
    'database',
    'exit-0',
    'port-31234',
    'port-31235',
  ]);
  assert.equal(readReport(reportPath).result, 'completed');
  assert.deepEqual(readReport(shutdownReportPath), {
    result: 'verified',
    harnessPid: 12345,
    childProcessCount: 0,
    childProcessesClosed: true,
    apiServerClosed: true,
    uiServerClosed: true,
    databaseClosed: true,
    apiPortReleased: true,
    uiPortReleased: true,
    createdAt: readReport(shutdownReportPath).createdAt,
  });
});

test('shutdown report rejects arbitrary or inconsistent closure data', (t) => {
  const { root, isolation } = createFixture(t);
  const shutdownReportPath = path.join(root, 'shutdown-report.json');
  const report = {
    result: 'verified',
    harnessPid: 12345,
    childProcessCount: 0,
    childProcessesClosed: true,
    apiServerClosed: true,
    uiServerClosed: true,
    databaseClosed: true,
    apiPortReleased: true,
    uiPortReleased: true,
    createdAt: new Date().toISOString(),
    secret: 'must not be accepted',
  };

  assert.throws(() => writeShutdownReport(isolation, shutdownReportPath, report), /invalid shutdown report/);
  assert.equal(fs.existsSync(shutdownReportPath), false);
});

test('shutdown reports incomplete port release and returns a failing exit code', async (t) => {
  const { root, isolation, diagnostics } = createFixture(t);
  const shutdownReportPath = path.join(root, 'shutdown-report.json');
  let exitCode = 0;

  await shutdownResources(0, null, 'completed', {
    diagnostics,
    harnessPid: 12345,
    childProcessRegistry: { async stopOwnedChildren() { return { children: [], blockedLaunches: [] }; } },
    shutdownReport: {
      isolation,
      reportPath: shutdownReportPath,
      apiPort: 31234,
      uiPort: 31235,
    },
    verifyPortReleased: async (port) => port === 31235,
    setExitCode: (code) => { exitCode = code; },
    closeActions: {
      closeTimeoutMs: 10,
      closeVite() {},
      closeApi() {},
      closeDatabase() {},
      log() {},
    },
  });

  const shutdownReport = readReport(shutdownReportPath);
  assert.equal(shutdownReport.result, 'incomplete');
  assert.equal(shutdownReport.apiPortReleased, false);
  assert.equal(shutdownReport.uiPortReleased, true);
  assert.equal(exitCode, 1);
});
