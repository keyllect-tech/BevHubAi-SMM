import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createMediaSmokePlan } from '../scripts/media-smoke.mjs';
import {
  awaitUntilDeadline,
  assessProcessTermination,
  assessSupervisorLifecycle,
  boundedProcessTimeoutMs,
  createDeadlinePhases,
  publishReportWithHeldDirectory,
  recoverSuspendedRootAssignment,
  createShutdownState,
  terminateAndConfirmSuspendedRoot,
  waitForActivityToStop,
} from '../scripts/media-smoke-supervision.mjs';

const launcherSource = fs.readFileSync(
  fileURLToPath(new URL('../scripts/run-media-smoke.ps1', import.meta.url)),
  'utf8',
);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('normal synthetic work completes before the absolute deadline', async () => {
  const result = await awaitUntilDeadline(Promise.resolve('complete'), performance.now() + 1000);
  assert.equal(result, 'complete');
});

test('the absolute deadline bounds a simulated hanging subprocess operation', async () => {
  await assert.rejects(
    awaitUntilDeadline(new Promise(() => {}), performance.now() + 20, { phase: 'synthetic child' }),
    { code: 'MEDIA_SMOKE_DEADLINE' },
  );
});

test('a child operation error is propagated without extending the deadline', async () => {
  const error = Object.assign(new Error('synthetic child failure'), { code: 'SYNTHETIC_CHILD_FAILURE' });
  await assert.rejects(awaitUntilDeadline(Promise.reject(error), performance.now() + 1000), (actual) => actual === error);
});

test('finally work is bounded by the same absolute deadline', async () => {
  await assert.rejects(
    awaitUntilDeadline(new Promise(() => {}), performance.now() + 20, { phase: 'media smoke finally' }),
    { code: 'MEDIA_SMOKE_DEADLINE' },
  );
});

test('shutdown requests are idempotent', () => {
  const shutdown = createShutdownState();
  const first = shutdown.requestStop('timeout', 1234);
  const repeated = shutdown.requestStop('cancelled', 5678);
  assert.equal(repeated, first);
  assert.deepEqual(shutdown.requested, { reason: 'timeout', requestedAtMonotonicMs: 1234 });
});

test('a shutdown request during queue waiting bounds the queue grace without extending the deadline', async () => {
  const deadlines = createDeadlinePhases(Date.now() + 1000, {
    shutdownGraceMs: 100,
    verifyGraceMs: 100,
  });
  const shutdown = createShutdownState();
  const start = performance.now();
  const signal = setTimeout(() => shutdown.requestStop('ctrl_break'), 15);
  try {
    await assert.rejects(
      waitForActivityToStop(() => true, deadlines, shutdown, { pollMs: 5 }),
      { code: 'MEDIA_SMOKE_SHUTDOWN_TIMEOUT' },
    );
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 95);
    assert.ok(elapsed < 300);
  } finally {
    clearTimeout(signal);
  }
});

test('a queue may finish normally during the Ctrl-Break grace period', async () => {
  const deadlines = createDeadlinePhases(Date.now() + 1000, {
    shutdownGraceMs: 200,
    verifyGraceMs: 100,
  });
  const shutdown = createShutdownState();
  let queueActive = true;
  const signal = setTimeout(() => shutdown.requestStop('ctrl_break'), 10);
  const stopQueue = setTimeout(() => { queueActive = false; }, 35);
  try {
    assert.equal(
      await waitForActivityToStop(() => queueActive, deadlines, shutdown, { pollMs: 5 }),
      true,
    );
    assert.equal(shutdown.requested.reason, 'ctrl_break');
  } finally {
    clearTimeout(signal);
    clearTimeout(stopQueue);
  }
});

test('supervisor constructor failure is not reported as disposed', () => {
  const lifecycle = assessSupervisorLifecycle({
    creationCompleted: false,
    diagnostics: ['InvalidOperationException: synthetic constructor failure'],
  });
  assert.equal(lifecycle.state, 'creation_incomplete');
  assert.equal(lifecycle.supervisorDisposed, false);
  assert.match(lifecycle.diagnostics[0], /constructor failure/);
  assert.match(launcherSource, /supervisorCreationState -eq 'created'/);
  assert.match(launcherSource, /\$supervisorCreationDiagnostic = \$launcherDiagnostic/);
});

test('supervisor handle close failure remains unconfirmed with its diagnostic', () => {
  const lifecycle = assessSupervisorLifecycle({
    creationCompleted: true,
    disposeAttempted: true,
    disposeConfirmed: false,
    diagnostics: ['CloseHandle(job) failed with Win32 error 6'],
  });
  assert.equal(lifecycle.state, 'unconfirmed');
  assert.equal(lifecycle.supervisorDisposed, false);
  assert.match(lifecycle.diagnostics[0], /CloseHandle\(job\).*Win32 error 6/);
  assert.match(launcherSource, /CloseHandle\(job\) failed with Win32 error/);
  assert.match(launcherSource, /supervisorDisposeState = if \(\$supervisor\.IsDisposed\)/);
});

