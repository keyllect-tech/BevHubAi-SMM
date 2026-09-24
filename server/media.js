import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpeg from 'fluent-ffmpeg';
import * as googleTTS from 'google-tts-api';

const execFileAsync = promisify(execFile);

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
export const DURATION = 15;
const FFMPEG_TIMEOUT_SEC = 180;

export const LANGUAGES = { ru: 'Russian', uz: 'Uzbek', en: 'English' };
export const STYLES = ['product', 'dynamic', 'premium', 'ugc'];

// Prefer an explicit FFMPEG_PATH / FFPROBE_PATH, otherwise the bundled npm binaries —
// a global ffmpeg install is not required.
export const FFMPEG_BIN = process.env.FFMPEG_PATH || ffmpegInstaller.path;
export const FFPROBE_BIN = process.env.FFPROBE_PATH || ffprobeInstaller.path;
ffmpeg.setFfmpegPath(FFMPEG_BIN);
ffmpeg.setFfprobePath(FFPROBE_BIN);

// A font with Cyrillic + Uzbek Latin glyphs is required for subtitles.
const FONT_CANDIDATES = [
  process.env.SUBTITLE_FONT,
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial.ttf',
].filter(Boolean);
export const FONT_FILE = FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;

// ── Text helpers ──────────────────────────────────────────────────────────────
export function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Truncate at a word boundary so subtitles never end mid-word.
function shorten(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

function wrapLines(text, maxChars, maxLines) {
  const words = text.split(' ').flatMap((w) => {
    const parts = [];
    for (let i = 0; i < w.length; i += maxChars) parts.push(w.slice(i, i + maxChars));
    return parts;
  });
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && (current + ' ' + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = shorten(`${kept[maxLines - 1]} ${lines[maxLines]}`, maxChars);
    return kept;
  }
  return lines;
}

// Filtergraph option value: quote it and escape ':' (needed for Windows drive letters).
function filterPath(p) {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}

// ── Image validation ──────────────────────────────────────────────────────────
export function detectImageType(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// The bundled FFmpeg decodes a truncated JPEG without reporting an error, so check that the file
// actually ends where its format says it should.
function hasCompleteStructure(filePath, mimeType) {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const readTail = (n) => {
      const len = Math.min(size, n);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf;
    };
    if (mimeType === 'image/jpeg') return readTail(1024).lastIndexOf(Buffer.from([0xff, 0xd9])) !== -1;
    if (mimeType === 'image/png') return readTail(64).includes(Buffer.from('IEND'));
    if (mimeType === 'image/webp') {
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      return header.readUInt32LE(4) + 8 <= size;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// A missing FFmpeg/FFprobe binary is a server problem, not a bad upload: mark it internal (→ 500 + log).
const decodeFailure = (err) =>
  err?.code === 'ENOENT'
    ? Object.assign(new Error(`FFmpeg/FFprobe binary not found: ${err.path}`), { internal: true })
    : new Error('Изображение повреждено или не читается');

/** Fully decodes the image; throws a user-facing message when it is corrupted or unusable. */
export async function validateImageDecodes(filePath, mimeType) {
  if (!hasCompleteStructure(filePath, mimeType)) throw new Error('Изображение повреждено или загружено не полностью');
  let info;
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
      { timeout: 15000 }
    );
    info = JSON.parse(stdout).streams?.[0];
  } catch (err) {
    throw decodeFailure(err);
  }
  if (!info?.width || !info?.height) throw new Error('Изображение повреждено или не читается');
  if (info.width < 200 || info.height < 200) throw new Error('Изображение слишком маленькое (минимум 200×200)');
  if (info.width > 12000 || info.height > 12000) throw new Error('Изображение слишком большое (максимум 12000px)');
  try {
    await execFileAsync(FFMPEG_BIN, ['-v', 'error', '-xerror', '-i', filePath, '-frames:v', '1', '-f', 'null', '-'], {
      timeout: 20000,
    });
  } catch (err) {
    throw decodeFailure(err);
  }
}

// ── AI Script Generation ──────────────────────────────────────────────────────
// After the key is rejected (auth error or exhausted credits) there is no point calling OpenAI on
// every request: it only adds latency. Back off and use the local generator meanwhile.
let openaiPausedUntil = 0;
const OPENAI_BACKOFF_MS = 30 * 60 * 1000;
const OPENAI_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

/** True when a script request would actually call (and bill) OpenAI. */
export function isOpenAIActive() {
  return Boolean(process.env.OPENAI_API_KEY) && Date.now() >= openaiPausedUntil;
}

export async function generateAIScript({ productName, description, cta, language, style }) {
  const apiKey = isOpenAIActive() ? process.env.OPENAI_API_KEY : null;
  const langLabel = LANGUAGES[language];

  if (apiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `You are an expert short-form video ad scriptwriter. Write a 15-second vertical video ad script in ${langLabel}. Style: ${style}.
Return ONLY valid JSON: {"hook":"0-3s","benefit1":"3-8s","benefit2":"8-12s","cta":"12-15s"}
Rules: every field in ${langLabel}; punchy; each field under 60 characters; do NOT invent features that are not in the description; the cta field must convey the user's CTA.`,
            },
            { role: 'user', content: `Product: ${productName}\nDescription: ${description || 'N/A'}\nCTA: ${cta || 'N/A'}` },
          ],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const errType = data?.error?.type || data?.error?.code;
        const keyUnusable =
          res.status === 401 || res.status === 403 || ['insufficient_quota', 'credit_balance_exhausted'].includes(errType) ||
          data?.error?.code === 'credit_balance_exhausted';
        if (keyUnusable) {
          openaiPausedUntil = Date.now() + OPENAI_BACKOFF_MS;
          console.warn(`[AI SCRIPT] OpenAI key unusable (HTTP ${res.status}) — using the local generator for the next 30 minutes`);
        } else if (res.status === 429) {
          // Plain rate limit: brief pause, honouring Retry-After when present.
          const retryAfterMs = Number(res.headers.get('retry-after')) * 1000;
          openaiPausedUntil = Date.now() + (retryAfterMs > 0 ? Math.min(retryAfterMs, 5 * 60 * 1000) : OPENAI_RATE_LIMIT_BACKOFF_MS);
        }
        throw new Error(`OpenAI HTTP ${res.status}: ${data?.error?.message || 'unknown error'}`);
      }

      const content = JSON.parse(data?.choices?.[0]?.message?.content || 'null');
      const script = {
        hook: cleanText(content?.hook, 80),
        benefit1: cleanText(content?.benefit1, 80),
        benefit2: cleanText(content?.benefit2, 80),
        cta: cleanText(content?.cta, 60) || cta,
      };
      if (!script.hook || !script.benefit1 || !script.benefit2 || !script.cta) throw new Error('Invalid AI response structure');
      console.log(`[AI SCRIPT] OpenAI script generated (${language}/${style})`);
      return { script, source: 'openai' };
    } catch (err) {
      console.error('[AI SCRIPT] OpenAI failed, using fallback:', err.message);
    }
  }

  return { script: generateFallbackScript({ productName, description, cta, language, style }), source: 'fallback' };
}

