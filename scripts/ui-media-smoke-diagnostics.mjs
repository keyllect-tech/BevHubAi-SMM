import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const REGISTRATION_MESSAGES = new Set([
  'Укажите имя',
  'Некорректный email',
  'Пароль должен быть не менее 8 символов',
  'Пароль слишком длинный',
  'Пользователь с таким email уже зарегистрирован',
]);

export const UI_MEDIA_SMOKE_STOP_COMMAND = '__UI_MEDIA_SMOKE_STOP__';
const CHILD_PROCESS_METHODS = ['spawn', 'exec', 'execFile', 'fork'];
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// Unrecognized request methods are collapsed to this single neutral label by
// recordRequest(); nothing else may reach the report.
const SAFE_REQUEST_METHODS = new Set([...SAFE_HTTP_METHODS, 'OTHER']);
const SAFE_JOB_STATUSES = new Set(['queued', 'processing', 'completed', 'failed']);
const SAFE_RESULTS = new Set(['running', 'video-rendered', 'completed', 'failed']);
const SAFE_VIDEO_LANGUAGES = new Set(['ru', 'uz', 'en']);
const SAFE_VIDEO_STYLES = new Set(['product', 'dynamic', 'premium', 'ugc']);
const SAFE_VIDEO_VOICE_TYPES = new Set(['male', 'female']);
const SAFE_VIDEO_CATEGORIES = new Set(['product', 'realty', 'food', 'shop', 'service', 'job', 'event', 'other']);
const SAFE_VIDEO_SCRIPT_SOURCES = new Set([
  'ai:openai',
  'ai:custom',
  'ai:ollama',
  'template',
  'openai',
  'ollama',
  'fallback',
]);
const SAFE_VIDEO_RESPONSE_MESSAGES = new Set([
  'Некорректный запрос (clientRequestId)',
  'Укажите название товара',
  'Добавьте описание товара',
  'Укажите призыв к действию (CTA)',
  'Неподдерживаемый язык',
  'Неподдерживаемый стиль видео',
  'Загрузите фото товара',
  'Не больше 10 фото',
  'Фото не найдено. Загрузите его заново.',
  'Проект не найден',
  'Website URL должен начинаться с http:// или https://',
  'Лимит генераций на этот месяц исчерпан. Смените тариф в разделе Billing.',
  'Опишите рекламу подробнее (минимум 15 символов)',
  'Synthetic harness error',
]);
const SAFE_VIDEO_RESPONSE_CATEGORIES = new Set([
  'accepted',
  'created',
  'incomplete',
  'rejected',
  'server-error',
  'unrecognized',
]);
const SAFE_VIDEO_CONTENT_TYPES = new Set([
  'application/json',
  'text/plain',
  'text/html',
  'other',
  'missing',
]);
const SAFE_FILE_CHECK_STATES = new Set(['checked', 'not-run', 'unavailable']);
const SAFE_SHUTDOWN_RESULTS = new Set(['verified', 'incomplete']);
const SAFE_STAGES = new Set([
  'harness-starting',
  'harness-ready',
  'registration-request-sent',
  'user-registered',
  'registration-failed',
  'project-created',
  'image-uploaded',
  'script-generated',
  'video-created',
  'job-processing',
  'job-completed',
  'job-failed',
  'api-error',
  'http-download-completed',
  'graceful-shutdown',
  'completed',
  'failed',
  'verification-failed',
  'monitor-failed',
  'harness-startup-failed',
]);
const SAFE_FAILURE_REASONS = new Set([
  'timeout',
  'graceful-shutdown',
  'harness-stopped',
  'uncaught-exception',
  'generation-failed',
  'registration-http-error',
  'verification-failed',
  'monitor-failed',
  'harness-startup-failed',
  'child-process-cleanup-failed',
]);
const SAFE_ENDPOINT_LABELS = new Set([
  'api.health',
  'api.fixture-image',
  'api.auth.register',
  'api.auth.login',
  'api.dashboard',
  'api.projects',
  'api.files',
  'api.scripts',
  'api.videos',
  'api.files.item',
  'api.videos.file',
  'api.videos.retry',
  'api.videos.item',
  'api.other',
  'ui.other',
  'ui.document',
  'ui.api-proxy',
  'ui.vite',
  'ui.source',
  'ui.videos',
  'ui.video-detail',
  'ui.create',
  'ui.auth',
  'ui.asset',
  'ui.page',
]);
const SAFE_PROCESS_COMMANDS = new Set(['ffmpeg', 'ffprobe', 'powershell', 'child-process']);
const SAFE_PROCESS_ERRORS = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
  'EBUSY',
  'ECONNRESET',
  'ERR_UNKNOWN_SIGNAL',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_SERVER_NOT_RUNNING',
  'ERR_STREAM_PREMATURE_CLOSE',
]);
const SAFE_CLEANUP_ERRORS = new Set([
  ...SAFE_PROCESS_ERRORS,
  'child-process-cleanup-failed',
  'close-error',
  'cleanup-error',
]);
const SAFE_PROCESS_FAILURES = new Set([
  'termination-request-rejected',
  'termination-request-failed',
  'graceful-stop-timeout',
  'force-stop-request-rejected',
  'force-stop-request-failed',
  'force-stop-timeout',
]);
const REPORT_EXTRA_KEYS = new Set([
  'result',
  'harnessPid',
  'createdAt',
  'disposableRoot',
  'projectId',
  'videoId',
  'script',
  'tts',
  'rendering',
  'mp4Path',
  'sizeBytes',
  'sha256',
  'durationSec',
  'resolution',
  'videoCodec',
  'audioCodec',
  'generationStatus',
  'jobStatus',
  'httpDownload',
  'requests',
  'apiDownloadEndpointTested',
  'childProcessCleanup',
  'failureReason',
]);

