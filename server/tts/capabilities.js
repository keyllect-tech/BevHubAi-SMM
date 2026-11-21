// Voice capability registry.
//
// The engine asks this module "which provider can speak language X?" and gets an ordered list of
// candidates, each marked as an exact-language match or a substitute. Nothing in the render path
// knows which provider actually produced the audio — that is the point of the layer.

import { VOICE_LANGUAGES } from './voices.js';

export const LANGUAGES_WITH_EXACT_VOICE = Object.freeze(
  Object.keys(VOICE_LANGUAGES).reduce((acc, providerId) => {
    acc[providerId] = Object.keys(VOICE_LANGUAGES[providerId].voices);
    return acc;
  }, {})
);

/** Languages a provider can speak exactly (used by /api/health and the settings screen). */
export function exactLanguages(providerId) {
  return LANGUAGES_WITH_EXACT_VOICE[providerId] || [];
}

/**
 * Ordered voice candidates for a language/gender request.
 * `exact: true` means the provider has a voice for that language; `false` means the text will be
 * read by a voice of another language (returned as a substitute, never labelled as the target one).
 * `gender` is the gender of the voice that will actually be used, which can differ from the request
 * (a provider may only have a female voice for that language).
 */
export function voiceCandidates(providerIds, { language, gender }) {
  const pick = (entry) => {
    if (!entry) return null;
    if (gender === 'male') {
      return entry.male ? { voice: entry.male, gender: 'male' } : entry.female ? { voice: entry.female, gender: 'female' } : null;
    }
    return entry.female ? { voice: entry.female, gender: 'female' } : entry.male ? { voice: entry.male, gender: 'male' } : null;
  };

  return providerIds.map((id) => {
    const spec = VOICE_LANGUAGES[id];
    if (!spec) return null;
    const exact = spec.voices[language];
    if (exact) {
      const chosen = pick(exact);
      if (chosen) return { provider: id, voice: chosen.voice, voiceLanguage: language, exact: true, gender: chosen.gender, substitute: null };
    }
    // No voice for this language: fall back to the provider's default, clearly marked.
    const fallbackLanguage = spec.fallbackLanguage;
    const chosen = pick(spec.voices[fallbackLanguage]);
    if (!chosen) return null;
    return {
      provider: id,
      voice: chosen.voice,
      voiceLanguage: fallbackLanguage,
      exact: false,
      gender: chosen.gender,
      substitute: `нет голоса для языка «${language}», используется голос «${fallbackLanguage}»`,
    };
  }).filter(Boolean);
}

/** Human-readable limitation shown in the UI when no exact voice exists anywhere. */
export function voiceLimitation(language, candidates) {
  if (!candidates?.length) return `Для языка «${language}» на сервере нет ни одного TTS-провайдера.`;
  if (candidates.some((c) => c.exact)) return '';
  const langs = [...new Set(candidates.map((c) => c.voiceLanguage))];
  return `Для языка «${language}» нет голоса: озвучка будет прочитана голосом (${langs.join(', ')}).`;
}