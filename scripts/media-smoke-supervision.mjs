import { performance } from 'node:perf_hooks';

export const MEDIA_SMOKE_SHUTDOWN_GRACE_MS = 10 * 1000;
export const MEDIA_SMOKE_VERIFY_GRACE_MS = 5 * 1000;

export function createDeadlinePhases(deadlineAtMs, {
  shutdownGraceMs = MEDIA_SMOKE_SHUTDOWN_GRACE_MS,
  verifyGraceMs = MEDIA_SMOKE_VERIFY_GRACE_MS,
  nowMs = Date.now(),
  monotonicNowMs = performance.now(),
} = {}) {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) {
    throw new Error('an absolute media smoke deadline is required');
  }
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 0) {
    throw new Error('shutdown grace must be a non-negative integer');
  }
  if (!Number.isSafeInteger(verifyGraceMs) || verifyGraceMs < 0) {
    throw new Error('verification grace must be a non-negative integer');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('current time must be a non-negative integer');
  }
  if (!Number.isFinite(monotonicNowMs) || monotonicNowMs < 0) {
    throw new Error('monotonic time must be a non-negative number');
  }
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs <= shutdownGraceMs + verifyGraceMs) {
    throw new Error('deadline does not leave time for bounded shutdown');
  }

  const deadlineAtMonotonicMs = monotonicNowMs + remainingMs;
  const forceAtMonotonicMs = deadlineAtMonotonicMs - verifyGraceMs;
  const workDeadlineAtMonotonicMs = forceAtMonotonicMs - shutdownGraceMs;
  return Object.freeze({
    deadlineAtMs,
    shutdownGraceMs,
    deadlineAtMonotonicMs,
    workDeadlineAtMonotonicMs,
    forceAtMonotonicMs,
    remainingMs(now = performance.now()) {
      return Math.max(0, deadlineAtMonotonicMs - now);
    },
    workRemainingMs(now = performance.now()) {
      return Math.max(0, workDeadlineAtMonotonicMs - now);
    },
  });
}

export function boundedProcessTimeoutMs(requestedMs, deadlines, now = performance.now()) {
  if (!Number.isSafeInteger(requestedMs) || requestedMs <= 0) {
    throw new Error('process timeout must be a positive integer');
  }
  if (!deadlines || typeof deadlines.workRemainingMs !== 'function') {
    throw new Error('media smoke deadline phases are required');
  }
  const remainingMs = deadlines.workRemainingMs(now);
  if (remainingMs <= 0) {
    throw Object.assign(new Error('media smoke work deadline exceeded'), { code: 'MEDIA_SMOKE_DEADLINE' });
  }
  return Math.max(1, Math.floor(Math.min(requestedMs, remainingMs)));
}

