// Which languages each TTS provider can actually speak.
//
// This is the single source of truth for "can we voice Uzbek?" questions. Adding a provider (or a
// new voice to an existing one) is a change here plus an adapter in ./providers — the video engine
// and the API layer never need to know.

export const VOICE_LANGUAGES = {
  // Free, no key: Microsoft's public Edge read-aloud endpoint via the `edge-tts` Python package.
  edge: {
    label: 'Edge Neural (бесплатно, нужен Python + edge-tts)',
    fallbackLanguage: 'ru',
    voices: {
      uz: { female: 'uz-UZ-MadinaNeural', male: 'uz-UZ-SardorNeural' },
      ru: { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
      en: { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' },
    },
  },
  // Free, no key, needs internet: the unofficial Google Translate TTS endpoint.
  google: {
    label: 'Google Translate TTS (бесплатно, без ключа)',
    fallbackLanguage: 'ru',
    voices: {
      // Google has no Uzbek voice; Uzbek text is read by the Russian voice.
      ru: { female: 'ru' },
      en: { female: 'en' },
    },
  },
  // Free, offline: Windows SAPI voices. Uzbek is not among the installed cultures.
  'windows-sapi': {
    label: 'Windows SAPI (офлайн, без ключа)',
    fallbackLanguage: 'ru',
    voices: {
      ru: { female: 'Microsoft Irina Desktop', male: null },
      en: { female: 'Microsoft Zira Desktop', male: 'Microsoft David Desktop' },
    },
  },
};

/** Provider order used when nothing else is configured: the best voice first. */
export const DEFAULT_PROVIDER_ORDER = ['edge', 'google', 'windows-sapi'];

export const PROVIDER_IDS = Object.keys(VOICE_LANGUAGES);