export function safeCleanupErrorCode(error, fallback = 'cleanup-error') {
  const code = error?.code;
  if (SAFE_CLEANUP_ERRORS.has(code)) return code;
  return SAFE_CLEANUP_ERRORS.has(fallback) ? fallback : 'cleanup-error';
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  return isPlainObject(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isPathWithin(root, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isSafeTextMetadata(value) {
  const types = new Set(['string', 'null', 'undefined', 'array', 'object', 'number', 'boolean', 'function', 'symbol', 'bigint']);
  if (!hasExactKeys(value, ['present', 'type', 'length'])
    || typeof value.present !== 'boolean'
    || !types.has(value.type)) return false;
  if (value.type === 'string') {
    return Number.isInteger(value.length)
      && value.length >= 0
      && value.present === (value.length > 0);
  }
  if (value.type === 'null' || value.type === 'undefined') {
    return value.present === false && value.length === null;
  }
  return value.present === true && value.length === null;
}

function isSafeScriptSummary(value) {
  return hasExactKeys(value, ['source', 'hook', 'body', 'cta'])
    && (value.source === 'template' || value.source === 'other')
    && isSafeTextMetadata(value.hook)
    && isSafeTextMetadata(value.body)
    && isSafeTextMetadata(value.cta);
}

function isSafeRequest(value) {
  return hasExactKeys(value, ['method', 'endpoint', 'status', 'timestamp', 'source'])
    && SAFE_REQUEST_METHODS.has(value.method)
    && SAFE_ENDPOINT_LABELS.has(value.endpoint)
    && (value.status === null || isHttpStatus(value.status))
    && isIsoTimestamp(value.timestamp)
    && (value.source === 'API' || value.source === 'UI');
}

function isSafeHttpDownload(value) {
  return hasExactKeys(value, ['headStatus', 'getStatus'])
    && (value.headStatus === null || isHttpStatus(value.headStatus))
    && (value.getStatus === null || isHttpStatus(value.getStatus));
}

function isSafeChildProcessCleanup(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['children', 'blockedLaunches', 'cleanupError'].includes(key))) return false;
  if (!Array.isArray(value.children) || !Array.isArray(value.blockedLaunches)) return false;
  if (value.cleanupError !== undefined && !SAFE_CLEANUP_ERRORS.has(value.cleanupError)) return false;
  const childrenAreSafe = value.children.every((child) =>
    hasExactKeys(child, [
      'pid',
      'command',
      'status',
      'exitCode',
      'signal',
      'errorCode',
      'stopFailureReason',
      'stopRequested',
      'forceStopAttempted',
    ])
      && Number.isInteger(child.pid)
      && child.pid > 0
      && SAFE_PROCESS_COMMANDS.has(child.command)
      && (child.status === 'running' || child.status === 'closed')
      && (child.exitCode === null || (Number.isInteger(child.exitCode) && child.exitCode >= 0))
      && (child.signal === null || ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGBREAK'].includes(child.signal))
      && (child.errorCode === null || SAFE_PROCESS_ERRORS.has(child.errorCode) || child.errorCode === 'child-error')
      && (child.stopFailureReason === null || SAFE_PROCESS_FAILURES.has(child.stopFailureReason))
      && typeof child.stopRequested === 'boolean'
      && typeof child.forceStopAttempted === 'boolean');
  const blockedLaunchesAreSafe = value.blockedLaunches.every((launch) =>
    hasExactKeys(launch, ['command', 'reason'])
      && SAFE_PROCESS_COMMANDS.has(launch.command)
      && launch.reason === 'shutdown-in-progress');
  return childrenAreSafe && blockedLaunchesAreSafe;
}

function assertSafeFailureReason(value) {
  if (value === null || value === undefined) return;
  if (SAFE_FAILURE_REASONS.has(value)) return;
  if (typeof value === 'string' && /^api-http-(?:[1-5]\d\d)$/.test(value)) return;
  throw new TypeError('invalid diagnostic failure reason');
}

function assertSafeReportExtra(extra, disposableRoot, isolation) {
  if (!isPlainObject(extra)) throw new TypeError('report fields must be a plain object');
  for (const [key, value] of Object.entries(extra)) {
    if (!REPORT_EXTRA_KEYS.has(key)) throw new TypeError(`unsupported report field: ${key}`);
    let valid = false;
    switch (key) {
      case 'result':
        valid = SAFE_RESULTS.has(value);
        break;
      case 'harnessPid':
        valid = Number.isSafeInteger(value) && value > 0;
        break;
      case 'createdAt':
        valid = isIsoTimestamp(value);
        break;
      case 'disposableRoot':
        valid = typeof value === 'string' && path.resolve(value) === path.resolve(disposableRoot);
        break;
      case 'projectId':
      case 'videoId':
        valid = isUuid(value);
        break;
      case 'script':
        valid = isSafeScriptSummary(value);
        break;
      case 'tts':
        valid = hasExactKeys(value, ['kind', 'voiceLanguage', 'exactLanguage', 'status'])
          && value.kind === 'tts-windows-sapi'
          && typeof value.voiceLanguage === 'string'
          && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value.voiceLanguage)
          && typeof value.exactLanguage === 'boolean'
          && ['verified', 'unexpected-provider'].includes(value.status);
        break;
      case 'rendering':
        valid = hasExactKeys(value, ['status', 'renderer'])
          && value.status === 'verified'
          && value.renderer === 'bundled-ffmpeg';
        break;
      case 'mp4Path':
        try {
          valid = isPathWithin(disposableRoot, value)
            && path.resolve(isolation.assertPath(value)) === path.resolve(value);
        } catch {
          valid = false;
        }
        break;
      case 'sizeBytes':
        valid = Number.isSafeInteger(value) && value >= 0;
        break;
      case 'sha256':
        valid = typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
        break;
      case 'durationSec':
        valid = typeof value === 'number' && Number.isFinite(value) && value >= 0;
        break;
      case 'resolution':
        valid = value === '1080x1920';
        break;
      case 'videoCodec':
        valid = value === 'h264';
        break;
      case 'audioCodec':
        valid = value === 'aac';
        break;
      case 'generationStatus':
      case 'jobStatus':
        valid = value === null || SAFE_JOB_STATUSES.has(value);
        break;
      case 'httpDownload':
        valid = isSafeHttpDownload(value);
        break;
      case 'requests':
        valid = Array.isArray(value) && value.every(isSafeRequest);
        break;
      case 'apiDownloadEndpointTested':
        valid = typeof value === 'boolean';
        break;
      case 'childProcessCleanup':
        valid = isSafeChildProcessCleanup(value);
        break;
      case 'failureReason':
        try {
          assertSafeFailureReason(value);
          valid = true;
        } catch {
          valid = false;
        }
        break;
      default:
        valid = false;
    }
    if (!valid) throw new TypeError(`invalid report field: ${key}`);
  }
  return JSON.parse(JSON.stringify(extra));
}

function commandLabel(command) {
  const firstArgument = String(command || '').trim().match(/^"([^"]+)"|^'([^']+)'|^([^\s]+)/);
  const executable = firstArgument?.[1] || firstArgument?.[2] || firstArgument?.[3] || '';
  const basename = path.basename(executable).toLowerCase();
  const labels = {
    'ffmpeg': 'ffmpeg',
    'ffmpeg.exe': 'ffmpeg',
    'ffprobe': 'ffprobe',
    'ffprobe.exe': 'ffprobe',
    'powershell.exe': 'powershell',
    'pwsh.exe': 'powershell',
  };
  return labels[basename] || 'child-process';
}