// Local script generator: works with no API key at all, and offers a different phrasing each run
// so "another variant" in the UI actually produces something new. Phrases are deliberately generic:
// no invented facts, reviews or social proof ("thousands already bought") in someone's ad.
const TEMPLATES = {
  ru: {
    hooks: {
      product: ['Знакомьтесь — {name}', '{name}: то, что вы искали', 'Встречайте {name}'],
      dynamic: ['Стоп! {name} меняет всё', 'Только посмотрите на {name}', 'Три секунды — и вы захотите {name}'],
      premium: ['{name}. Создано для лучших', '{name} — когда выбираешь лучшее', 'Премиум в каждой детали: {name}'],
      ugc: ['Смотрите, что я нашёл: {name}', 'Вот почему стоит присмотреться к {name}', '{name} — без фильтров'],
    },
    benefits: ['Продумана каждая деталь', 'Стиль и удобство в одном', 'Создано с вниманием к деталям'],
    closers: ['Для тех, кто выбирает лучшее', 'Попробуйте сами', 'Узнайте больше прямо сейчас'],
    cta: 'Закажите сейчас',
  },
  uz: {
    hooks: {
      product: ['{name} — siz kutgan narsa', '{name}: aynan sizga kerak', 'Tanishing: {name}'],
      dynamic: ['Toʻxtang! {name} hammasini oʻzgartiradi', '{name}ga bir qarang', 'Uch soniya — va {name} sizniki'],
      premium: ['{name}. Eng yaxshilar uchun', '{name} — eng yaxshisini tanlaganlarga', 'Har bir detalda premium: {name}'],
      ugc: ['Qarang, nima topdim: {name}', 'Nega {name}ga eʼtibor berish kerak', '{name} — filtrsiz'],
    },
    benefits: ['Har bir detal oʻylangan', 'Uslub va qulaylik birgalikda', 'Eʼtibor bilan yaratilgan'],
    closers: ['Eng yaxshisini tanlaganlar uchun', 'Oʻzingiz sinab koʻring', 'Batafsil hoziroq bilib oling'],
    cta: 'Hozir buyurtma qiling',
  },
  en: {
    hooks: {
      product: ['Meet {name}', '{name}: exactly what you were looking for', 'Introducing {name}'],
      dynamic: ['Stop scrolling. {name} changes everything', 'Just look at {name}', 'Three seconds and you will want {name}'],
      premium: ['{name}. Crafted for those who expect more', '{name} — when only the best will do', 'Premium in every detail: {name}'],
      ugc: ['Look what I found: {name}', "Here's why {name} is worth a look", '{name}, no filter'],
    },
    benefits: ['Every detail considered', 'Style and comfort in one', 'Made with attention to detail'],
    closers: ['For those who choose the best', 'See it for yourself', 'Find out more today'],
    cta: 'Order now',
  },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Splits the product description into two subtitle-sized selling points. */
function splitDescription(description) {
  const sentences = (description || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, '').trim())
    .filter(Boolean);
  if (sentences.length >= 2) return [sentences[0], sentences.slice(1).join('. ')];

  const single = sentences[0] || '';
  if (single.length > 60 && single.includes(',')) {
    // One long sentence: break it at the comma closest to the middle.
    const commas = [...single.matchAll(/,/g)].map((m) => m.index);
    const middle = single.length / 2;
    const at = commas.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best), commas[0]);
    return [single.slice(0, at).trim(), single.slice(at + 1).trim()];
  }
  return [single, ''];
}

