// Ollama: a local LLM server (https://ollama.com). Free, offline, no API key.
//
// Availability is checked against /api/tags (cached), because a missing server would otherwise cost
// a timeout on every single request.

import { AiError, classifyHttpError, classifyThrownError } from '../errors.js';
import { scriptPrompt } from '../prompt.js';
import { normalizeScript, validateGeneratedScript } from '../validate.js';

const DEFAULT_TIMEOUT_MS = 90000; // the first request also loads the model into memory
const CHECK_TTL_MS = 60 * 1000;
const PAUSE_ON_FAILURE_MS = 60 * 1000;

export function createOllamaProvider({ baseUrl, model, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  const root = String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  let checkedAt = 0;
  let ready = false;
  let pausedUntil = 0;
  let lastError = null;

  const provider = {
    id: 'ollama',
    label: 'Ollama (локальная модель)',
    model: model || null,
    kind: 'local',
    endpoint: `${root}/api/chat`,

    isConfigured: () => Boolean(model),

    isAvailable: () => Date.now() >= pausedUntil,

    pause(ms) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },

    noteFailure(err) {
      lastError = { code: err.code, message: err.message, at: new Date().toISOString() };
      // A dead local server needs a moment before another attempt is worth making.
      if (err instanceof AiError && ['network', 'timeout', 'server'].includes(err.code)) provider.pause(PAUSE_ON_FAILURE_MS);
    },

    lastError: () => lastError,

    /** Is the server running with this model pulled? Cached for CHECK_TTL_MS. */
    async available({ fresh = false } = {}) {
      if (process.env.OLLAMA_DISABLED === 'true') return false;
      if (!fresh && Date.now() - checkedAt < CHECK_TTL_MS) return ready;
      checkedAt = Date.now();
      try {
        const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(1500) });
        const data = await res.json();
        ready = res.ok && (data.models || []).some((m) => m.name === model || m.model === model);
      } catch {
        ready = false;
      }
      return ready;
    },

    async generate(input) {
      const { system, user } = scriptPrompt(input);
      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(provider.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model,
            stream: false,
            format: 'json',
            keep_alive: '30m',
            options: { temperature: 0.8, num_predict: 300 },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });
      } catch (err) {
        throw classifyThrownError(err, 'ollama');
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) throw classifyHttpError(res.status, data, 'ollama');

      const raw = data?.message?.content;
      let parsed;
      try {
        parsed = JSON.parse(String(raw || ''));
      } catch (err) {
        throw new AiError('bad_response', 'Ollama answer was not JSON', { provider: 'ollama', cause: err });
      }

      const script = normalizeScript(parsed);
      const fullText = [script.hook, script.benefit1, script.benefit2, script.cta].join('. ');
      try {
        validateGeneratedScript(script, input, fullText, { language: input.language, provider: 'ollama' });
      } catch (err) {
        if (err instanceof AiError && ['claim_validation', 'script_validation'].includes(err.code)) throw err;
        // Small local models often answer in the wrong language: the orchestrator retries once.
        throw new AiError('bad_response', 'Ollama returned an invalid script', { provider: 'ollama' });
      }
      return { script, fullText, model, latencyMs: Date.now() - started };
    },
  };

  return provider;
}