export function safeEndpointLabel(input, source) {
  let pathname;
  try {
    pathname = new URL(String(input), 'http://127.0.0.1').pathname;
  } catch {
    return source === 'API' ? 'api.other' : 'ui.other';
  }

  if (source === 'API') {
    const exactLabels = new Map([
      ['/api/health', 'api.health'],
      ['/api/__smoke/image.png', 'api.fixture-image'],
      ['/api/auth/register', 'api.auth.register'],
      ['/api/auth/login', 'api.auth.login'],
      ['/api/dashboard', 'api.dashboard'],
      ['/api/projects', 'api.projects'],
      ['/api/files', 'api.files'],
      ['/api/scripts', 'api.scripts'],
      ['/api/videos', 'api.videos'],
    ]);
    if (exactLabels.has(pathname)) return exactLabels.get(pathname);
    if (/^\/api\/files\/[^/]+$/.test(pathname)) return 'api.files.item';
    if (/^\/api\/videos\/[^/]+\/file$/.test(pathname)) return 'api.videos.file';
    if (/^\/api\/videos\/[^/]+\/retry$/.test(pathname)) return 'api.videos.retry';
    if (/^\/api\/videos\/[^/]+$/.test(pathname)) return 'api.videos.item';
    return 'api.other';
  }

  if (source !== 'UI') return 'other';
  if (pathname === '/') return 'ui.document';
  if (pathname.startsWith('/api/')) return 'ui.api-proxy';
  if (pathname.startsWith('/@vite/')) return 'ui.vite';
  if (pathname.startsWith('/src/')) return 'ui.source';
  if (pathname === '/videos') return 'ui.videos';
  if (/^\/videos\/[^/]+$/.test(pathname)) return 'ui.video-detail';
  if (pathname === '/create') return 'ui.create';
  if (/^\/(?:login|register)$/.test(pathname)) return 'ui.auth';
  if (/^\/assets\//.test(pathname) || /\.(?:js|css|tsx|svg|png|jpe?g|woff2?)$/i.test(pathname)) {
    return 'ui.asset';
  }
  return 'ui.page';
}

export function safeTextMetadata(value) {
  if (typeof value === 'string') return { present: value.length > 0, type: 'string', length: value.length };
  if (value === null || value === undefined) return { present: false, type: value === null ? 'null' : 'undefined', length: null };
  return { present: true, type: Array.isArray(value) ? 'array' : typeof value, length: null };
}