function generateFallbackScript({ productName, description, cta, language, style }) {
  const t = TEMPLATES[language];
  const [first, second] = splitDescription(description);
  return {
    // Function replacer: a product name containing "$&" or "$$" must be inserted literally.
    hook: shorten(pick(t.hooks[style] || t.hooks.dynamic).replace('{name}', () => productName), 90),
    benefit1: shorten(first || pick(t.benefits), 90),
    benefit2: shorten(second || pick(t.closers), 90),
    cta: shorten(cta || t.cta, 60),
  };
}

// ── Voice (no API key needed) ─────────────────────────────────────────────────
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(Number(data.format.duration) || 0)));
  });
}

// auto = online voice when reachable, offline Windows voice otherwise; local = always offline;
// google = online only.
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'auto').toLowerCase();
const ONLINE_TTS_TIMEOUT_MS = 8000;
const ONLINE_TTS_ATTEMPTS = TTS_PROVIDER === 'google' ? 3 : 1;
// After the online voice fails, skip it for a while so each video doesn't wait for a timeout first.
const ONLINE_TTS_PAUSE_MS = 5 * 60 * 1000;
let onlineTtsPausedUntil = 0;

// Offline Windows voices (SAPI). Preferred voice per language/gender; any installed voice of the
// same culture is accepted as a substitute, but never a voice of another language.
const SAPI = {
  ru: { culture: 'ru-RU', female: 'Microsoft Irina Desktop', male: null },
  uz: { culture: 'ru-RU', female: 'Microsoft Irina Desktop', male: null },
  en: { culture: 'en-US', female: 'Microsoft Zira Desktop', male: 'Microsoft David Desktop' },
};

/** Only English has a male voice (offline David); the online voice is female-only. */
export function maleVoiceAvailable(language) {
  return language === 'en' && process.platform === 'win32' && TTS_PROVIDER !== 'google';
}

