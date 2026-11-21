import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpeg from 'fluent-ffmpeg';
import { cleanText, shorten, wrapLines } from './text.js';
import { LANGUAGES } from './lang.js';
import { synthesize } from './tts/index.js';

const execFileAsync = promisify(execFile);

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
export const DURATION = 15;
const FFMPEG_TIMEOUT_SEC = 180;

export const STYLES = ['product', 'dynamic', 'premium', 'ugc'];

// Prefer an explicit FFMPEG_PATH / FFPROBE_PATH, otherwise the bundled npm binaries —
// a global ffmpeg install is not required.
export const FFMPEG_BIN = process.env.FFMPEG_PATH || ffmpegInstaller.path;
export const FFPROBE_BIN = process.env.FFPROBE_PATH || ffprobeInstaller.path;
ffmpeg.setFfmpegPath(FFMPEG_BIN);
ffmpeg.setFfprobePath(FFPROBE_BIN);

// A present-but-unusable binary (wrong path, truncated file, non-ffmpeg exe) is only detectable by
// executing it: health must report what actually works, not what exists on disk.
const BINARY_CHECK_TTL_MS = 5 * 60 * 1000;
const binaryChecks = new Map();

/** Runs `<bin> -version`; returns the first output line, or null when the binary cannot be used. */
export function checkBinary(bin, cacheKey, ttlMs = BINARY_CHECK_TTL_MS) {
  const cached = binaryChecks.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return cached.version;
  let version = null;
  try {
    const out = execFileSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').map((l) => l.trim()).find(Boolean);
    if (line && /ffmpeg|ffprobe|version/i.test(line)) version = line;
  } catch (err) {
    console.warn(`[HEALTH] ${cacheKey} unusable: ${err.code || err.message}`);
  }
  binaryChecks.set(cacheKey, { at: now, version });
  return version;
}

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

// Stage identifiers for diagnostic logging. Internal-only; never shown to clients.
export const IMAGE_VALIDATION_STAGE = Object.freeze({
  STRUCTURE: 'IMAGE_STRUCTURE_FAILED',
  FFPROBE: 'IMAGE_FFPROBE_FAILED',
  DIMENSIONS: 'IMAGE_DIMENSIONS_INVALID',
  FFMPEG: 'IMAGE_FFMPEG_FAILED',
});