function createRootHandleDisposalModel({ rootHandle = 0x1234, trackedRootHandle = rootHandle, otherHandles = [] }, closeHandle) {
  const rootPid = 100;
  const processHandles = new Map(otherHandles.map((handle, index) => [200 + index, handle]));
  if (trackedRootHandle !== null) processHandles.set(rootPid, trackedRootHandle);
  let ownedRootHandle = rootHandle;
  let rootHandleState = rootHandle === null ? 'not_created' : 'open';
  let rootExited = false;
  const apiCalls = [];
  const diagnostics = [];

  function recordApi(operation, handle) {
    apiCalls.push({ operation, handle });
  }

  function closeRootProcessHandle() {
    if (rootHandleState !== 'open') return;
    if (ownedRootHandle === null) {
      rootHandleState = 'release-unconfirmed';
      processHandles.delete(rootPid);
      diagnostics.push('root process handle value unavailable');
      return;
    }
    const handle = ownedRootHandle;
    try {
      recordApi('CloseHandle', handle);
      if (closeHandle(handle)) {
        ownedRootHandle = null;
        rootHandleState = 'released';
        if (processHandles.get(rootPid) === handle) processHandles.delete(rootPid);
        return;
      }
      rootHandleState = 'release-unconfirmed';
      processHandles.delete(rootPid);
      diagnostics.push('CloseHandle(root process) failed with Win32 error 6');
    } catch (error) {
      rootHandleState = 'release-unconfirmed';
      processHandles.delete(rootPid);
      diagnostics.push(`CloseHandle(root process) threw ${error.name}: ${error.message}`);
    }
  }

  function refreshRootStatus() {
    if (rootHandleState !== 'open' || ownedRootHandle === null || rootExited) return;
    recordApi('WaitForSingleObject', ownedRootHandle);
    recordApi('GetExitCodeProcess', ownedRootHandle);
  }

  function tryTerminateUnassignedRoot() {
    if (rootHandleState !== 'open' || ownedRootHandle === null || rootExited) return false;
    recordApi('TerminateProcess', ownedRootHandle);
    return true;
  }

  function closeProcessHandle(pid) {
    if (pid === rootPid) {
      closeRootProcessHandle();
      return;
    }
    const handle = processHandles.get(pid);
    if (handle === undefined) return;
    recordApi('CloseHandle', handle);
    if (closeHandle(handle)) processHandles.delete(pid);
    else diagnostics.push(`CloseHandle(PID ${pid}) failed`);
  }

  function dispose() {
    for (const pid of [...processHandles.keys()]) {
      if (pid === rootPid && rootHandleState !== 'open') continue;
      const handle = processHandles.get(pid);
      if (handle === undefined) continue;
      recordApi('WaitForSingleObject', handle);
      recordApi('GetExitCodeProcess', handle);
      if (pid === rootPid) rootExited = true;
      closeProcessHandle(pid);
    }
    closeRootProcessHandle();
    return {
      rootHandleState,
      ownedRootHandle,
      processHandles: new Map(processHandles),
      diagnostics: [...diagnostics],
      rootExited,
      apiCalls: [...apiCalls],
      disposed: processHandles.size === 0 &&
        ownedRootHandle === null &&
        (rootHandleState === 'not_created' || rootHandleState === 'released'),
      terminationVerified: rootExited &&
        rootHandleState === 'released' &&
        ownedRootHandle === null &&
        processHandles.size === 0,
    };
  }

  return {
    dispose,
    refreshRootStatus,
    tryTerminateUnassignedRoot,
    rootHandleApiCalls() {
      return apiCalls.filter((call) => call.handle === rootHandle);
    },
  };
}

test('root handle is closed exactly once when the dictionary and field alias the same numeric handle', () => {
  const closeCalls = [];
  const model = createRootHandleDisposalModel({}, (handle) => {
    closeCalls.push(handle);
    return true;
  });
  const result = model.dispose();
  assert.deepEqual(closeCalls, [0x1234]);
  assert.equal(result.rootHandleState, 'released');
  assert.equal(result.disposed, true);

  const disposalStart = launcherSource.indexOf('public void DisposeBounded');
  const closeLoopStart = launcherSource.indexOf('foreach (uint processId in _processHandles.Keys.ToArray())', disposalStart);
  const closeLoopEnd = launcherSource.indexOf('CloseRootProcessHandle();', closeLoopStart);
  assert.match(launcherSource.slice(closeLoopStart, closeLoopEnd), /if \(processId == RootProcessId\) continue;/);
});

