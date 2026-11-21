// Google Translate TTS — free, no API key, no Uzbek voice (Russian and English only).

import fs from 'fs';
import path from 'path';
import * as googleTTS from 'google-tts-api';
import { VOICE_LANGUAGES } from '../voices.js';

const TIMEOUT_MS = 8000;
const ATTEMPTS = Number(process.env.TTS_ATTEMPTS) || 2;

let reachableUntil = 0;

export const provider = {
  id: 'google',
  label: VOICE_LANGUAGES.google.label,

  isConfigured: () => process.env.TTS_PROVIDER !== 'local',

  /** The endpoint has no health check; one failed phrase is enough to stop trying for a while. */
  async available() {
    return Date.now() >= reachableUntil;
  },

  noteFailure() {
    reachableUntil = Date.now() + 5 * 60 * 1000;
  },

  async speak({ text, voice, outPath }) {
    // `voice` is the language code ('ru' / 'en'); Cyrillic text must not go to the English voice.
    let lastError;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const parts = await googleTTS.getAllAudioBase64(text, {
          lang: voice,
          slow: false,
          timeout: TIMEOUT_MS,
          splitPunct: ',.!?',
        });
        const buffer = Buffer.concat(parts.map((p) => Buffer.from(p.base64, 'base64')));
        if (buffer.length < 1000) throw new Error('empty response');
        fs.writeFileSync(outPath, buffer);
        return path.resolve(outPath);
      } catch (err) {
        lastError = err;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    provider.noteFailure();
    throw lastError;
  },
};