// Extracts a bounded, single-line stderr excerpt from a subprocess error without exposing
// image bytes, paths, tokens, or environment details. Returns '' when unavailable.
function safeStderrExcerpt(err) {
  const raw = err && err.stderr;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : (typeof raw === 'string' ? raw : '');
  return text
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>')
    .replace(/\/tmp\/[^\s]+/g, '<path>')
    .replace(/\/[^\s]{3,}/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Default diagnostic sink: server-side console.error. Never throws — logging failures are swallowed
// so they cannot mask the original validation error or break the request.
function defaultLogDiagnostic(diagnostic) {
  try {
    console.error('[IMAGE] validation failed', JSON.stringify(diagnostic));
  } catch {
    // Intentionally empty: diagnostics must never affect validation outcome.
  }
}

/** Fully decodes the image; throws a user-facing message when it is corrupted or unusable.
 *
 * Diagnostic stage metadata is logged via the injected `logDiagnostic` sink (defaults to
 * console.error). The sink receives { stage, code, exitCode, stderr } and is called in a
 * try/catch so a throwing logger can never mask the original validation error.
 *
 * The generic client-facing error message is unchanged regardless of the failure stage.
 */
export async function validateImageDecodes(filePath, mimeType, deps = {}) {
  const execFile = typeof deps.execFile === 'function' ? deps.execFile : execFileAsync;
  const logDiagnostic = typeof deps.logDiagnostic === 'function' ? deps.logDiagnostic : defaultLogDiagnostic;

  const report = (stage, err) => {
    const diagnostic = {
      stage,
      code: err && err.code != null ? err.code : null,
      exitCode: (err && typeof err.code === 'number') ? err.code : (err && typeof err.status === 'number' ? err.status : null),
      stderr: safeStderrExcerpt(err),
    };
    try {
      logDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never break validation or mask the original error.
    }
  };

  if (!hasCompleteStructure(filePath, mimeType)) {
    report(IMAGE_VALIDATION_STAGE.STRUCTURE, null);
    throw new Error('Изображение повреждено или загружено не полностью');
  }
  let info;
  try {
    const { stdout } = await execFile(
      FFPROBE_BIN,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
      { timeout: 15000 }
    );
    info = JSON.parse(stdout).streams?.[0];
  } catch (err) {
    report(IMAGE_VALIDATION_STAGE.FFPROBE, err);
    throw decodeFailure(err);
  }
  if (!info?.width || !info?.height) {
    report(IMAGE_VALIDATION_STAGE.DIMENSIONS, null);
    throw new Error('Изображение повреждено или не читается');
  }
  if (info.width < 200 || info.height < 200) {
    report(IMAGE_VALIDATION_STAGE.DIMENSIONS, null);
    throw new Error('Изображение слишком маленькое (минимум 200×200)');
  }
  if (info.width > 12000 || info.height > 12000) {
    report(IMAGE_VALIDATION_STAGE.DIMENSIONS, null);
    throw new Error('Изображение слишком большое (максимум 12000px)');
  }
  try {
    await execFile(FFMPEG_BIN, ['-v', 'error', '-xerror', '-i', filePath, '-frames:v', '1', '-f', 'null', '-'], {
      timeout: 20000,
    });
  } catch (err) {
    report(IMAGE_VALIDATION_STAGE.FFMPEG, err);
    throw decodeFailure(err);
  }
}

// ── Script generation ────────────────────────────────────────────────────────
// The actual work lives in ./ai (providers, orchestration) and ./content (templates). This module
// only re-exports it, so server code keeps importing media.js for rendering and text helpers.

export { CATEGORIES, TEMPLATES, detectCategory, pickStyle, defaultCta, generateTemplateScript } from './content.js';
export {
  LANGUAGES,
  containsCyrillic,
  detectLanguage,
  foreignFields,
  hasUzbekMarkers,
  isUzbekCyrillic,
  normalizeUzbekApostrophes,
  normalizeUzbekText,
  transliterateUzbekCyrillic,
} from './lang.js';
export { cleanText, shorten, wrapLines } from './text.js';
export { AiError } from './ai/errors.js';
export { generateScript, providerStatus, isAiActive, warmUpProviders } from './ai/index.js';

/**
 * @deprecated Kept for callers written against the old API. Returns the legacy
 * { script, source } shape, where source is 'ai:<provider>' or 'template'.
 */
export async function generateAIScript(input) {
  const { script, source } = await generateScript(input);
  return { script, source: source.id, warning: source.warning, provider: source.provider, model: source.model, attempts: [] };
}


// ── Voice (no API key needed) ─────────────────────────────────────────────────
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(Number(data.format.duration) || 0)));
  });
}

// TTS_PROVIDER: auto = any available provider (best voice first), local = offline only,
// google = online only. The provider layer decides who actually speaks.
const TTS_MODES = ['auto', 'local', 'google'];
const requestedTtsMode = (process.env.TTS_PROVIDER || 'auto').trim().toLowerCase();
export const TTS_MODE = TTS_MODES.includes(requestedTtsMode) ? requestedTtsMode : 'auto';
if (requestedTtsMode !== TTS_MODE) console.warn(`[TTS] unknown TTS_PROVIDER "${process.env.TTS_PROVIDER}" — using "auto"`);

/** Languages where a male voice exists on this server (exposed to the UI via /api/health). */
export const MALE_VOICE_LANGUAGES = ['en', 'uz'];

/** True when a male voice can actually be produced for the language. */
export function maleVoiceAvailable(language) {
  return MALE_VOICE_LANGUAGES.includes(language);
}


const VOICE_LEAD_IN_SEC = 0.15;

/**
 * Places each phrase at the start of its subtitle segment (hook at 0 s, benefits at 3 s and 8 s,
 * CTA at 12 s), speeding a phrase up only if it would overrun its segment. Produces one 15 s track.
 */