function safeEnum(value, allowedValues) {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  return allowedValues.has(value) ? value : 'other';
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isSafeVideoPayloadSummary(value) {
  if (!hasExactKeys(value, [
    'clientRequestId',
    'projectId',
    'productName',
    'description',
    'pricePresent',
    'ctaPresent',
    'websiteUrl',
    'language',
    'style',
    'voiceType',
    'category',
    'fileIds',
    'script',
    'scriptSource',
  ])) return false;
  if (!hasExactKeys(value.clientRequestId, ['present', 'validUuid'])
    || typeof value.clientRequestId.present !== 'boolean'
    || typeof value.clientRequestId.validUuid !== 'boolean'
    || (!value.clientRequestId.present && value.clientRequestId.validUuid)) return false;
  if (!['null', 'present'].includes(value.projectId)
    || !isSafeTextMetadata(value.productName)
    || !isSafeTextMetadata(value.description)
    || typeof value.pricePresent !== 'boolean'
    || typeof value.ctaPresent !== 'boolean') return false;
  if (!hasExactKeys(value.websiteUrl, ['present', 'valid'])
    || typeof value.websiteUrl.present !== 'boolean'
    || (value.websiteUrl.present && typeof value.websiteUrl.valid !== 'boolean')
    || (!value.websiteUrl.present && value.websiteUrl.valid !== null)) return false;
  if (!['ru', 'uz', 'en', 'other', 'missing'].includes(value.language)
    || !['product', 'dynamic', 'premium', 'ugc', 'other', 'missing'].includes(value.style)
    || !['male', 'female', 'other', 'missing'].includes(value.voiceType)
    || ![...SAFE_VIDEO_CATEGORIES, 'missing'].includes(value.category)
    || ![...SAFE_VIDEO_SCRIPT_SOURCES, 'other', 'missing'].includes(value.scriptSource)) return false;
  if (!hasExactKeys(value.fileIds, [
    'count',
    'allUuid',
    'workspaceOwnedCount',
    'presentOnDiskCount',
    'checkState',
  ])
    || !Number.isSafeInteger(value.fileIds.count)
    || value.fileIds.count < 0
    || typeof value.fileIds.allUuid !== 'boolean'
    || !SAFE_FILE_CHECK_STATES.has(value.fileIds.checkState)) return false;
  for (const key of ['workspaceOwnedCount', 'presentOnDiskCount']) {
    const count = value.fileIds[key];
    if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > value.fileIds.count)) return false;
  }
  if ((value.fileIds.checkState === 'checked')
    !== (value.fileIds.workspaceOwnedCount !== null && value.fileIds.presentOnDiskCount !== null)) return false;
  if (value.fileIds.presentOnDiskCount !== null
    && value.fileIds.workspaceOwnedCount !== null
    && value.fileIds.presentOnDiskCount > value.fileIds.workspaceOwnedCount) return false;
  return hasExactKeys(value.script, ['present', 'hook', 'benefit1', 'benefit2', 'cta'])
    && ['present', 'hook', 'benefit1', 'benefit2', 'cta'].every((key) => typeof value.script[key] === 'boolean');
}

function isSafeVideoCreationResult(value) {
  return hasExactKeys(value, ['status', 'contentType', 'response', 'payload'])
    && (value.status === null || isHttpStatus(value.status))
    && SAFE_VIDEO_CONTENT_TYPES.has(value.contentType)
    && hasExactKeys(value.response, ['category', 'error'])
    && SAFE_VIDEO_RESPONSE_CATEGORIES.has(value.response.category)
    && (value.response.error === null || SAFE_VIDEO_RESPONSE_MESSAGES.has(value.response.error))
    && (value.payload === null || isSafeVideoPayloadSummary(value.payload));
}

export function summarizeVideoCreatePayload(body, fileChecks = null, fileCheckState = 'not-run') {
  const payload = isPlainObject(body) ? body : {};
  const fileIds = Array.isArray(payload.fileIds) ? payload.fileIds : [];
  const script = isPlainObject(payload.script) ? payload.script : null;
  const presentScriptField = (key) =>
    typeof script?.[key] === 'string' && script[key].trim().length > 0;
  const validChecks = fileCheckState === 'checked' && Array.isArray(fileChecks)
    ? fileChecks.filter((check) => isPlainObject(check)
      && typeof check.workspaceOwned === 'boolean'
      && typeof check.presentOnDisk === 'boolean')
    : null;
  const checksAreComplete = validChecks !== null && validChecks.length === fileIds.length;
  const effectiveCheckState = checksAreComplete
    ? 'checked'
    : fileCheckState === 'unavailable'
      ? 'unavailable'
      : fileCheckState === 'checked'
        ? 'unavailable'
        : 'not-run';
  const workspaceOwnedCount = checksAreComplete
    ? validChecks.filter((check) => check.workspaceOwned).length
    : null;
  const presentOnDiskCount = checksAreComplete
    ? validChecks.filter((check) => check.presentOnDisk).length
    : null;
  const clientRequestId = payload.clientRequestId;
  const websiteUrl = typeof payload.websiteUrl === 'string' ? payload.websiteUrl.trim() : '';

  return {
    clientRequestId: {
      present: typeof clientRequestId === 'string' && clientRequestId.length > 0,
      validUuid: isUuid(clientRequestId),
    },
    projectId: payload.projectId === null || payload.projectId === undefined ? 'null' : 'present',
    productName: safeTextMetadata(payload.productName),
    description: safeTextMetadata(payload.description),
    pricePresent: Object.prototype.hasOwnProperty.call(payload, 'price'),
    ctaPresent: Object.prototype.hasOwnProperty.call(payload, 'cta'),
    websiteUrl: {
      present: websiteUrl.length > 0,
      valid: websiteUrl.length > 0 ? isValidHttpUrl(websiteUrl) : null,
    },
    language: safeEnum(payload.language, SAFE_VIDEO_LANGUAGES),
    style: safeEnum(payload.style, SAFE_VIDEO_STYLES),
    voiceType: safeEnum(payload.voiceType, SAFE_VIDEO_VOICE_TYPES),
    category: safeEnum(payload.category, SAFE_VIDEO_CATEGORIES),
    fileIds: {
      count: fileIds.length,
      allUuid: fileIds.length > 0 && fileIds.every(isUuid),
      workspaceOwnedCount,
      presentOnDiskCount,
      checkState: effectiveCheckState,
    },
    script: {
      present: script !== null,
      hook: presentScriptField('hook'),
      benefit1: presentScriptField('benefit1'),
      benefit2: presentScriptField('benefit2'),
      cta: presentScriptField('cta'),
    },
    scriptSource: safeEnum(payload.scriptSource, SAFE_VIDEO_SCRIPT_SOURCES),
  };
}

