// TTS orchestration: picks the best available voice for the requested language and renders the
// phrases. The video engine only sees the returned clips plus an honest description of what spoke.

import fs from 'fs';
import path from 'path';
import { provider as edge } from './providers/edge.js';
import { provider as google } from './providers/google.js';
import { provider as sapi } from './providers/windows-sapi.js';
import { voiceCandidates, voiceLimitation } from './capabilities.js';
import { DEFAULT_PROVIDER_ORDER, PROVIDER_IDS, VOICE_LANGUAGES } from './voices.js';

const ALL = { edge, google, 'windows-sapi': sapi };

const order = (() => {
  const configured = String(process.env.TTS_PROVIDER_ORDER || '')
    .split(',')
    .map((s) => s.trim())
    .filter((id) => ALL[id]);
  return configured.length ? configured : DEFAULT_PROVIDER_ORDER;
})();

/** Providers that exist on this machine, in the configured order. */
export async function availableProviders() {
  const result = [];
  for (const id of order) {
    const p = ALL[id];
    if (!p || !p.isConfigured()) continue;
    // Availability is checked lazily: a provider without a key is skipped without any I/O.
    result.push(p);
  }
  return result;
}

/** Status of every TTS provider, for /api/health and the settings screen. */
export async function ttsStatus() {
  const rows = [];
  for (const id of PROVIDER_IDS) {
    const p = ALL[id];
    if (!p) continue;
    let available = false;
    try {
      available = Boolean(await p.available?.());
    } catch {
      available = false;
    }
    rows.push({
      id,
      label: p.label,
      configured: p.isConfigured(),
      available,
      languages: Object.keys(VOICE_LANGUAGES[id].voices),
    });
  }
  return rows;
}

/**
 * Renders every phrase with the first provider that can speak the language exactly, then the first
 * one that can speak it as a substitute. Returns clips plus what actually happened.
 *
 * @returns {{clips: string[], provider: string, voice: string, gender: string, voiceLanguage: string,
 *            exactLanguage: boolean, warning: string, label: string}}
 */
/**
 * Builds the honest limitation note for one phrase batch.
 * Two different things can be substituted: the language (a Russian voice reading Uzbek) and the
 * gender (a female voice when no male voice works). Both must be visible to the user.
 */
function voiceWarning({ language, requestedGender, spokenGender, spokenVoice, spokenLanguage, exact, providerId }) {
  const notes = [];
  if (!exact) notes.push(`Нет голоса для языка «${language}»: текст прочитан голосом языка «${spokenLanguage}» (${providerId}).`);
  if (spokenGender && requestedGender && spokenGender !== requestedGender) {
    const wanted = requestedGender === 'male' ? 'мужской' : 'женский';
    const got = spokenGender === 'male' ? 'мужским' : 'женским';
    notes.push(`${wanted === 'мужской' ? 'Мужской' : 'Женский'} голос для языка «${language}» недоступен — текст прочитан ${got} голосом (${spokenVoice}).`);
  }
  return notes.join(' ');
}

/** Language a voice really speaks, taken from the provider registry. */
function spokenLanguageOf(voice, providerId) {
  const spec = VOICE_LANGUAGES[providerId];
  if (!spec) return '';
  for (const [language, entry] of Object.entries(spec.voices)) {
    if (entry.female === voice || entry.male === voice) return language;
  }
  return '';
}

export async function synthesize({ texts, language, gender = 'female', workDir }) {
  const providers = await availableProviders();
  const candidates = voiceCandidates(providers.map((p) => p.id), { language, gender });
  const ordered = [...candidates].sort((a, b) => Number(b.exact) - Number(b.exact));

  const errors = [];
  for (const candidate of ordered) {
    const p = ALL[candidate.provider];
    try {
      if (candidate.provider === 'windows-sapi') {
        const result = await p.speakAll({ texts, language, gender, workDir });
        const spokenLanguage = spokenLanguageOf(result.voice, p.id) || candidate.voiceLanguage;
        return {
          clips: result.paths,
          provider: p.id,
          label: p.label,
          voice: result.voice,
          gender: result.gender,
          voiceLanguage: spokenLanguage,
          exactLanguage: candidate.exact,
          warning: voiceWarning({
            language,
            requestedGender: gender,
            spokenGender: result.gender,
            spokenVoice: result.voice,
            spokenLanguage,
            exact: candidate.exact,
            providerId: p.id,
          }),
        };
      }
      const clips = [];
      let spoken = null;
      for (let i = 0; i < texts.length; i++) {
        const result = await p.speak({
          text: texts[i],
          voice: candidate.voice,
          outPath: path.join(workDir, `voice_${i}.mp3`),
          language: candidate.voiceLanguage,
          gender,
        });
        // Providers that keep their old contract return a plain path; then the requested voice is what spoke.
        clips.push(typeof result === 'string' ? result : result.path);
        if (typeof result !== 'string') spoken = result;
      }
      if (clips.some((c) => !fs.existsSync(c) || fs.statSync(c).size < 500)) throw new Error('provider produced empty audio');

      // What spoke may differ from what was asked for (edge falls back to the other voice of the language).
      const spokenVoice = spoken?.voice || candidate.voice;
      const spokenGender = spoken?.gender || candidate.gender || gender;
      const spokenLanguage = spokenLanguageOf(spokenVoice, p.id) || candidate.voiceLanguage;
      return {
        clips,
        provider: p.id,
        label: p.label,
        voice: spokenVoice,
        gender: spokenGender,
        voiceLanguage: spokenLanguage,
        exactLanguage: candidate.exact,
        warning: voiceWarning({
          language,
          requestedGender: gender,
          spokenGender,
          spokenVoice,
          spokenLanguage,
          exact: candidate.exact,
          providerId: p.id,
        }),
      };
    } catch (err) {
      errors.push(`${p.id}: ${err.message}`);
      p.noteFailure?.();
      console.warn(`[TTS] ${p.id} failed: ${err.message}`);
    }
  }

  throw new Error(`no TTS provider could voice the text (${errors.join('; ') || 'none configured'})`);
}