async function alignToSegments(clipPaths, workDir) {
  const durations = await Promise.all(clipPaths.map(probeDuration));
  const outPath = path.join(workDir, 'voice.wav');
  const filters = SEGMENTS.map((seg, i) => {
    const length = seg.end - seg.start;
    const room = length - VOICE_LEAD_IN_SEC - 0.2;
    const tempo = durations[i] > room ? Math.min(2, durations[i] / room) : 1;
    const delayMs = Math.round(VOICE_LEAD_IN_SEC * 1000);
    return (
      `[${i}:a]aresample=44100,aformat=channel_layouts=stereo${tempo > 1 ? `,atempo=${tempo.toFixed(3)}` : ''},` +
      `adelay=${delayMs}|${delayMs},apad,atrim=start=0:end=${length},asetpts=N/SR/TB[s${i}]`
    );
  });
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg({ timeout: 60 });
    for (const p of clipPaths) cmd.input(p);
    cmd
      .complexFilter([...filters, `${SEGMENTS.map((_, i) => `[s${i}]`).join('')}concat=n=${SEGMENTS.length}:v=0:a=1[voice]`])
      .outputOptions(['-map [voice]', '-c:a pcm_s16le'])
      .output(outPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`voice alignment failed: ${err.message.split('\n')[0]}`)))
      .run();
  });
  return outPath;
}

/**
 * Produces the voiceover, synchronised with the subtitles.
 *
 * The provider is chosen by the TTS layer (exact language first, substitute second). The returned
 * object describes what actually spoke: `kind` is `tts-<provider>` or `silence`, `voiceLanguage` is
 * the language that was really spoken, and `warning` explains a substitute voice to the UI.
 */
export async function generateSpeech(script, language, voiceType, workDir, {
  synthesizeImpl = synthesize,
  alignImpl = alignToSegments,
} = {}) {
  const texts = SEGMENTS.map((seg) => script[seg.key].replace(/[.!?…]+$/, ''));

  const spoken = await synthesizeImpl({ texts, language, gender: voiceType, workDir });
  const audioPath = await alignImpl(spoken.clips, workDir);
  console.log(`[TTS] ${spoken.provider} voice: ${spoken.voice} (${spoken.voiceLanguage}${spoken.exactLanguage ? '' : ', substitute'})`);
  return {
    path: audioPath,
    duration: DURATION,
    aligned: true,
    kind: `tts-${spoken.provider}`,
    gender: spoken.gender,
    voiceLanguage: spoken.voiceLanguage,
    voiceName: spoken.voice,
    exactLanguage: spoken.exactLanguage,
    warning: spoken.warning,
  };
}

// ── Video render ──────────────────────────────────────────────────────────────
const SEGMENTS = [
  { key: 'hook', start: 0, end: 3, fontSize: 64 },
  { key: 'benefit1', start: 3, end: 8, fontSize: 56 },
  { key: 'benefit2', start: 8, end: 12, fontSize: 56 },
  { key: 'cta', start: 12, end: DURATION, fontSize: 72 },
];
const ACCENT = { premium: '#FFD700', dynamic: '#A3E635', product: '#FFFFFF', ugc: '#FFFFFF' };

/**
 * drawtext chain for the four timed segments. `ctaExtra` adds smaller lines (price, site)
 * under the CTA in the closing segment — used by the auto mode without a photo.
 */