export function summarizeVideoCreateResponse(status, contentType, responseBody, payload = null) {
  const normalizedType = typeof contentType === 'string'
    ? contentType.split(';', 1)[0].trim().toLowerCase()
    : '';
  const safeContentType = SAFE_VIDEO_CONTENT_TYPES.has(normalizedType)
    ? normalizedType
    : normalizedType
      ? 'other'
      : 'missing';
  if (status === null) {
    return { status: null, contentType: safeContentType, response: { category: 'incomplete', error: null }, payload };
  }

  let category = status >= 500 ? 'server-error' : 'rejected';
  let error = null;
  if (status >= 200 && status < 300) {
    category = status === 201 ? 'created' : 'accepted';
  } else if (typeof responseBody?.error === 'string') {
    if (SAFE_VIDEO_RESPONSE_MESSAGES.has(responseBody.error)) {
      error = responseBody.error;
    } else {
      category = 'unrecognized';
    }
  } else {
    category = 'unrecognized';
  }
  return {
    status,
    contentType: safeContentType,
    response: { category, error },
    payload,
  };
}

export function safeScriptSummary(video) {
  return {
    source: video.script_source === 'template' ? 'template' : 'other',
    hook: safeTextMetadata(video.script_hook),
    body: safeTextMetadata(video.script_body),
    cta: safeTextMetadata(video.script_cta),
  };
}

export function createIdempotentShutdown(shutdown) {
  let shutdownPromise = null;
  return (...args) => {
    if (!shutdownPromise) {
      try {
        shutdownPromise = Promise.resolve(shutdown(...args));
      } catch (error) {
        shutdownPromise = Promise.reject(error);
      }
    }
    return shutdownPromise;
  };
}

export function createVideoDiagnosticCompletion({ diagnostics, onComplete }) {
  if (!diagnostics || typeof diagnostics.setVideoCreationResult !== 'function'
    || typeof onComplete !== 'function') {
    throw new TypeError('video diagnostic completion dependencies are required');
  }
  let completed = false;
  return (result) => {
    if (completed) return false;
    completed = true;
    try {
      diagnostics.setVideoCreationResult(result);
    } finally {
      onComplete();
    }
    return true;
  };
}