export async function terminateAndConfirmSuspendedRoot({
  terminate,
  waitForExit,
  getExitCode,
  graceMs,
}) {
  if (typeof terminate !== 'function' || typeof waitForExit !== 'function' || typeof getExitCode !== 'function') {
    throw new Error('root termination operations are required');
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('root termination grace must be a non-negative integer');
  }

  const diagnostics = [];
  try {
    if ((await terminate()) !== true) diagnostics.push('terminate_request_failed');
  } catch {
    diagnostics.push('terminate_request_failed');
  }

  let terminationConfirmed = false;
  try {
    terminationConfirmed = (await waitForExit(graceMs)) === true;
  } catch {
    diagnostics.push('termination_wait_failed');
  }

  let exitCode = null;
  if (terminationConfirmed) {
    try {
      const value = await getExitCode();
      if (Number.isSafeInteger(value)) exitCode = value;
      else diagnostics.push('exit_code_unknown');
    } catch {
      diagnostics.push('exit_code_query_failed');
    }
  } else {
    diagnostics.push('termination_unconfirmed');
  }

  return Object.freeze({
    terminationConfirmed,
    exitCode,
    mayCloseProcessHandles: terminationConfirmed,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function assessProcessTermination({
  rootCreationAttempted,
  rootPid = null,
  rootAssignedToJob = false,
  rootExited = false,
  rootExitCode = null,
  jobActivePids = [],
  processRecords = [],
}) {
  const rootCreated = Number.isSafeInteger(rootPid) && rootPid > 0;
  const activePids = new Set(jobActivePids);
  if (rootCreated && !rootExited) activePids.add(rootPid);
  const unknownExitPids = processRecords
    .filter((record) => !['exited', 'abnormally_exited'].includes(record.state) || !Number.isSafeInteger(record.exitCode))
    .map((record) => record.pid);
  if (rootCreated && (!rootExited || !Number.isSafeInteger(rootExitCode)) && !unknownExitPids.includes(rootPid)) {
    unknownExitPids.push(rootPid);
  }
  const rootStateKnown = rootCreated
    ? rootAssignedToJob || (rootExited && Number.isSafeInteger(rootExitCode))
    : rootCreationAttempted === true;
  const verified = rootStateKnown && activePids.size === 0 && unknownExitPids.length === 0;
  return Object.freeze({
    verified,
    activePids: Object.freeze([...activePids]),
    unknownExitPids: Object.freeze(unknownExitPids),
  });
}

export async function recoverSuspendedRootAssignment({
  assign,
  terminate,
  waitForExit,
  getExitCode,
  graceMs,
}) {
  if (typeof assign !== 'function') throw new Error('root assignment operation is required');
  let assigned = false;
  try {
    assigned = (await assign()) === true;
  } catch {
    assigned = false;
  }
  if (assigned) return Object.freeze({ assigned: true, termination: null });
  const termination = await terminateAndConfirmSuspendedRoot({ terminate, waitForExit, getExitCode, graceMs });
  return Object.freeze({ assigned: false, termination });
}

export async function awaitUntilDeadline(operation, deadlineAtMs, {
  phase = 'media smoke',
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0) {
    throw new Error('an absolute deadline is required');
  }
  const remainingMs = deadlineAtMs - now();
  if (remainingMs <= 0) {
    throw Object.assign(new Error(`${phase} deadline exceeded`), { code: 'MEDIA_SMOKE_DEADLINE' });
  }

  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimer(
      () => reject(Object.assign(new Error(`${phase} deadline exceeded`), { code: 'MEDIA_SMOKE_DEADLINE' })),
      remainingMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    clearTimer(timer);
  }
}

export function createShutdownState() {
  let request = null;
  return Object.freeze({
    requestStop(reason, requestedAtMonotonicMs = performance.now()) {
      if (!request) request = Object.freeze({ reason, requestedAtMonotonicMs });
      return request;
    },
    get requested() {
      return request;
    },
  });
}

export async function waitForActivityToStop(isActive, deadlines, shutdownState, {
  pollMs = 200,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof isActive !== 'function') throw new Error('an activity check is required');
  if (!deadlines || !Number.isFinite(deadlines.forceAtMonotonicMs) ||
      !Number.isSafeInteger(deadlines.shutdownGraceMs)) {
    throw new Error('media smoke deadline phases are required');
  }
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error('poll interval must be a positive integer');

  const overallStopAt = deadlines.forceAtMonotonicMs;
  const stopAt = () => {
    const request = shutdownState?.requested;
    if (!request) return overallStopAt;
    return Math.min(overallStopAt, request.requestedAtMonotonicMs + deadlines.shutdownGraceMs);
  };
  const operation = (async () => {
    while (await isActive()) {
      const currentTime = now();
      const remainingMs = stopAt() - currentTime;
      if (remainingMs <= 0) {
        const code = shutdownState?.requested ? 'MEDIA_SMOKE_SHUTDOWN_TIMEOUT' : 'MEDIA_SMOKE_DEADLINE';
        throw Object.assign(new Error('media smoke queue did not stop within its bounded grace period'), { code });
      }
      await sleep(Math.max(1, Math.min(pollMs, remainingMs)));
    }
    return true;
  })();
  return awaitUntilDeadline(operation, overallStopAt, {
    phase: 'media smoke queue shutdown',
    now,
  });
}

export function assessSupervisorLifecycle({
  creationCompleted,
  disposeAttempted = false,
  disposeConfirmed = false,
  diagnostics = [],
} = {}) {
  let state;
  if (!creationCompleted) state = 'creation_incomplete';
  else if (!disposeAttempted) state = 'not_attempted';
  else state = disposeConfirmed ? 'confirmed' : 'unconfirmed';
  return Object.freeze({
    state,
    supervisorDisposed: creationCompleted === true && disposeAttempted === true && disposeConfirmed === true,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

export async function publishReportWithHeldDirectory({
  openRoot,
  holdRoot,
  verifyIdentity,
  readProof,
  afterLeaseAcquired = async () => {},
  prepareReport = async () => reportContents,
  serializeReport = async (report) => report,
  createReportRelative,
  closeRoot,
  expectedProof,
  reportContents,
}) {
  for (const [name, operation] of Object.entries({
    openRoot,
    holdRoot,
    verifyIdentity,
    readProof,
    afterLeaseAcquired,
    prepareReport,
    serializeReport,
    createReportRelative,
    closeRoot,
  })) {
    if (typeof operation !== 'function') throw new Error(`${name} operation is required`);
  }

  let handle = null;
  let result = {
    state: 'not_started',
    identityConfirmed: false,
    reportWritten: false,
    handleReleased: false,
    diagnostics: [],
  };
  let stage = 'root_open';
  try {
    handle = await openRoot();
    if (!handle) {
      result = { ...result, state: 'root_open_failed', diagnostics: ['root handle unavailable'] };
    } else {
      stage = 'root_hold';
      if ((await holdRoot(handle)) !== true) {
        result = { ...result, state: 'root_hold_failed', diagnostics: ['root handle could not be held against rename/delete'] };
      } else {
        stage = 'root_identity';
        if ((await verifyIdentity(handle)) !== true) {
          result = { ...result, state: 'root_identity_unconfirmed', diagnostics: ['root identity could not be confirmed'] };
        } else {
          result.identityConfirmed = true;
          stage = 'proof_read';
          const proof = await readProof(handle);
          if (proof == null) {
            result = { ...result, state: 'proof_missing', diagnostics: ['ownership proof is missing'] };
          } else if (proof !== expectedProof) {
            result = { ...result, state: 'proof_mismatch', diagnostics: ['ownership proof does not match this run'] };
          } else {
            stage = 'after_lease_acquired';
            await afterLeaseAcquired(handle);
            stage = 'report_preparation';
            const preparedReport = await prepareReport(handle);
            stage = 'report_serialization';
            const serializedReport = await serializeReport(preparedReport);
            stage = 'report_create';
            const write = await createReportRelative(handle, serializedReport);
            if (write === 'exists') {
              result = { ...result, state: 'report_exists', diagnostics: ['report already exists'] };
            } else if (write !== true) {
              result = { ...result, state: 'report_write_failed', diagnostics: ['relative report creation failed'] };
            } else {
              stage = 'root_identity_after_write';
              if ((await verifyIdentity(handle)) !== true) {
                result = {
                  ...result,
                  state: 'root_identity_changed',
                  reportWritten: true,
                  diagnostics: ['root identity changed during report write'],
                };
              } else {
                result = { ...result, state: 'written', reportWritten: true };
              }
            }
          }
        }
      }
    }
  } catch (error) {
    let failureState = `${stage}_failed`;
    if (stage === 'report_create' && ['EEXIST', 'STATUS_OBJECT_NAME_COLLISION'].includes(error?.code)) {
      failureState = 'report_exists';
    }
    result = {
      ...result,
      state: result.reportWritten ? 'written_with_error' : failureState,
      diagnostics: [...result.diagnostics, error?.code || error?.message || 'root report operation failed'],
    };
  } finally {
    if (handle) {
      try {
        result.handleReleased = (await closeRoot(handle)) === true;
        if (!result.handleReleased) {
          result.state = result.reportWritten ? 'written_handle_release_unconfirmed' : 'handle_release_unconfirmed';
          result.diagnostics = [...result.diagnostics, 'root handle release was not confirmed'];
        }
      } catch (error) {
        result.state = result.reportWritten ? 'written_handle_release_unconfirmed' : 'handle_release_unconfirmed';
        result.diagnostics = [...result.diagnostics, error?.code || error?.message || 'root handle release failed'];
      }
    }
  }
  return Object.freeze({ ...result, diagnostics: Object.freeze(result.diagnostics) });
}
