// Error types for the AI provider layer.
//
// Every provider reports failures through AiError so the orchestrator can decide what to do:
// a rejected key is permanent (stop calling that provider for a while), a rate limit is temporary,
// a 5xx or a network drop means "try the next provider now".

export const AI_ERROR_CODES = [
  'config', // provider is not configured (missing key / base URL)
  'auth', // 401 / 403 — the key is invalid, revoked or not allowed to use the model
  'quota', // credits exhausted / billing problem — retrying will not help
  'rate_limit', // 429 — retry later
  'server', // 5xx — provider-side problem
  'network', // DNS / connection reset / TLS
  'timeout', // request took too long
  'bad_response', // 200 but unusable content (not JSON, wrong shape, wrong language)
  'script_validation', // generated script failed common structure or language checks
  'claim_validation', // generated content contains a claim not supported by the request
  'unknown',
];

/** Errors that are worth retrying on another provider immediately. */
const TRANSIENT = new Set(['rate_limit', 'server', 'network', 'timeout', 'bad_response', 'unknown']);

export class AiError extends Error {
  constructor(code, message, { status = null, retryAfterMs = 0, provider = null, cause } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = AI_ERROR_CODES.includes(code) ? code : 'unknown';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
    if (cause) this.cause = cause;
  }

  /** A rejected key or an exhausted account: do not call this provider again for a long time. */
  get permanent() {
    return this.code === 'auth' || this.code === 'quota';
  }

  /** Worth another attempt elsewhere right away. */
  get transient() {
    return TRANSIENT.has(this.code);
  }
}

/** Maps an HTTP status + parsed error body to an AiError code. */
export function classifyHttpError(status, data, provider) {
  const type = String(data?.error?.type || data?.error?.code || data?.code || '').toLowerCase();
  const message = data?.error?.message || data?.message || data?.error || '';
  const retryAfterSec = Number(data?.error?.retry_after ?? data?.retry_after ?? 0);

  if (status === 401 || status === 403) return new AiError('auth', message || `HTTP ${status}`, { status, provider });
  if (status === 402) return new AiError('quota', message || 'Payment required', { status, provider });
  if (status === 429) {
    const retryAfterMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    // "insufficient_quota" is sometimes delivered as 429: that is not a rate limit.
    const quota = /insufficient_quota|credit|balance|billing|quota/.test(type);
    return new AiError(quota ? 'quota' : 'rate_limit', message || 'HTTP 429', { status, provider, retryAfterMs });
  }
  if (type.includes('insufficient_quota') || type.includes('credit') || type.includes('billing')) {
    return new AiError('quota', message || type, { status, provider });
  }
  if (status >= 500) return new AiError('server', message || `HTTP ${status}`, { status, provider });
  return new AiError('bad_response', message || `HTTP ${status}`, { status, provider });
}

/** Maps a thrown network/timeout error to an AiError. */
export function classifyThrownError(err, provider) {
  if (err instanceof AiError) return err;
  const name = err?.name || '';
  // Node's fetch wraps the real socket error: TypeError: fetch failed { cause: { code: 'ECONNREFUSED' } }
  const cause = err?.cause || {};
  const code = err?.code || cause.code || '';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new AiError('timeout', err.message || 'request timed out', { provider, cause: err });
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED'].includes(code)) {
    return new AiError('network', cause.message || err.message || code, { provider, cause: err });
  }
  if (err instanceof SyntaxError) return new AiError('bad_response', 'provider returned invalid JSON', { provider, cause: err });
  return new AiError('unknown', cause.message || err?.message || 'unknown provider error', { provider, cause: err });
}

/** Returns a fixed, client-safe message without exposing provider response details. */
export function toClientAiError(error) {
  if (!(error instanceof AiError)) return null;

  if (error.status === 400 && error.code === 'bad_response') {
    return { status: 400, message: 'Проверьте данные для генерации сценария.' };
  }
  if (error.status === 404 && error.provider === 'openrouter') {
    return { status: 502, message: 'Модель OpenRouter недоступна. Проверьте настройку модели.' };
  }
  if (error.status === 401 || error.status === 403) {
    return { status: 502, message: 'OpenRouter отклонил доступ. Проверьте серверную настройку API key и модели.' };
  }
  if (error.status === 402) {
    return { status: 503, message: 'Для OpenRouter требуется проверить доступность кредита аккаунта.' };
  }
  if (error.status === 429 || error.code === 'rate_limit') {
    return {
      status: 429,
      message: 'Слишком много запросов к AI-провайдеру. Попробуйте позже.',
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error.code === 'timeout') return { status: 504, message: 'AI-провайдер не ответил вовремя. Попробуйте ещё раз.' };
  if (error.code === 'config') return { status: 503, message: 'AI-провайдер не настроен.' };
  if (error.code === 'bad_response') return { status: 502, message: 'AI-провайдер вернул некорректный сценарий.' };
  if (error.code === 'script_validation') return { status: 502, message: 'AI-провайдер вернул некорректный сценарий.' };
  if (error.code === 'claim_validation') return { status: 502, message: 'Не удалось проверить достоверность сценария. Попробуйте изменить описание товара.' };
  return { status: 502, message: 'AI-провайдер временно недоступен.' };
}