export function createChildProcessRegistry({
  childProcessApi,
  syncBuiltinESMExports = () => {},
  stopTimeoutMs = 5000,
  forceStopTimeoutMs = 1000,
}) {
  if (!childProcessApi) throw new Error('child process API is required');
  const originals = new Map();
  const wrappers = new Map();
  const children = new Map();
  const blockedLaunches = [];
  let closing = false;
  let restored = false;
  let stopPromise = null;

  function track(child, command) {
    if (!child || !Number.isInteger(child.pid)) return child;
    if (!children.has(child)) {
      let resolveClosed;
      const entry = {
        pid: child.pid,
        command: commandLabel(command),
        status: 'running',
        exitCode: null,
        signal: null,
        errorCode: null,
        stopFailureReason: null,
        stopRequested: false,
        forceStopAttempted: false,
        closed: new Promise((resolve) => { resolveClosed = resolve; }),
      };
      entry.child = child;
      child.once('error', (error) => {
        entry.errorCode = SAFE_PROCESS_ERRORS.has(error?.code) ? error.code : 'child-error';
      });
      child.once('close', (exitCode, signal) => {
        entry.status = 'closed';
        entry.exitCode = Number.isInteger(exitCode) ? exitCode : null;
        entry.signal = typeof signal === 'string' ? signal : null;
        if (entry.stopFailureReason === 'termination-request-rejected') entry.stopFailureReason = null;
        resolveClosed();
      });
      children.set(child, entry);
    }
    return child;
  }

  for (const method of CHILD_PROCESS_METHODS) {
    if (typeof childProcessApi[method] !== 'function') continue;
    const original = childProcessApi[method];
    originals.set(method, original);
    const wrapper = function (...args) {
      const label = commandLabel(args[0]);
      if (closing) {
        blockedLaunches.push({ command: label, reason: 'shutdown-in-progress' });
        throw Object.assign(new Error('Child process launch blocked during harness shutdown'), {
          code: 'ERR_HARNESS_SHUTTING_DOWN',
        });
      }
      return track(original.apply(this, args), args[0]);
    };
    wrappers.set(method, wrapper);
    childProcessApi[method] = wrapper;
  }
  syncBuiltinESMExports();

  function snapshot() {
    return {
      children: [...children.values()].map(({ child, closed, ...entry }) => ({ ...entry })),
      blockedLaunches: blockedLaunches.map((entry) => ({ ...entry })),
    };
  }

  function stopOwnedChildren(timeoutMs = stopTimeoutMs) {
    if (stopPromise) return stopPromise;
    closing = true;
    stopPromise = (async () => {
      const active = [...children.values()].filter((entry) => entry.status === 'running');
      for (const entry of active) {
        entry.stopRequested = true;
        try {
          if (!entry.child.kill('SIGTERM') && entry.status === 'running') {
            entry.stopFailureReason = 'termination-request-rejected';
          }
        } catch {
          entry.stopFailureReason = 'termination-request-failed';
        }
      }
      async function waitFor(entries, waitMs) {
        const pending = entries.filter((entry) => entry.status === 'running');
        if (!pending.length) return;
        let timer;
        await Promise.race([
          Promise.all(pending.map((entry) => entry.closed)),
          new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
        ]);
        clearTimeout(timer);
      }
      await waitFor(active, timeoutMs);
      const unclosed = active.filter((entry) => entry.status === 'running');
      for (const entry of unclosed) {
        entry.stopFailureReason ||= 'graceful-stop-timeout';
        entry.forceStopAttempted = true;
        try {
          if (!entry.child.kill('SIGKILL') && entry.status === 'running') {
            entry.stopFailureReason = 'force-stop-request-rejected';
          }
        } catch {
          entry.stopFailureReason = 'force-stop-request-failed';
        }
      }
      await waitFor(unclosed, forceStopTimeoutMs);
      for (const entry of children.values()) {
        if (entry.status === 'running' && !entry.stopFailureReason) {
          entry.stopFailureReason = 'force-stop-timeout';
        }
      }
      return snapshot();
    })();
    return stopPromise;
  }

  function restore() {
    if (restored) return;
    restored = true;
    for (const [method, original] of originals) {
      if (childProcessApi[method] === wrappers.get(method)) childProcessApi[method] = original;
    }
    syncBuiltinESMExports();
  }

  return { snapshot, stopOwnedChildren, restore };
}

export function createStopCommandParser(onStop) {
  let input = '';
  let stopped = false;
  return (chunk) => {
    if (stopped) return;
    input += chunk;
    const lines = input.split(/\r?\n/);
    input = lines.pop() || '';
    if (lines.some((line) => line.trim() === UI_MEDIA_SMOKE_STOP_COMMAND)) {
      stopped = true;
      onStop();
    }
  };
}

export function summarizeRegistrationResponse(status, payload) {
  if (status >= 200 && status < 300) return { category: 'accepted' };
  const message = typeof payload?.error === 'string' ? payload.error : '';
  if (REGISTRATION_MESSAGES.has(message)) {
    return { category: 'rejected', message };
  }
  return { category: status >= 500 ? 'server-error' : 'rejected' };
}

