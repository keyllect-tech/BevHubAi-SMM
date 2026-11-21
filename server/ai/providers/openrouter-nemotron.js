import { AiError } from '../errors.js';
import { scriptPrompt } from '../prompt.js';
import {
  normalizeScript,
  validateGeneratedScript,
} from '../validate.js';
import { cleanText } from '../../text.js';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const INPUT_LIMITS = { productName: 100, description: 600, cta: 60 };
const LANGUAGES = new Set(['ru', 'uz', 'en']);
const STYLES = new Set(['product', 'dynamic', 'premium', 'ugc']);
const CATEGORIES = new Set(['product', 'realty', 'food', 'shop', 'service', 'job', 'event', 'other']);
const SCRIPT_KEYS = ['hook', 'benefit1', 'benefit2', 'cta', 'fullText'];
const SCRIPT_FIELD_LIMITS = { hook: 80, benefit1: 90, benefit2: 90, cta: 60 };

function providerError(status) {
  if (status === 401) return new AiError('auth', 'OpenRouter rejected the API key', { status, provider: 'openrouter' });
  if (status === 402) return new AiError('quota', 'OpenRouter account has insufficient credits', { status, provider: 'openrouter' });
  if (status === 403) return new AiError('auth', 'OpenRouter denied access to the configured model', { status, provider: 'openrouter' });
  if (status === 404) return new AiError('config', 'Configured OpenRouter model was not found', { status, provider: 'openrouter' });
  if (status === 429) return new AiError('rate_limit', 'OpenRouter rate limit reached', {
    status,
    retryAfterMs: 0,
    provider: 'openrouter',
  });
  if (status >= 500) return new AiError('server', 'OpenRouter is temporarily unavailable', { status, provider: 'openrouter' });
  return new AiError('bad_response', 'OpenRouter rejected the generation request', { status, provider: 'openrouter' });
}

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5 * 60 * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 5 * 60 * 1000) : 0;
}

function validateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new AiError('bad_response', 'Invalid script generation input', { status: 400, provider: 'openrouter' });
  }
  for (const [field, maxLength] of Object.entries(INPUT_LIMITS)) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
      throw new AiError('bad_response', 'Script generation input is empty or too long', {
        status: 400,
        provider: 'openrouter',
      });
    }
  }
  if (!LANGUAGES.has(input.language) || !STYLES.has(input.style) || !CATEGORIES.has(input.category)) {
    throw new AiError('bad_response', 'Script generation options are unsupported', {
      status: 400,
      provider: 'openrouter',
    });
  }
}

function parseModelScript(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== SCRIPT_KEYS.length
    || SCRIPT_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new AiError('bad_response', 'OpenRouter returned an incomplete script', { provider: 'openrouter' });
  }
  if (SCRIPT_KEYS.slice(0, 4).some((key) => (
    typeof value[key] !== 'string'
    || !value[key].trim()
    || value[key].length > SCRIPT_FIELD_LIMITS[key]
  ))) {
    throw new AiError('bad_response', 'OpenRouter returned invalid script fields', { provider: 'openrouter' });
  }
  if (typeof value.fullText !== 'string' || value.fullText.length > 1200) {
    throw new AiError('bad_response', 'OpenRouter returned invalid full ad text', { provider: 'openrouter' });
  }

  const script = normalizeScript(value);
  const fullText = cleanText(value.fullText, 1200);
  try {
    validateGeneratedScript(script, input, fullText, {
      language: input.language,
      provider: 'openrouter',
    });
  } catch (error) {
    if (error instanceof AiError && ['claim_validation', 'script_validation'].includes(error.code)) throw error;
    throw new AiError('bad_response', 'OpenRouter returned an incomplete or wrong-language script', {
      provider: 'openrouter',
    });
  }
  if (SCRIPT_KEYS.slice(0, 4).some((key) => !fullText.includes(script[key]))) {
    throw new AiError('bad_response', 'OpenRouter full ad text does not match the script fields', {
      provider: 'openrouter',
    });
  }
  return { script, fullText };
}

export function createOpenRouterNemotronProvider({
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
  timeoutMs = Number(process.env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const configuredApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const configuredModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_OPENROUTER_MODEL;
  const requestTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(timeoutMs, 1000), 120000)
    : DEFAULT_TIMEOUT_MS;
  let pausedUntil = 0;
  let lastError = null;
  let lastFailureStatus = null;
  let lastRetryAfterMs = 0;
  const provider = {
    id: 'openrouter',
    label: 'NVIDIA Nemotron 3 Ultra via OpenRouter',
    model: configuredModel,
    kind: 'cloud',
    endpoint: OPENROUTER_ENDPOINT,
    isConfigured: () => Boolean(configuredApiKey),
    isAvailable: () => Date.now() >= pausedUntil,
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },
    noteFailure(error) {
      lastError = { code: error.code, message: error.message, at: new Date().toISOString() };
      lastFailureStatus = error.status;
      lastRetryAfterMs = error.retryAfterMs;
      if (error.code === 'auth' || error.code === 'quota' || error.code === 'config') {
        provider.pause(30 * 60 * 1000);
      } else if (error.code === 'rate_limit') {
        provider.pause(error.retryAfterMs || 60 * 1000);
      }
    },
    lastError: () => lastError,
    lastFailureStatus: () => lastFailureStatus,
    lastRetryAfterMs: () => lastRetryAfterMs,
    async generate(input) {
      if (!provider.isConfigured()) {
        throw new AiError('config', 'OpenRouter API key is not configured', { provider: 'openrouter' });
      }
      validateInput(input);
      const { system, user } = scriptPrompt(input, { includeFullText: true, strictFacts: true });
      const started = Date.now();
      let response;
      try {
        response = await fetchImpl(OPENROUTER_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${configuredApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: configuredModel,
            temperature: 0.7,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new AiError(
          timedOut ? 'timeout' : 'network',
          timedOut ? 'OpenRouter request timed out' : 'OpenRouter is unreachable',
          { provider: 'openrouter', cause: error },
        );
      }

      if (!response.ok) {
        const error = providerError(response.status);
        if (response.status === 429) {
          error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
        }
        throw error;
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new AiError('bad_response', 'OpenRouter response exceeded the size limit', { provider: 'openrouter' });
      }

      let rawResponse;
      try {
        rawResponse = await response.text();
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new AiError(timedOut ? 'timeout' : 'network', timedOut
          ? 'OpenRouter request timed out'
          : 'OpenRouter response could not be read', {
          provider: 'openrouter',
          cause: error,
        });
      }
      if (rawResponse.length > MAX_RESPONSE_BYTES) {
        throw new AiError('bad_response', 'OpenRouter response exceeded the size limit', { provider: 'openrouter' });
      }

      let data;
      try {
        data = JSON.parse(rawResponse);
      } catch (error) {
        throw new AiError('bad_response', 'OpenRouter returned invalid JSON', {
          provider: 'openrouter',
          cause: error,
        });
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length > MAX_RESPONSE_BYTES) {
        throw new AiError('bad_response', 'OpenRouter returned an invalid model response', { provider: 'openrouter' });
      }

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new AiError('bad_response', 'Nemotron returned invalid script JSON', {
          provider: 'openrouter',
          cause: error,
        });
      }
      const generated = parseModelScript(parsed, input);
      return {
        ...generated,
        model: configuredModel,
        latencyMs: Date.now() - started,
      };
    },
  };
  return provider;
}
