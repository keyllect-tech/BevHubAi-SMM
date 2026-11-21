// OpenAI-compatible chat provider.
//
// Works with any server that implements POST {baseUrl}/chat/completions — OpenAI itself, Azure
// OpenAI (via its OpenAI-compatible endpoint), Groq, Together, OpenRouter, a local llama.cpp or
// LM Studio server. Nothing is hardcoded except the shape of the request, so adding a provider is
// configuration, not code.

import { AiError, classifyHttpError, classifyThrownError } from '../errors.js';
import { scriptPrompt } from '../prompt.js';
import { normalizeScript, validateGeneratedScript } from '../validate.js';

const DEFAULT_TIMEOUT_MS = 20000;
const PAUSE_ON_AUTH_MS = 30 * 60 * 1000; // a rejected key will not start working in a minute
const PAUSE_ON_RATE_LIMIT_MS = 60 * 1000;

export function createChatProvider({
  id,
  label,
  baseUrl,
  model,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  temperature = 0.8,
  supportsJsonMode = true,
  kind = 'cloud',
  requiresKey = true,
  extraHeaders = {},
  fetchImpl = fetch,
}) {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  let pausedUntil = 0;
  let lastError = null;

  const provider = {
    id,
    label,
    model: model || null,
    kind,
    endpoint,

    isConfigured: () => Boolean(baseUrl && model) && (!requiresKey || Boolean(apiKey)),

    isAvailable: () => Date.now() >= pausedUntil,

    pause(ms) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },

    /** Remembers why the provider failed and pauses it when retrying cannot help. */
    noteFailure(err) {
      lastError = { code: err.code, message: err.message, at: new Date().toISOString() };
      if (err instanceof AiError) {
        if (err.code === 'auth' || err.code === 'quota') provider.pause(PAUSE_ON_AUTH_MS);
        else if (err.code === 'rate_limit') provider.pause(Math.min(err.retryAfterMs || PAUSE_ON_RATE_LIMIT_MS, 5 * 60 * 1000));
      }
    },

    lastError: () => lastError,

    async generate(input) {
      const { system, user } = scriptPrompt(input);
      const body = {
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      if (supportsJsonMode) body.response_format = { type: 'json_object' };

      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...extraHeaders,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw classifyThrownError(err, id);
      }

      const data = await res.json().catch(() => null);

      // Some OpenAI-compatible servers reject response_format; a plain completion is fine.
      if (!res.ok && supportsJsonMode && res.status === 400 && /response_format/i.test(JSON.stringify(data || ''))) {
        delete body.response_format;
        try {
          res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              ...extraHeaders,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          throw classifyThrownError(err, id);
        }
      }

      if (!res.ok) throw classifyHttpError(res.status, data, id);

      const raw = data?.choices?.[0]?.message?.content;
      let parsed;
      try {
        // Models sometimes wrap the JSON in a ```json fence or add prose around it.
        const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
        parsed = JSON.parse(text);
      } catch (err) {
        throw new AiError('bad_response', 'Could not parse the model answer as JSON', {
          provider: id,
          cause: err,
        });
      }

      const script = normalizeScript(parsed);
      const fullText = [script.hook, script.benefit1, script.benefit2, script.cta].join('. ');
      try {
        validateGeneratedScript(script, input, fullText, { language: input.language, provider: id });
      } catch (err) {
        if (err instanceof AiError && ['claim_validation', 'script_validation'].includes(err.code)) throw err;
        throw new AiError('bad_response', 'Provider returned an invalid script', { provider: id });
      }
      return { script, fullText, model, latencyMs: Date.now() - started };
    },
  };

  return provider;
}