test('CloseHandle false excludes the root handle from all APIs on repeated Dispose', () => {
  const closeCalls = [];
  const childCloseCalls = [];
  const model = createRootHandleDisposalModel({}, (handle) => {
    closeCalls.push(handle);
    if (handle === 0x1234) return false;
    childCloseCalls.push(handle);
    return true;
  });
  const first = model.dispose();
  const rootCallsAfterFailure = model.rootHandleApiCalls();
  const second = model.dispose();
  const third = model.dispose();
  model.refreshRootStatus();
  assert.equal(model.tryTerminateUnassignedRoot(), false);
  assert.deepEqual(closeCalls, [0x1234]);
  assert.deepEqual(childCloseCalls, []);
  assert.equal(first.rootHandleState, 'release-unconfirmed');
  assert.equal(second.rootHandleState, 'release-unconfirmed');
  assert.equal(third.rootHandleState, 'release-unconfirmed');
  assert.equal(second.ownedRootHandle, 0x1234);
  assert.equal(second.disposed, false);
  assert.equal(second.terminationVerified, false);
  assert.deepEqual(model.rootHandleApiCalls(), rootCallsAfterFailure);
  assert.deepEqual(
    rootCallsAfterFailure.map(({ operation }) => operation),
    ['WaitForSingleObject', 'GetExitCodeProcess', 'CloseHandle'],
  );
  assert.ok(second.diagnostics.some((message) => message.includes('Win32 error 6')));
  const lifecycle = assessSupervisorLifecycle({
    creationCompleted: true,
    disposeAttempted: true,
    disposeConfirmed: second.disposed,
    diagnostics: second.diagnostics,
  });
  assert.equal(lifecycle.supervisorDisposed, false);
  const disposedStart = launcherSource.indexOf('IsDisposed = _job');
  const disposedEnd = launcherSource.indexOf(';', disposedStart);
  assert.match(
    launcherSource.slice(disposedStart, disposedEnd),
    /_rootProcessHandleState == "not_created" \|\| _rootProcessHandleState == "released"/,
  );
  assert.match(launcherSource, /supervisorDisposeState -eq 'confirmed'[\s\S]*?\$supervisor\.IsDisposed/);
  const terminationVerificationStart = launcherSource.indexOf('public bool TerminationVerified');
  const terminationVerificationEnd = launcherSource.indexOf('public bool HasUnreconciledProcessRecords', terminationVerificationStart);
  assert.match(
    launcherSource.slice(terminationVerificationStart, terminationVerificationEnd),
    /_rootProcessHandleState == "not_created" \|\| _rootProcessHandleState == "released"/,
  );

  const thrownCloseCalls = [];
  const thrownModel = createRootHandleDisposalModel({}, (handle) => {
    thrownCloseCalls.push(handle);
    if (handle !== 0x1234) return true;
    throw new Error('synthetic CloseHandle exception');
  });
  const thrownFirst = thrownModel.dispose();
  const thrownRootCallsAfterFailure = thrownModel.rootHandleApiCalls();
  const thrownSecond = thrownModel.dispose();
  const thrownThird = thrownModel.dispose();
  assert.deepEqual(thrownCloseCalls, [0x1234]);
  assert.equal(thrownFirst.rootHandleState, 'release-unconfirmed');
  assert.equal(thrownSecond.disposed, false);
  assert.equal(thrownSecond.terminationVerified, false);
  assert.equal(thrownThird.rootHandleState, 'release-unconfirmed');
  assert.deepEqual(thrownModel.rootHandleApiCalls(), thrownRootCallsAfterFailure);
  assert.ok(thrownSecond.diagnostics.some((message) => message.includes('synthetic CloseHandle exception')));
});