export function writeAtomicReport(isolation, reportPath, report, { fileSystem = fs } = {}) {
  if (!isolation?.assertPath) throw new Error('isolated path policy is required');
  const targetPath = isolation.assertPath(reportPath);
  const directory = isolation.assertPath(path.dirname(targetPath));
  const temporaryPath = isolation.assertPath(
    path.join(directory, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`),
  );
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const descriptor = fileSystem.openSync(temporaryPath, 'wx', 0o600);
  let descriptorOpen = true;
  try {
    fileSystem.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptorOpen = false;
    isolation.assertPath(temporaryPath);
    isolation.assertPath(targetPath);
    fileSystem.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (descriptorOpen) fileSystem.closeSync(descriptor);
    throw error;
  }
  return report;
}

export function writeShutdownReport(isolation, reportPath, report, options = {}) {
  const expectedKeys = [
    'result',
    'harnessPid',
    'childProcessCount',
    'childProcessesClosed',
    'apiServerClosed',
    'uiServerClosed',
    'databaseClosed',
    'apiPortReleased',
    'uiPortReleased',
    'createdAt',
  ];
  const allChecksPassed = report
    && report.childProcessesClosed === true
    && report.apiServerClosed === true
    && report.uiServerClosed === true
    && report.databaseClosed === true
    && report.apiPortReleased === true
    && report.uiPortReleased === true;
  if (!hasExactKeys(report, expectedKeys)
    || !SAFE_SHUTDOWN_RESULTS.has(report.result)
    || report.result !== (allChecksPassed ? 'verified' : 'incomplete')
    || !Number.isSafeInteger(report.harnessPid)
    || report.harnessPid < 1
    || !Number.isSafeInteger(report.childProcessCount)
    || report.childProcessCount < 0
    || typeof report.childProcessesClosed !== 'boolean'
    || ![true, false, null].includes(report.apiServerClosed)
    || ![true, false, null].includes(report.uiServerClosed)
    || ![true, false, null].includes(report.databaseClosed)
    || ![true, false, null].includes(report.apiPortReleased)
    || ![true, false, null].includes(report.uiPortReleased)
    || !isIsoTimestamp(report.createdAt)) {
    throw new TypeError('invalid shutdown report');
  }
  return writeAtomicReport(isolation, reportPath, report, options);
}

export async function verifyLoopbackPortReleased(
  port,
  { createServer = net.createServer, host = '127.0.0.1', timeoutMs = 1000 } = {},
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || typeof createServer !== 'function'
    || !Number.isFinite(timeoutMs)
    || timeoutMs < 0) return false;
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    let timer;
    const finish = (released) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(released);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => {
      server.close((error) => finish(!error));
    });
    timer = setTimeout(() => {
      try {
        server.close(() => {});
      } catch {
        // A pending bind may not yet be closable; the listening callback closes it if it succeeds.
      }
      finish(false);
    }, timeoutMs);
    server.listen(port, host);
  });
}

export function createUiMediaDiagnostics({
  isolation,
  reportPath,
  disposableRoot,
  clock = () => new Date(),
  fileSystem = fs,
}) {
  if (!isolation?.assertPath) throw new Error('isolated path policy is required');
  isolation.assertPath(reportPath);
  isolation.assertPath(disposableRoot);

  const state = {
    lastStage: 'harness-starting',
    requests: [],
    registrationSent: false,
    registrationStatus: null,
    safeRegistrationResponse: null,
    syntheticUserCreated: false,
    userId: null,
    videoId: null,
    lastJobStatus: null,
    failureReason: null,
    disposableRoot,
    httpDownload: { headStatus: null, getStatus: null },
    videoCreation: null,
  };
  let reportDetails = {};
  let acceptingUpdates = true;
  let finalizationAttempted = false;
  let finalReport = null;

  function assertSafeState() {
    if (!SAFE_STAGES.has(state.lastStage)) throw new TypeError('invalid diagnostic stage');
    assertSafeFailureReason(state.failureReason);
    if (state.disposableRoot !== disposableRoot) throw new TypeError('invalid disposable root');
    if (typeof state.registrationSent !== 'boolean'
      || (state.registrationStatus !== null && !isHttpStatus(state.registrationStatus))
      || typeof state.syntheticUserCreated !== 'boolean'
      || (state.userId !== null && !isUuid(state.userId))
      || (state.videoId !== null && !isUuid(state.videoId))
      || (state.lastJobStatus !== null && !SAFE_JOB_STATUSES.has(state.lastJobStatus))
      || !isSafeHttpDownload(state.httpDownload)
      || (state.videoCreation !== null && !isSafeVideoCreationResult(state.videoCreation))
      || !Array.isArray(state.requests)
      || !state.requests.every(isSafeRequest)) {
      throw new TypeError('invalid diagnostic state');
    }
    if (state.safeRegistrationResponse !== null) {
      const response = state.safeRegistrationResponse;
      const validResponse = hasExactKeys(response, ['category'])
        && ['accepted', 'rejected', 'server-error'].includes(response.category);
      const validRejectedMessage = hasExactKeys(response, ['category', 'message'])
        && response.category === 'rejected'
        && REGISTRATION_MESSAGES.has(response.message);
      if (!validResponse && !validRejectedMessage) {
        throw new TypeError('invalid registration summary');
      }
    }
  }

  function snapshot(extra = {}) {
    const safeExtra = assertSafeReportExtra(extra, disposableRoot, isolation);
    assertSafeState();
    return {
      ...safeExtra,
      ...state,
      requests: state.requests.map((request) => ({ ...request })),
      videoCreation: state.videoCreation ? JSON.parse(JSON.stringify(state.videoCreation)) : null,
      updatedAt: clock().toISOString(),
    };
  }

  function persist(extra = {}) {
    if (!acceptingUpdates || finalizationAttempted) return finalReport;
    const safeExtra = assertSafeReportExtra(extra, disposableRoot, isolation);
    reportDetails = { ...reportDetails, ...safeExtra };
    const report = snapshot(reportDetails);
    writeAtomicReport(isolation, reportPath, report, { fileSystem });
    return report;
  }

  function finalize(extra = {}) {
    if (finalizationAttempted) return finalReport;
    const safeExtra = assertSafeReportExtra(extra, disposableRoot, isolation);
    assertSafeState();
    acceptingUpdates = false;
    finalizationAttempted = true;
    reportDetails = { ...reportDetails, ...safeExtra };
    finalReport = {
      ...reportDetails,
      ...state,
      ...safeExtra,
      requests: state.requests.map((request) => ({ ...request })),
      videoCreation: state.videoCreation ? JSON.parse(JSON.stringify(state.videoCreation)) : null,
      updatedAt: clock().toISOString(),
    };
    writeAtomicReport(isolation, reportPath, finalReport, { fileSystem });
    return finalReport;
  }

  function beginShutdown({ failureReason, lastStage } = {}) {
    if (!acceptingUpdates) return false;
    assertSafeFailureReason(failureReason);
    if (lastStage !== undefined && !SAFE_STAGES.has(lastStage)) {
      throw new TypeError('invalid diagnostic stage');
    }
    if (failureReason) state.failureReason = failureReason;
    if (lastStage) state.lastStage = lastStage;
    acceptingUpdates = false;
    return true;
  }

  function setStage(lastStage, options = {}) {
    if (!acceptingUpdates) return false;
    if (!SAFE_STAGES.has(lastStage)) throw new TypeError('invalid diagnostic stage');
    if (!isPlainObject(options)
      || Object.keys(options).some((key) => key !== 'persistReport')
      || (options.persistReport !== undefined && typeof options.persistReport !== 'boolean')) {
      throw new TypeError('invalid stage options');
    }
    state.lastStage = lastStage;
    if (options.persistReport !== false) persist();
    return true;
  }

  function setFailure(failureReason, lastStage = 'failed') {
    if (!acceptingUpdates) return false;
    assertSafeFailureReason(failureReason);
    if (!SAFE_STAGES.has(lastStage)) throw new TypeError('invalid diagnostic stage');
    state.failureReason = failureReason;
    state.lastStage = lastStage;
    persist();
    return true;
  }

  function recordRequest({ method, url, status, timestamp = clock().toISOString(), source }) {
    if (!acceptingUpdates) return null;
    if (source !== 'UI' && source !== 'API') throw new Error('request source must be UI or API');
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if ((status !== undefined && status !== null && !isHttpStatus(status)) || !isIsoTimestamp(timestamp)) {
      throw new TypeError('invalid HTTP diagnostic metadata');
    }
    const request = {
      method: SAFE_HTTP_METHODS.has(normalizedMethod) ? normalizedMethod : 'OTHER',
      endpoint: safeEndpointLabel(url, source),
      status: Number.isInteger(status) ? status : null,
      timestamp,
      source,
    };
    state.requests.push(request);
    return request;
  }

  function setRequestStatus(request, status) {
    if (!acceptingUpdates) return false;
    if (!state.requests.includes(request)) throw new Error('request does not belong to this diagnostic state');
    if (status !== null && !isHttpStatus(status)) throw new TypeError('invalid HTTP status');
    request.status = status;
    return true;
  }

  function markRegistrationSent() {
    if (!acceptingUpdates) return false;
    state.registrationSent = true;
    state.registrationStatus = null;
    state.safeRegistrationResponse = null;
    state.lastStage = 'registration-request-sent';
    persist();
    return true;
  }

  function completeRegistration(status, payload, user) {
    if (!acceptingUpdates) return false;
    if (status !== null && !isHttpStatus(status)) throw new TypeError('invalid registration status');
    if (user?.id && !isUuid(user.id)) throw new TypeError('invalid synthetic user ID');
    state.registrationStatus = status;
    state.safeRegistrationResponse = summarizeRegistrationResponse(status, payload);
    state.syntheticUserCreated = Boolean(user?.id);
    state.userId = user?.id || null;
    if (state.registrationStatus >= 200 && state.registrationStatus < 300 && state.syntheticUserCreated) {
      state.failureReason = null;
      state.lastStage = 'user-registered';
    } else {
      state.failureReason = 'registration-http-error';
      state.lastStage = 'registration-failed';
    }
    persist();
    return true;
  }

  function setVideoId(videoId) {
    if (!acceptingUpdates) return false;
    if (videoId && !isUuid(videoId)) throw new TypeError('invalid synthetic video ID');
    if (state.videoId === (videoId || null)) return;
    state.videoId = videoId || null;
    if (state.videoId) {
      state.failureReason = null;
      state.lastStage = 'video-created';
      persist();
    }
    return true;
  }

  function setJobStatus(status) {
    if (!acceptingUpdates) return false;
    if (status !== null && status !== undefined && !SAFE_JOB_STATUSES.has(status)) {
      throw new TypeError('invalid generation job status');
    }
    if (state.lastJobStatus === status) return;
    state.lastJobStatus = status || null;
    if (status === 'completed') {
      state.failureReason = null;
      state.lastStage = 'job-completed';
    } else if (status === 'failed') {
      state.failureReason = 'generation-failed';
      state.lastStage = 'job-failed';
    } else if (status) {
      state.lastStage = 'job-processing';
    }
    persist();
    return true;
  }

  function setDownloadStatus(method, status) {
    if (!acceptingUpdates) return false;
    if (status !== null && !isHttpStatus(status)) throw new TypeError('invalid HTTP status');
    if (method === 'HEAD') state.httpDownload.headStatus = status;
    if (method === 'GET') state.httpDownload.getStatus = status;
    if (method === 'GET' && status === 200) {
      state.lastStage = 'http-download-completed';
      persist();
    }
    return true;
  }

  function setVideoCreationResult(result) {
    if (!acceptingUpdates) return false;
    if (!isSafeVideoCreationResult(result)) throw new TypeError('invalid video creation diagnostic');
    state.videoCreation = JSON.parse(JSON.stringify(result));
    persist();
    return true;
  }

  return {
    get state() {
      return {
        ...state,
        requests: state.requests.map((request) => ({ ...request })),
        httpDownload: { ...state.httpDownload },
        videoCreation: state.videoCreation ? JSON.parse(JSON.stringify(state.videoCreation)) : null,
      };
    },
    snapshot,
    persist,
    beginShutdown,
    finalize,
    setStage,
    setFailure,
    recordRequest,
    setRequestStatus,
    markRegistrationSent,
    completeRegistration,
    setVideoId,
    setJobStatus,
    setDownloadStatus,
    setVideoCreationResult,
  };
}