// PowerShell single-quoted literal: forward slashes, and ' doubled (paths like C:\Users\O'Brien).
const psString = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "''")}'`;

async function localSpeech(text, language, voiceType, workDir) {
  if (process.platform !== 'win32') throw new Error('offline voice is only available on Windows');
  const cfg = SAPI[language] || SAPI.ru;
  const male = voiceType === 'male' && Boolean(cfg.male);
  const preferred = male ? cfg.male : cfg.female;
  const textPath = path.join(workDir, 'voice-text.txt');
  const wavPath = path.join(workDir, 'voice.wav');
  fs.writeFileSync(textPath, text, 'utf8');

  // A voice of the right language is mandatory: an English voice reading Cyrillic produces garbage.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$voice = $voices | Where-Object { $_.Name -eq ${psString(preferred)} } | Select-Object -First 1
if (-not $voice) { $voice = $voices | Where-Object { $_.Culture.Name -eq ${psString(cfg.culture)} -and "$($_.Gender)" -eq ${psString(male ? 'Male' : 'Female')} } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Culture.Name -eq ${psString(cfg.culture)} } | Select-Object -First 1 }
if (-not $voice) { throw ${psString(`No ${cfg.culture} voice installed in Windows`)} }
$synth.SelectVoice($voice.Name)
$synth.Rate = 1
$synth.SetOutputToWaveFile(${psString(wavPath)})
$synth.Speak([IO.File]::ReadAllText(${psString(textPath)}, [Text.Encoding]::UTF8))
$synth.Dispose()
Write-Output $voice.Name
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60000 });
  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1000) throw new Error('offline voice produced no audio');
  return { path: wavPath, voice: stdout.trim() };
}