test('release-unconfirmed root is excluded from Wait, exit-code, and close paths while children still close', () => {
  const childCloseCalls = [];
  const model = createRootHandleDisposalModel({ otherHandles: [0x5678] }, (handle) => {
    if (handle === 0x1234) return false;
    childCloseCalls.push(handle);
    return true;
  });
  const outcome = model.dispose();
  assert.equal(outcome.disposed, false);
  assert.equal(outcome.terminationVerified, false);
  assert.equal(outcome.rootHandleState, 'release-unconfirmed');
  assert.equal(outcome.ownedRootHandle, 0x1234);
  assert.equal(outcome.processHandles.has(100), false);
  assert.deepEqual(childCloseCalls, [0x5678]);
  assert.deepEqual(
    model.rootHandleApiCalls().map(({ operation }) => operation),
    ['WaitForSingleObject', 'GetExitCodeProcess', 'CloseHandle'],
  );

  const refreshStart = launcherSource.indexOf('public void RefreshRootStatus()');
  const refreshEnd = launcherSource.indexOf('public bool Pump(', refreshStart);
  assert.match(
    launcherSource.slice(refreshStart, refreshEnd),
    /_rootProcessHandleState != "open"/,
  );
  const terminateStart = launcherSource.indexOf('public bool TryTerminateUnassignedRoot');
  const terminateEnd = launcherSource.indexOf('public bool Pump(', terminateStart);
  assert.match(
    launcherSource.slice(terminateStart, terminateEnd),
    /_rootProcessHandleState != "open"/,
  );
  const disposeStart = launcherSource.indexOf('public void DisposeBounded');
  const disposeEnd = launcherSource.indexOf('private static uint RemainingMilliseconds', disposeStart);
  const disposeSource = launcherSource.slice(disposeStart, disposeEnd);
  assert.match(disposeSource, /processId == RootProcessId && _rootProcessHandleState != "open"\) continue;/);
  assert.match(disposeSource, /_rootProcessHandleState == "open" &&[\s\S]*WaitForSingleObject\(_rootProcessHandle, remaining\)/);
  assert.match(launcherSource, /if \(processId == RootProcessId && _rootProcessHandleState != "open"\)\s*\{\s*_lastKnownActivePids\.Remove\(processId\);\s*return true;/);
  assert.match(launcherSource, /private void RecordConfirmedExit\(uint processId, IntPtr processHandle\)\s*\{\s*if \(processId == RootProcessId && _rootProcessHandleState != "open"\) return;/);
  assert.match(launcherSource, /private void MarkRootProcessHandleReleaseUnconfirmed\(string diagnostic\)\s*\{\s*_rootProcessHandleState = "release-unconfirmed";\s*_processHandles\.Remove\(RootProcessId\);/);
});

test('root handle absent from the PID dictionary remains unconfirmed after a failed close', () => {
  const model = createRootHandleDisposalModel({ trackedRootHandle: null }, () => false);
  const outcome = model.dispose();
  assert.equal(outcome.disposed, false);
  assert.equal(outcome.rootHandleState, 'release-unconfirmed');
  assert.equal(outcome.terminationVerified, false);
  assert.match(launcherSource, /root handle remains separately retained: " \+ trackingError\.ToString\(\)/);
  assert.match(launcherSource, /_processHandles\.Remove\(RootProcessId\);/);
});

test('root handle release invariants are guarded in the embedded C# and report predicates', () => {
  const closeRootStart = launcherSource.indexOf('private void CloseRootProcessHandle()');
  const closeRootEnd = launcherSource.indexOf('private void MarkRootProcessHandleReleaseUnconfirmed', closeRootStart);
  const closeRoot = launcherSource.slice(closeRootStart, closeRootEnd);
  const closeGuard = closeRoot.indexOf('if (_rootProcessHandleState != "open") return;');
  const closeCall = closeRoot.indexOf('CloseHandle(handle)');
  assert.ok(closeGuard >= 0);
  assert.ok(closeCall > closeGuard);
  assert.equal((closeRoot.match(/CloseHandle\(handle\)/g) || []).length, 1);
  assert.match(closeRoot, /MarkRootProcessHandleReleaseUnconfirmed\(/);

  const markStart = launcherSource.indexOf('private void MarkRootProcessHandleReleaseUnconfirmed');
  const markEnd = launcherSource.indexOf('private void CloseRootThreadHandle', markStart);
  const markSource = launcherSource.slice(markStart, markEnd);
  assert.match(markSource, /_rootProcessHandleState = "release-unconfirmed";/);
  assert.match(markSource, /_processHandles\.Remove\(RootProcessId\);/);
  assert.match(markSource, /_diagnostics\.Add\(diagnostic\);/);

  const terminateJobPattern = /TerminateJobObject\s*\(([^)]*)\)/g;
  const terminateJobCalls = [];
  let terminateJobMatch;
  while ((terminateJobMatch = terminateJobPattern.exec(launcherSource)) !== null) {
    const argumentsText = terminateJobMatch[1].trim();
    if (argumentsText !== 'IntPtr job, uint exitCode' && argumentsText !== 'dispose') {
      terminateJobCalls.push(argumentsText);
    }
  }
  assert.equal(terminateJobCalls.length, 2);
  assert.ok(terminateJobCalls.every((argumentsText) => /^_job\s*,/.test(argumentsText)));

  const isDisposedStart = launcherSource.indexOf('IsDisposed = _job');
  const isDisposedEnd = launcherSource.indexOf(';', isDisposedStart);
  const isDisposedSource = launcherSource.slice(isDisposedStart, isDisposedEnd);
  const terminationStart = launcherSource.indexOf('public bool TerminationVerified');
  const terminationEnd = launcherSource.indexOf('public bool HasUnreconciledProcessRecords', terminationStart);
  const terminationSource = launcherSource.slice(terminationStart, terminationEnd);
  for (const predicate of [isDisposedSource, terminationSource]) {
    assert.match(predicate, /_rootProcessHandle == IntPtr\.Zero/);
    assert.match(predicate, /_rootProcessHandleState == "not_created" \|\| _rootProcessHandleState == "released"/);
    assert.doesNotMatch(predicate, /release-unconfirmed/);
  }
});

function reportOperations(overrides = {}) {
  const calls = [];
  const operations = {
    async openRoot() { calls.push('open'); return { id: 'held-root' }; },
    async holdRoot(handle) { calls.push(['hold', handle.id]); return true; },
    async verifyIdentity(handle) { calls.push(['identity', handle.id]); return true; },
    async readProof(handle) { calls.push(['proof', handle.id]); return 'run-proof'; },
    async createReportRelative(handle, contents) {
      calls.push(['create', handle.id, contents]);
      return true;
    },
    async closeRoot(handle) { calls.push(['close', handle.id]); return true; },
    ...overrides,
  };
  if (Object.hasOwn(overrides, 'closeRoot')) {
    const closeRoot = overrides.closeRoot;
    operations.closeRoot = async (handle) => {
      calls.push(['close', handle.id]);
      return closeRoot(handle);
    };
  }
  return { calls, operations };
}

test('held-root report publication fails closed when opening or holding the root fails', async () => {
  const openFailure = reportOperations({
    async openRoot() { throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' }); },
  });
  const openResult = await publishReportWithHeldDirectory({
    ...openFailure.operations,
    expectedProof: 'run-proof',
    reportContents: 'synthetic report',
  });
  assert.equal(openResult.state, 'root_open_failed');
  assert.equal(openResult.reportWritten, false);
  assert.deepEqual(openFailure.calls, []);

  const holdFailure = reportOperations({
    async holdRoot() { return false; },
  });
  const holdResult = await publishReportWithHeldDirectory({
    ...holdFailure.operations,
    expectedProof: 'run-proof',
    reportContents: 'synthetic report',
  });
  assert.equal(holdResult.state, 'root_hold_failed');
  assert.equal(holdResult.reportWritten, false);
  assert.ok(holdFailure.calls.some((call) => Array.isArray(call) && call[0] === 'close'));
  assert.ok(!holdFailure.calls.some((call) => Array.isArray(call) && call[0] === 'create'));
});

test('held-root report publication rejects missing, mismatched, or unverifiable proofs', async () => {
  for (const [proof, verifyIdentity, expectedState] of [
    [null, async () => true, 'proof_missing'],
    ['previous-run-proof', async () => true, 'proof_mismatch'],
    ['run-proof', async () => false, 'root_identity_unconfirmed'],
  ]) {
    const fake = reportOperations({
      async verifyIdentity() { return verifyIdentity(); },
      async readProof() { return proof; },
    });
    const result = await publishReportWithHeldDirectory({
      ...fake.operations,
      expectedProof: 'run-proof',
      reportContents: 'synthetic report',
    });
    assert.equal(result.state, expectedState);
    assert.equal(result.reportWritten, false);
    assert.ok(!fake.calls.some((call) => Array.isArray(call) && call[0] === 'create'));
  }
});

test('held-root report publication does not overwrite an existing report', async () => {
  const fake = reportOperations({
    async createReportRelative() { return 'exists'; },
  });
  const result = await publishReportWithHeldDirectory({
    ...fake.operations,
    expectedProof: 'run-proof',
    reportContents: 'synthetic report',
  });
  assert.equal(result.state, 'report_exists');
  assert.equal(result.reportWritten, false);
  assert.ok(fake.calls.some((call) => Array.isArray(call) && call[0] === 'close'));
});

test('held-root report failure still releases the root handle and reports close failures', async () => {
  const fake = reportOperations({
    async createReportRelative() { throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' }); },
    async closeRoot() { return false; },
  });
  const result = await publishReportWithHeldDirectory({
    ...fake.operations,
    expectedProof: 'run-proof',
    reportContents: 'synthetic report',
  });
  assert.equal(result.state, 'handle_release_unconfirmed');
  assert.equal(result.reportWritten, false);
  assert.equal(result.handleReleased, false);
  assert.ok(result.diagnostics.includes('EIO'));
  assert.ok(result.diagnostics.includes('root handle release was not confirmed'));

  const writeFailure = reportOperations({
    async createReportRelative() { throw Object.assign(new Error('synthetic report write error'), { code: 'EIO' }); },
  });
  const writeResult = await publishReportWithHeldDirectory({
    ...writeFailure.operations,
    expectedProof: 'run-proof',
  });
  assert.equal(writeResult.state, 'report_create_failed');
  assert.equal(writeResult.handleReleased, true);
  assert.ok(writeResult.diagnostics.includes('EIO'));
});

test('lease cleanup runs after post-open, diagnostics, serialization, and Dispose failures', async () => {
  const failureCases = [
    ['immediately after lease acquisition', {
      async afterLeaseAcquired() { throw Object.assign(new Error('synthetic post-open error'), { code: 'POST_OPEN' }); },
    }, 'after_lease_acquired_failed', 'POST_OPEN'],
    ['diagnostics preparation', {
      async prepareReport() { throw Object.assign(new Error('synthetic diagnostics error'), { code: 'DIAGNOSTICS' }); },
    }, 'report_preparation_failed', 'DIAGNOSTICS'],
    ['report serialization', {
      async serializeReport() { throw Object.assign(new Error('synthetic serialization error'), { code: 'SERIALIZE' }); },
    }, 'report_serialization_failed', 'SERIALIZE'],
    ['Dispose', {
      async closeRoot() { throw Object.assign(new Error('synthetic Dispose error'), { code: 'DISPOSE' }); },
    }, 'written_handle_release_unconfirmed', 'DISPOSE'],
  ];

  for (const [name, overrides, expectedState, expectedDiagnostic] of failureCases) {
    const fake = reportOperations(overrides);
    const result = await publishReportWithHeldDirectory({
      ...fake.operations,
      expectedProof: 'run-proof',
      reportContents: 'synthetic report',
    });
    assert.equal(result.state, expectedState, name);
    assert.ok(result.diagnostics.includes(expectedDiagnostic), name);
    assert.ok(fake.calls.some((call) => Array.isArray(call) && call[0] === 'close'), name);
  }
});

test('PowerShell protects root acquisition through report preparation, writing, and disposal', () => {
  const openIndex = launcherSource.indexOf('[MediaSmokeOwnedDirectoryLease]::Open');
  const tryStart = launcherSource.lastIndexOf('try {', openIndex);
  const flowEnd = launcherSource.indexOf('exit $finalExitCode', openIndex);
  const flow = launcherSource.slice(tryStart, flowEnd);
  const openOffset = flow.indexOf('[MediaSmokeOwnedDirectoryLease]::Open');
  const finallyStart = flow.indexOf('} finally {', openOffset);
  assert.ok(tryStart >= 0);
  assert.ok(openOffset >= 0);
  assert.ok(finallyStart > openOffset);
  assert.ok(flow.indexOf('$reportDiagnostics =', openOffset) < finallyStart);
  assert.ok(flow.indexOf('$report = [ordered]@{', openOffset) < finallyStart);
  assert.ok(flow.indexOf('$report | ConvertTo-Json', openOffset) < finallyStart);
  assert.ok(flow.indexOf('$rootLease.WriteReport', openOffset) < finallyStart);
  assert.ok(flow.indexOf('$rootLease.Dispose()', finallyStart) > finallyStart);
  assert.ok(flow.lastIndexOf('$report | ConvertTo-Json') > finallyStart);
  assert.match(flow, /\$reportOperationDiagnostic = \$_.Exception.ToString\(\)/);
  assert.match(flow, /\$rootLeaseDisposeDiagnostic = \$_.Exception.ToString\(\)/);
  assert.match(flow, /if \(\$rootHandleReleased\)[\s\S]*?\$rootLeaseDisposeState = 'confirmed'[\s\S]*?\$rootLeaseDisposeState = 'unconfirmed'/);
});

test('held-root report is written relative to the verified held handle', async () => {
  const fake = reportOperations();
  const result = await publishReportWithHeldDirectory({
    ...fake.operations,
    expectedProof: 'run-proof',
    reportContents: 'synthetic report',
  });
  assert.equal(result.state, 'written');
  assert.equal(result.identityConfirmed, true);
  assert.equal(result.reportWritten, true);
  assert.equal(result.handleReleased, true);
  assert.deepEqual(fake.calls[0], 'open');
  assert.ok(fake.calls.findIndex((call) => Array.isArray(call) && call[0] === 'proof') <
    fake.calls.findIndex((call) => Array.isArray(call) && call[0] === 'create'));
  assert.ok(fake.calls.findIndex((call) => Array.isArray(call) && call[0] === 'create') <
    fake.calls.findIndex((call) => Array.isArray(call) && call[0] === 'close'));
  assert.match(launcherSource, /FileShareRead \| FileShareWrite/);
  assert.doesNotMatch(launcherSource, /FileShareRead \| FileShareWrite \| FileShareDelete/);
  assert.match(launcherSource, /RootDirectory = rootHandle/);
  assert.match(launcherSource, /FileCreate/);
});

test('local process timeouts never extend the shared work deadline', () => {
  const deadlines = createDeadlinePhases(20000, {
    shutdownGraceMs: 2000,
    verifyGraceMs: 1000,
    nowMs: 1000,
    monotonicNowMs: 1000,
  });
  assert.equal(deadlines.workDeadlineAtMonotonicMs, 17000);
  assert.equal(deadlines.forceAtMonotonicMs, 19000);
  assert.equal(boundedProcessTimeoutMs(15000, deadlines, 1000), 15000);
  assert.equal(boundedProcessTimeoutMs(20000, deadlines, 3000), 14000);
  assert.throws(() => boundedProcessTimeoutMs(1000, deadlines, 17000), { code: 'MEDIA_SMOKE_DEADLINE' });
});

test('bounded process timeout defaults to the monotonic clock before and after expiry', async () => {
  const deadlines = createDeadlinePhases(Date.now() + 500, {
    shutdownGraceMs: 100,
    verifyGraceMs: 100,
  });
  assert.ok(boundedProcessTimeoutMs(1000, deadlines) > 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.throws(() => boundedProcessTimeoutMs(1000, deadlines), { code: 'MEDIA_SMOKE_DEADLINE' });
});

test('assignment failure terminates a still-suspended root and waits before allowing handle closure', async () => {
  const operations = [];
  const outcome = await recoverSuspendedRootAssignment({
    assign: async () => {
      operations.push('assign');
      return false;
    },
    terminate: async () => {
      operations.push('terminate');
      return true;
    },
    waitForExit: async () => {
      operations.push('wait');
      return true;
    },
    getExitCode: async () => 1,
    graceMs: 100,
  });
  assert.deepEqual(operations, ['assign', 'terminate', 'wait']);
  assert.equal(outcome.assigned, false);
  assert.equal(outcome.termination.terminationConfirmed, true);
  assert.equal(outcome.termination.mayCloseProcessHandles, true);
});

test('failed terminate request and missing exit confirmation keep root handles open', async () => {
  const outcome = await terminateAndConfirmSuspendedRoot({
    terminate: async () => false,
    waitForExit: async () => false,
    getExitCode: async () => {
      throw new Error('must not query an unconfirmed process');
    },
    graceMs: 100,
  });
  assert.equal(outcome.terminationConfirmed, false);
  assert.equal(outcome.mayCloseProcessHandles, false);
  assert.ok(outcome.diagnostics.includes('terminate_request_failed'));
  assert.ok(outcome.diagnostics.includes('termination_unconfirmed'));
});

test('termination verification requires a confirmed root and known exit codes', () => {
  const confirmedUnassignedRoot = assessProcessTermination({
    rootCreationAttempted: true,
    rootPid: 51,
    rootExited: true,
    rootExitCode: 1,
    jobActivePids: [],
    processRecords: [{ pid: 51, state: 'exited', exitCode: 1 }],
  });
  assert.equal(confirmedUnassignedRoot.verified, true);

  const unconfirmedRoot = assessProcessTermination({
    rootCreationAttempted: true,
    rootPid: 51,
    rootExited: false,
    jobActivePids: [],
    processRecords: [{ pid: 51, state: 'termination_unverified', exitCode: null }],
  });
  assert.equal(unconfirmedRoot.verified, false);
  assert.deepEqual(unconfirmedRoot.activePids, [51]);

  const unknownChildExit = assessProcessTermination({
    rootCreationAttempted: true,
    rootPid: 51,
    rootAssignedToJob: true,
    rootExited: true,
    rootExitCode: 0,
    jobActivePids: [],
    processRecords: [
      { pid: 51, state: 'exited', exitCode: 0 },
      { pid: 52, state: 'exited_exit_code_unknown', exitCode: null },
    ],
  });
  assert.equal(unknownChildExit.verified, false);
  assert.deepEqual(unknownChildExit.unknownExitPids, [52]);
});

test('supervision reports and shutdown requests remain inside the disposable root', () => {
  const candidateRoot = path.join(os.tmpdir(), `bevhub-media-smoke-supervision-${crypto.randomUUID()}`);
  const plan = createMediaSmokePlan({ candidateRoot, projectRoot, cwd: projectRoot, env: {} });
  assert.equal(path.dirname(plan.supervisionReportPath), plan.testRoot);
  assert.equal(path.dirname(plan.shutdownRequestPath), plan.testRoot);
  assert.equal(path.dirname(plan.ownershipMarkerPath), plan.testRoot);
  assert.throws(() => fs.lstatSync(plan.testRoot), { code: 'ENOENT' });
});

test('pre-existing disposable roots are rejected without writing into them', () => {
  const candidateRoot = path.join(os.tmpdir(), `bevhub-media-smoke-foreign-${crypto.randomUUID()}`);
  const fakeFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (targetPath, ...args) => {
          if (path.resolve(targetPath) === path.resolve(candidateRoot)) {
            return { isDirectory: () => true, isSymbolicLink: () => false };
          }
          return fs.lstatSync(targetPath, ...args);
        };
      }
      if (property === 'realpathSync') {
        return (targetPath, ...args) => {
          if (path.resolve(targetPath) === path.resolve(candidateRoot)) return path.resolve(candidateRoot);
          return fs.realpathSync(targetPath, ...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(
    () => createMediaSmokePlan({ candidateRoot, projectRoot, cwd: projectRoot, env: {}, fsApi: fakeFs }),
    /disposable root already exists/,
  );
});

test('launcher statically contains process-tree containment and post-stop verification', () => {
  assert.match(launcherSource, /\$timeoutMs = 360000/);
  assert.match(launcherSource, /\$shutdownGraceMs = 10000/);
  assert.match(launcherSource, /\$verifyGraceMs = 5000/);
  assert.match(launcherSource, /CreateSuspended\s*\|\s*CreateNewProcessGroup\s*\|\s*CreateUnicodeEnvironment/);
  assert.match(launcherSource, /AssignProcessToJobObject/);
  assert.match(launcherSource, /JobObjectLimitKillOnJobClose/);
  assert.match(launcherSource, /GenerateConsoleCtrlEvent/);
  assert.match(launcherSource, /TerminateJobObject/);
  assert.match(launcherSource, /GetActiveProcessIds/);
  assert.match(launcherSource, /terminationVerified/);
  assert.match(launcherSource, /activePidsAfterStop/);
  assert.match(launcherSource, /verificationStopAfterMs/);
  assert.match(launcherSource, /child_process_failed/);
  assert.match(launcherSource, /shutdownRequestObserved/);
  assert.doesNotMatch(launcherSource, /WaitForExit\s*\(/);
  assert.match(launcherSource, /finally[\s\S]*?\.Dispose\(\)/);
  assert.match(launcherSource, /WaitForSingleObject/);
  assert.match(launcherSource, /RootAssignedToJob/);
  assert.match(launcherSource, /RootExitCode/);
  assert.match(launcherSource, /CreateNew/);
  assert.match(launcherSource, /rootProof/);
  assert.match(launcherSource, /JobObjectBasicAccountingInformation/);
  assert.match(launcherSource, /HasUnreconciledProcessRecords/);
});

test('assignment failure is handled before resume and root handles are retained until confirmation', () => {
  const assignmentStart = launcherSource.indexOf('if (!AssignProcessToJobObject');
  const resumeStart = launcherSource.indexOf('if (ResumeThread', assignmentStart);
  const assignmentFailure = launcherSource.slice(assignmentStart, resumeStart);
  assert.match(assignmentFailure, /TryTerminateUnassignedRoot/);
  assert.doesNotMatch(assignmentFailure, /ResumeThread/);

  const rootTerminationStart = launcherSource.indexOf('public bool TryTerminateUnassignedRoot');
  const rootTerminationEnd = launcherSource.indexOf('public bool Pump', rootTerminationStart);
  const rootTermination = launcherSource.slice(rootTerminationStart, rootTerminationEnd);
  assert.ok(rootTermination.indexOf('TerminateProcess') < rootTermination.indexOf('WaitForSingleObject'));
  assert.match(rootTermination, /CloseRootProcessHandle\(\)/);
  assert.match(rootTermination, /termination_unverified/);
});

test('supervisor disposal precedes report serialization and report creation is handle-relative', () => {
  const disposeIndex = launcherSource.indexOf('$supervisor.DisposeBounded');
  const reportSerializationIndex = launcherSource.indexOf('$report | ConvertTo-Json', disposeIndex);
  const reportWriteIndex = launcherSource.indexOf('$rootLease.WriteReport', reportSerializationIndex);
  assert.ok(disposeIndex >= 0);
  assert.ok(reportSerializationIndex > disposeIndex);
  assert.ok(reportWriteIndex > reportSerializationIndex);
  assert.doesNotMatch(launcherSource, /\[IO\.File\]::Open\(\$reportPath/);
  assert.match(launcherSource, /FileCreate,/);
  assert.match(launcherSource, /RootDirectory = rootHandle/);

  const disposeMethodStart = launcherSource.indexOf('public void DisposeBounded');
  const disposeMethodEnd = launcherSource.indexOf('private static uint RemainingMilliseconds', disposeMethodStart);
  const disposeMethod = launcherSource.slice(disposeMethodStart, disposeMethodEnd);
  assert.match(disposeMethod, /finally\s*\{/);
  assert.match(disposeMethod, /if \(_job != IntPtr\.Zero\)/);
  assert.match(disposeMethod, /if \(_completionPort != IntPtr\.Zero\)/);
  assert.match(disposeMethod, /CloseHandle\(job\).*failed with Win32 error/);
  assert.match(disposeMethod, /CloseHandle\(completion port\).*failed with Win32 error/);
  const disposeBlock = launcherSource.slice(disposeIndex, reportSerializationIndex);
  assert.match(disposeBlock, /finally\s*\{/);
});
