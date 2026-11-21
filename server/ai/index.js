// AI provider registry and orchestration.
//
// Responsibilities:
//  * build the provider list from configuration (never hardcode a single vendor),
//  * try them in order with per-provider backoff and a retry for weak local models,
//  * validate every result, including the offline template fallback,
//  * report which provider produced the text — templates are never presented as AI output.

import { createChatProvider } from './providers/openai-compatible.js';
import { createOllamaProvider } from './providers/ollama.js';
import { createOpenRouterNemotronProvider } from './providers/openrouter-nemotron.js';
import { AiError } from './errors.js';
import { generateTemplateScript } from '../content.js';
import { detectLanguage, normalizeUzbekText } from '../lang.js';
import { validateGeneratedScript } from './validate.js';

const list = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

function buildProviders() {
  const providers = [];

  providers.push(createOpenRouterNemotronProvider());

  providers.push(
    createChatProvider({
      id: 'openai',
      label: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 20000,
    })
  );

  // Any other OpenAI-compatible service: configured entirely by environment, no code change.
  providers.push(
    createChatProvider({
      id: 'custom',
      label: process.env.CUSTOM_AI_LABEL || 'Дополнительный AI-провайдер',
      baseUrl: process.env.CUSTOM_AI_BASE_URL,
      model: process.env.CUSTOM_AI_MODEL,
      apiKey: process.env.CUSTOM_AI_API_KEY,
      timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 20000,
    })
  );

  providers.push(
    createOllamaProvider({
      baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
    })
  );

  // Explicit ordering, e.g. AI_PROVIDERS=ollama,openai. Unknown ids are ignored.
  const order = list(process.env.AI_PROVIDERS);
  if (!order.length) return providers;
  return [...providers].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

const PROVIDERS = buildProviders();

const configured = () => PROVIDERS.filter((p) => p.isConfigured());

/** True when at least one provider could actually produce an AI script right now. */
export function isAiActive() {
  return configured().some((p) => p.isAvailable());
}

/** Status of every known provider, for /api/health and the settings screen. */
export async function providerStatus() {
  const rows = [];
  for (const p of PROVIDERS) {
    let reachable = true;
    if (p.id === 'ollama' && p.isConfigured()) {
      try {
        reachable = await p.available();
      } catch {
        reachable = false;
      }
    }
    rows.push({
      id: p.id,
      label: p.label,
      kind: p.kind,
      model: p.model,
      configured: p.isConfigured(),
      // configured + not paused + (for local models) the server answers
      available: p.isConfigured() && p.isAvailable() && reachable,
      lastError: p.lastError?.() || null,
    });
  }
  return rows;
}

/**
 * Plain-language reason why the offline generator was used.
 * Distinguishes "nothing configured" from "configured but temporarily refusing to answer",
 * because telling the operator to add a key when the key exists but is out of credit is a lie.
 */
const summarize = (attempts, providers) => {
  const failed = attempts.filter((a) => !a.ok && !a.skipped);
  const skipped = attempts.filter((a) => a.skipped);
  const list = providers || [];
  const configured = list.filter((p) => p.isConfigured?.());
  const details = [...failed, ...skipped].map((a) => `${a.provider}: ${a.code}`).join('; ');

  if (!configured.length) return 'AI-провайдер не настроен';
  if (!details) return '';
  const allPaused = configured.every((p) => !p.isAvailable?.());
  return allPaused
    ? `AI-провайдер настроен, но временно недоступен — ${details}`
    : `AI-провайдер не смог ответить — ${details}`;
};

/**
 * Generates a script, or explains why none could be generated.
 * Factual validation failures are surfaced so they cannot silently fall back.
 */
export async function generateScript(input, {
  providers = PROVIDERS,
  templateGenerator = generateTemplateScript,
} = {}) {
  const attempts = [];
  // Uzbek is always stored in the canonical Latin form with one apostrophe style.
  const request = input.language === 'uz' ? { ...input, description: normalizeUzbekText(input.description || ''), cta: normalizeUzbekText(input.cta || '') } : input;
  const activeProviders = providers.filter((provider) => provider.isConfigured());

  for (const provider of activeProviders) {
    if (!provider.isAvailable()) {
      const last = provider.lastError?.();
      attempts.push({ provider: provider.id, ok: false, skipped: true, code: 'backoff', message: 'Provider is temporarily unavailable' });
      if (provider.id === 'openrouter') {
        throw new AiError(last?.code || 'server', 'OpenRouter is temporarily unavailable', {
          provider: 'openrouter',
          status: provider.lastFailureStatus?.() || null,
          retryAfterMs: provider.lastRetryAfterMs?.() || 0,
        });
      }
      continue;
    }

    // Small local models answer in the wrong language surprisingly often: two attempts.
    const maxTries = provider.id === 'ollama' ? 2 : 1;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const started = Date.now();
      try {
        const { script, fullText: generatedFullText, model, latencyMs } = await provider.generate(request);
        const { fullText } = validateGeneratedScript(script, request, generatedFullText, {
          language: request.language,
          provider: provider.id,
        });
        attempts.push({ provider: provider.id, ok: true, latencyMs, model });
        console.log(`[AI SCRIPT] ${provider.id} (${provider.model}) produced a script in ${latencyMs}ms`);
        return {
          script,
          fullText,
          source: {
            kind: 'ai',
            id: `ai:${provider.id}`,
            provider: provider.id,
            label: provider.label,
            model: model || provider.model,
            warning: '',
            reason: '',
          },
          attempts,
        };
      } catch (err) {
        const error = err instanceof AiError
          ? err
          : new AiError(
            'unknown',
            provider.id === 'openrouter' ? 'OpenRouter request failed' : 'Provider request failed',
            { provider: provider.id },
          );
        provider.noteFailure(error);
        attempts.push({ provider: provider.id, ok: false, code: error.code, message: 'Provider request failed', latencyMs: Date.now() - started });
        console.warn(`[AI SCRIPT] ${provider.id} failed (${error.code})`);
        if (error.code === 'claim_validation' || error.code === 'script_validation') throw error;
        if (provider.id === 'openrouter') throw error;
        if (error.transient) break; // another provider may do better right now
      }
    }
  }

  const { script, warning } = templateGenerator(request);
  const fullText = [script.hook, script.benefit1, script.benefit2, script.cta].join('. ');
  validateGeneratedScript(script, request, fullText, { language: request.language, provider: 'template' });
  const reason = summarize(attempts, activeProviders);
  console.log(`[AI SCRIPT] no AI provider available — using the template generator${reason ? ` (${reason})` : ''}`);
  return {
    script,
    fullText,
    source: {
      kind: 'template',
      id: 'template',
      provider: null,
      label: 'BevHub Engine (шаблон)',
      model: null,
      warning,
      reason: reason || 'AI-провайдер не настроен',
    },
    attempts,
  };
}

/** Loads the local model into memory in the background so the first request is fast. */
export async function warmUpProviders() {
  const ollama = PROVIDERS.find((p) => p.id === 'ollama');
  if (!ollama || !ollama.isConfigured()) return;
  if (!(await ollama.available({ fresh: true }))) {
    console.log(`[AI SCRIPT] Ollama not available (model ${ollama.model}) — templates will be used unless a cloud provider is configured`);
    return;
  }
  console.log(`[AI SCRIPT] Ollama ready (model ${ollama.model}) — warming up`);
  fetch(`${ollama.endpoint.replace(/\/chat$/, '/generate')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollama.model, prompt: 'ok', stream: false, keep_alive: '30m', options: { num_predict: 1 } }),
    signal: AbortSignal.timeout(90000),
  }).catch(() => {});
}

/** Detects the language of a free-text request (used by the API layer). */
export { detectLanguage } from '../lang.js';