async function googleSpeech(text, language, workDir) {
  // Google TTS has no Uzbek voice — Uzbek Latin text is read with the Russian voice.
  const lang = language === 'en' ? 'en' : 'ru';
  let lastError;
  for (let attempt = 1; attempt <= ONLINE_TTS_ATTEMPTS; attempt++) {
    try {
      const parts = await googleTTS.getAllAudioBase64(text, { lang, slow: false, timeout: ONLINE_TTS_TIMEOUT_MS, splitPunct: ',.!?' });
      const buffer = Buffer.concat(parts.map((p) => Buffer.from(p.base64, 'base64')));
      if (buffer.length < 1000) throw new Error('empty response');
      const audioPath = path.join(workDir, 'voice.mp3');
      fs.writeFileSync(audioPath, buffer);
      return audioPath;
    } catch (err) {
      lastError = err;
      if (attempt < ONLINE_TTS_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

export async function generateSpeech(script, language, voiceType, workDir) {
  const text = [script.hook, script.benefit1, script.benefit2, script.cta].map((s) => s.replace(/[.!?…]+$/, '')).join('. ');
  const uzNote = language === 'uz' ? '-ru-voice' : '';
  // The online voice is female-only, so a requested male English voice goes straight to the offline one.
  const needsOfflineVoice = voiceType === 'male' && maleVoiceAvailable(language);
  const tryOnline = TTS_PROVIDER === 'google' || (TTS_PROVIDER === 'auto' && !needsOfflineVoice && Date.now() >= onlineTtsPausedUntil);

  if (tryOnline) {
    try {
      const audioPath = await googleSpeech(text, language, workDir);
      return { path: audioPath, duration: await probeDuration(audioPath), kind: `tts-online${uzNote}` };
    } catch (err) {
      if (TTS_PROVIDER === 'google') {
        console.error('[TTS] online voice failed, using silent audio track:', err.message);
        return { path: null, duration: 0, kind: 'silence' };
      }
      onlineTtsPausedUntil = Date.now() + ONLINE_TTS_PAUSE_MS;
      console.warn('[TTS] online voice unavailable — using the offline voice for the next 5 minutes:', err.message);
    }
  }

  try {
    const { path: wavPath, voice } = await localSpeech(text, language, voiceType, workDir);
    console.log(`[TTS] offline voice: ${voice}`);
    return { path: wavPath, duration: await probeDuration(wavPath), kind: `tts-offline${uzNote}` };
  } catch (err) {
    console.error('[TTS] offline voice failed, using silent audio track:', err.message);
    return { path: null, duration: 0, kind: 'silence' };
  }
}

// ── Video render ──────────────────────────────────────────────────────────────
const SEGMENTS = [
  { key: 'hook', start: 0, end: 3, fontSize: 64 },
  { key: 'benefit1', start: 3, end: 8, fontSize: 56 },
  { key: 'benefit2', start: 8, end: 12, fontSize: 56 },
  { key: 'cta', start: 12, end: DURATION, fontSize: 72 },
];
const ACCENT = { premium: '#FFD700', dynamic: '#A3E635', product: '#FFFFFF', ugc: '#FFFFFF' };

function buildSubtitleFilters(script, style, workDir) {
  const filters = [];
  let input = 'bg';
  let n = 0;
  const fontOpt = FONT_FILE ? `fontfile=${filterPath(FONT_FILE)}:` : '';

  SEGMENTS.forEach((seg, segIdx) => {
    const isCta = seg.key === 'cta';
    // Rough glyph width for bold Arial/DejaVu ≈ 0.56em; keep 80px side margins.
    const maxChars = Math.floor((WIDTH - 160) / (seg.fontSize * 0.56));
    const lines = wrapLines(script[seg.key], maxChars, 4);
    const lineHeight = Math.round(seg.fontSize * 1.35);
    const bottom = HEIGHT - 360; // clear of TikTok/Reels bottom UI

    lines.forEach((line, i) => {
      // Text goes through textfile= so ':', '%', quotes and backslashes need no escaping.
      const textFile = `seg${segIdx}_${i}.txt`;
      fs.writeFileSync(path.join(workDir, textFile), line, 'utf8');
      const y = bottom - (lines.length - i) * lineHeight;
      const out = `t${n++}`;
      filters.push(
        `[${input}]drawtext=${fontOpt}textfile=${textFile}:expansion=none:` +
          `fontcolor=${isCta ? ACCENT[style] : 'white'}:fontsize=${seg.fontSize}:` +
          `box=1:boxcolor=black@${isCta ? '0.75' : '0.6'}:boxborderw=16:` +
          `x=(w-text_w)/2:y=${y}:enable='between(t,${seg.start},${seg.end})'[${out}]`
      );
      input = out;
    });
  });
  return { filters, output: input };
}

export function renderVideo({ imagePath, voice, script, style, workDir, outputPath, onProgress }) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg({ cwd: workDir, timeout: FFMPEG_TIMEOUT_SEC }).input(imagePath);
    if (voice.path) cmd.input(voice.path);
    else cmd.input('anullsrc=r=44100:cl=stereo').inputFormat('lavfi');

    // Speed up long voiceovers so the whole script fits into 15 seconds.
    const tempo = voice.duration > DURATION - 0.5 ? Math.min(2, voice.duration / (DURATION - 0.5)) : 1;
    const { filters, output } = buildSubtitleFilters(script, style, workDir);

    cmd
      .complexFilter([
        // Single still image → 450 frames of slow Ken Burns zoom at 1080x1920.
        `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,` +
          `zoompan=z='min(zoom+0.0006,1.25)':d=${DURATION * FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS}[bg]`,
        ...filters,
        `[1:a]aresample=44100,aformat=channel_layouts=stereo${tempo !== 1 ? `,atempo=${tempo.toFixed(3)}` : ''},apad[aout]`,
      ])
      .outputOptions([
        `-map [${output}]`,
        '-map [aout]',
        '-c:v libx264',
        '-preset veryfast',
        '-crf 23',
        '-pix_fmt yuv420p',
        `-r ${FPS}`,
        '-c:a aac',
        '-b:a 160k',
        `-t ${DURATION}`,
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('progress', (p) => {
        const [h, m, s] = String(p.timemark || '0:0:0').split(':').map(Number);
        onProgress(Math.min(1, ((h || 0) * 3600 + (m || 0) * 60 + (s || 0)) / DURATION));
      })
      .on('end', resolve)
      .on('error', (err, _stdout, stderr) => {
        console.error('[FFMPEG] error:', err.message, '\n', String(stderr || '').split('\n').slice(-8).join('\n'));
        reject(new Error('Не удалось собрать видео (ошибка FFmpeg)'));
      })
      .run();
  });
}
