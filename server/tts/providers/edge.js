// Edge Neural TTS — free, no API key, real Uzbek voices (uz-UZ-MadinaNeural / uz-UZ-SardorNeural).
//
// Implemented by calling the `edge-tts` Python package (unofficial Microsoft Edge read-aloud
// endpoint). Requires Python 3 and `pip install edge-tts`; without them the provider reports itself
// unavailable and the engine falls back to the other providers — it never blocks a render.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { VOICE_LANGUAGES } from '../voices.js';
import { removeOwnFile } from '../../safe-remove.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = Number(process.env.EDGE_TTS_TIMEOUT_MS) || 30000;
const CHECK_TTL_MS = 10 * 60 * 1000;
/** Some voices are announced by the service but return no audio; retrying once filters out hiccups. */
const VOICE_ATTEMPTS = 2;
/** Windows refuses to rename over a file another handle owns. */
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/**
 * Which Python to use: EDGE_TTS_PYTHON wins, then the project-local virtual environment
 * (.venv-tts, so `pip install edge-tts` does not touch the system Python), then `python` from PATH.
 */
function resolvePython() {
  if (process.env.EDGE_TTS_PYTHON) return process.env.EDGE_TTS_PYTHON;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const local = process.platform === 'win32'
    ? path.join(root, '.venv-tts', 'Scripts', 'python.exe')
    : path.join(root, '.venv-tts', 'bin', 'python');
  return fs.existsSync(local) ? local : 'python';
}

const PYTHON = resolvePython();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Voice registry, derived from the single source of truth: voice id → { language, gender }.
 * The reported gender comes from here, so a substitute is never described as the voice that was asked for.
 */
const VOICE_INFO = new Map();
for (const [language, entry] of Object.entries(VOICE_LANGUAGES.edge.voices)) {
  for (const gender of ['male', 'female']) {
    const voice = entry[gender];
    if (voice) VOICE_INFO.set(voice, { language, gender });
  }
}

const infoOf = (voice) => VOICE_INFO.get(voice) || null;

/**
 * Ordered list of voices to try for one phrase: the requested one first, then the other voices of the
 * same language (so a broken male voice falls back to the working female voice of that language
 * instead of switching the language of the speech).
 */
export function voiceChain(voice, { language, gender } = {}) {
  const info = infoOf(voice);
  const lang = language || info?.language || null;
  const entry = lang ? VOICE_LANGUAGES.edge.voices[lang] : null;
  const wanted = gender || info?.gender || null;

  const chain = [];
  const push = (candidate) => {
    if (candidate && !chain.includes(candidate)) chain.push(candidate);
  };
  push(voice);
  if (entry) {
    // The other gender of the same language first, then whatever else that language offers.
    push(wanted === 'male' ? entry.female : entry.male);
    push(entry.male);
    push(entry.female);
  }
  return chain;
}

let checkedAt = 0;
let available = false;

export const provider = {
  id: 'edge',
  label: VOICE_LANGUAGES.edge.label,

  isConfigured: () => process.env.EDGE_TTS_DISABLED !== 'true',

  /** Python with the edge_tts module present. Cached, because spawning Python is slow. */
  async available({ fresh = false } = {}) {
    if (!provider.isConfigured()) return false;
    if (!fresh && Date.now() - checkedAt < CHECK_TTL_MS) return available;
    checkedAt = Date.now();
    try {
      await execFileAsync(PYTHON, ['-c', 'import edge_tts'], { timeout: 15000, windowsHide: true });
      available = true;
    } catch {
      available = false;
    }
    return available;
  },

  /**
   * Renders one phrase to an MP3 file.
   *
   * Writes to a scratch file first and only publishes it on success, so a failed attempt can never
   * leave a truncated file behind that a later check would mistake for audio.
   *
   * @returns {Promise<{path: string, voice: string, gender: string|null, language: string|null, tried: string[]}>}
   */
  async speak({ text, voice, outPath, language, gender }) {
    const chain = voiceChain(voice, { language, gender });
    const scratch = `${outPath}.try.mp3`;
    const startedAt = Date.now();
    const errors = [];

    for (const candidate of chain) {
      for (let attempt = 1; attempt <= VOICE_ATTEMPTS; attempt++) {
        try {
          await execFileAsync(
            PYTHON,
            ['-m', 'edge_tts', '--voice', candidate, '--text', text, '--write-media', scratch, '--rate=-4%'],
            { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
          );
          if (!fs.existsSync(scratch) || fs.statSync(scratch).size < 1000) throw new Error('edge-tts produced no audio');

          let finalPath = outPath;
          try {
            fs.renameSync(scratch, outPath);
          } catch (err) {
            // The target name is taken (an earlier attempt): the scratch file itself is complete audio.
            if (!LOCK_CODES.has(err.code)) throw err;
            finalPath = scratch;
          }
          const info = infoOf(candidate);
          return {
            path: path.resolve(finalPath),
            voice: candidate,
            gender: info?.gender || gender || null,
            language: info?.language || language || null,
            tried: chain,
          };
        } catch (err) {
          const reason = String(err.stderr || err.message).split('\n').find((l) => /Error|error|No audio/i.test(l)) || err.message;
          errors.push(`${candidate}${attempt > 1 ? ' (повторно)' : ''}: ${reason.trim().slice(0, 140)}`);
          // Only this attempt's own scratch file, and only after the ownership checks in removeOwnFile.
          const cleanup = removeOwnFile(scratch, { dir: path.dirname(scratch), name: path.basename(scratch), notOlderThan: startedAt });
          if (!cleanup.removed && cleanup.reason !== 'already-gone') {
            console.warn(`[TTS] scratch ${path.basename(scratch)} kept (${cleanup.reason})`);
          }
          // A throttled endpoint needs a moment: retrying instantly only wastes a call.
          await sleep(400 * attempt);
        }
      }
      if (chain.length > 1) console.warn(`[TTS] edge voice ${candidate} не отдал аудио — пробую следующий голос`);
    }

    throw new Error(`edge-tts не смог озвучить текст (${chain.join(', ')}): ${errors[0] || 'нет аудио'}`);
  },
};