function buildSubtitleFilters(script, style, workDir, ctaExtra = []) {
  const filters = [];
  let input = 'bg';
  let n = 0;
  const fontOpt = FONT_FILE ? `fontfile=${filterPath(FONT_FILE)}:` : '';

  SEGMENTS.forEach((seg, segIdx) => {
    const isCta = seg.key === 'cta';
    // Rough glyph width for bold Arial/DejaVu ≈ 0.56em; keep 80px side margins.
    const maxChars = Math.floor((WIDTH - 160) / (seg.fontSize * 0.56));
    const lines = wrapLines(script[seg.key], maxChars, 4).map((text) => ({ text, fontSize: seg.fontSize }));
    if (isCta) {
      for (const extra of ctaExtra) {
        const extraChars = Math.floor((WIDTH - 160) / (extra.fontSize * 0.56));
        lines.push(...wrapLines(extra.text, extraChars, 2).map((text) => ({ text, fontSize: extra.fontSize, color: extra.color })));
      }
    }
    const bottom = HEIGHT - 360; // clear of TikTok/Reels bottom UI

    // Stack lines upward from the bottom margin: the last line sits just above it.
    let below = 0;
    const placed = lines.map(() => 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      placed[i] = bottom - below - lines[i].fontSize;
      below += Math.round(lines[i].fontSize * 1.35);
    }

    lines.forEach((line, i) => {
      // Text goes through textfile= so ':', '%', quotes and backslashes need no escaping.
      const textFile = `seg${segIdx}_${i}.txt`;
      fs.writeFileSync(path.join(workDir, textFile), line.text, 'utf8');
      const out = `t${n++}`;
      const color = line.color || (isCta ? ACCENT[style] : 'white');
      filters.push(
        `[${input}]drawtext=${fontOpt}textfile=${textFile}:expansion=none:` +
          `fontcolor=${color}:fontsize=${line.fontSize}:` +
          `box=1:boxcolor=black@${isCta ? '0.75' : '0.6'}:boxborderw=16:` +
          `x=(w-text_w)/2:y=${placed[i]}:enable='between(t,${seg.start},${seg.end})'[${out}]`
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
    // A segment-aligned voice track is already exactly 15 s; only an unaligned one may need speeding up.
    const tempo = !voice.aligned && voice.duration > DURATION - 0.5 ? Math.min(2, voice.duration / (DURATION - 0.5)) : 1;
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

// ── Auto mode render: no photo, animated gradient background ─────────────────
// Per-category gradient [top, bottom, glow] for the auto mode without a photo.
const CATEGORY_PALETTES = {
  realty: ['#0E2A47', '#050D18', '#3B82F6'],
  food: ['#3A1206', '#120404', '#F97316'],
  shop: ['#2B0A3F', '#0B0313', '#A855F7'],
  service: ['#06281F', '#020E0A', '#10B981'],
  job: ['#101B33', '#04070D', '#60A5FA'],
  event: ['#33062B', '#0F020C', '#EC4899'],
  product: ['#132A33', '#04090B', '#22D3EE'],
  other: ['#16181D', '#050607', '#94A3B8'],
};

// Minimal truecolor PNG writer — ffmpeg ships no image generator on stock builds.
function crc32(chunk) {
  let crc = ~0;
  for (let i = 0; i < chunk.length; i++) {
    crc ^= chunk[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag, 'ascii'), data])));
  return Buffer.concat([len, Buffer.from(tag, 'ascii'), data, crc]);
}

function writePng(filePath, width, height, pixelFn) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // no filter per scanline
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * Auto-mode video from nothing but a voiceover + script: vertical gradient background
 * (pre-rendered PNG with a glow, animated by the same Ken Burns zoom as photo videos)
 * and the four subtitle segments (price/site in the CTA block).
 * Output settings mirror renderVideo. `voice` is the object returned by generateSpeech.
 */
export function renderAutoVideo({ voice, script, style, category = 'other', price, website, workDir, outputPath, onProgress }) {
  return new Promise((resolve, reject) => {
    const [top, bottom, glow] = CATEGORY_PALETTES[category] || CATEGORY_PALETTES.other;
    const [gr, gg, gb] = hexRgb(glow);
    const bgPath = path.join(workDir, 'auto-bg.png');
    const gcx = WIDTH * 0.5;
    const gcy = HEIGHT * 0.32;
    const gr0 = WIDTH * 0.95;
    writePng(bgPath, WIDTH, HEIGHT, (x, y) => {
      const t = y / HEIGHT;
      let [r, g, b] = mixRgb(hexRgb(top), hexRgb(bottom), t);
      const d = Math.hypot(x - gcx, y - gcy) / gr0;
      const k = Math.max(0, 1 - d) ** 2 * 0.35;
      r = Math.min(255, r + (gr - r) * k);
      g = Math.min(255, g + (gg - g) * k);
      b = Math.min(255, b + (gb - b) * k);
      return [r, g, b];
    });

    const ctaExtra = [];
    if (price) ctaExtra.push({ text: price, fontSize: 60, color: ACCENT[style] || 'white' });
    if (website) ctaExtra.push({ text: website, fontSize: 52, color: 'white' });

    const cmd = ffmpeg({ cwd: workDir, timeout: FFMPEG_TIMEOUT_SEC }).input(bgPath);
    if (voice.path) cmd.input(voice.path);
    else cmd.input('anullsrc=r=44100:cl=stereo').inputFormat('lavfi');

    const tempo = !voice.aligned && voice.duration > DURATION - 0.5 ? Math.min(2, voice.duration / (DURATION - 0.5)) : 1;
    const { filters, output } = buildSubtitleFilters(script, style, workDir, ctaExtra);

    cmd
      .complexFilter([
        `[0:v]scale=${WIDTH}:${HEIGHT},setsar=1,` +
          `zoompan=z='min(zoom+0.0005,1.18)':d=${DURATION * FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS}[bg]`,
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
