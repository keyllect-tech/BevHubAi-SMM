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
// Providers, in order: OpenAI (when a working key is set) → Ollama (free local model, no key)
// → the built-in template generator. Every step falls through to the next on any failure.

/** Kinds of ads the app writes scripts for. */
export const CATEGORIES = ['product', 'realty', 'food', 'shop', 'service', 'job', 'event', 'other'];
const CATEGORY_LABELS = {
  product: 'product for sale',
  realty: 'real estate (sale or rent of an apartment, house, office or commercial space)',
  food: 'restaurant, cafe or food delivery',
  shop: 'shop or store',
  service: 'service business',
  job: 'job vacancy / hiring announcement',
  event: 'event, class or promotion',
  other: 'general announcement',
};

// After the key is rejected (auth error or exhausted credits) there is no point calling OpenAI on
// every request: it only adds latency. Back off and use the next provider meanwhile.
let openaiPausedUntil = 0;
const OPENAI_BACKOFF_MS = 30 * 60 * 1000;
const OPENAI_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

/** True when a script request would actually call (and bill) OpenAI. */
export function isOpenAIActive() {
  return Boolean(process.env.OPENAI_API_KEY) && Date.now() >= openaiPausedUntil;
}

// Ollama: a local LLM server (https://ollama.com). Free, offline, no API key.
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const OLLAMA_TIMEOUT_MS = 90000; // the first request also loads the model into memory
let ollamaCheckedAt = 0;
let ollamaReady = false;

/** Is the Ollama server running with the configured model pulled? Cached for a minute. */
export async function ollamaAvailable({ fresh = false } = {}) {
  if (process.env.OLLAMA_DISABLED === 'true') return false;
  if (!fresh && Date.now() - ollamaCheckedAt < 60000) return ollamaReady;
  ollamaCheckedAt = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    ollamaReady = res.ok && (data.models || []).some((m) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL);
  } catch {
    ollamaReady = false;
  }
  return ollamaReady;
}

/** Loads the model into memory in the background so the first real request is fast. */
export async function warmUpOllama() {
  if (!(await ollamaAvailable({ fresh: true }))) {
    console.log(`[AI SCRIPT] Ollama not available (model ${OLLAMA_MODEL}) — local templates will be used without an OpenAI key`);
    return;
  }
  console.log(`[AI SCRIPT] Ollama ready (model ${OLLAMA_MODEL}) — warming up`);
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: 'ok', stream: false, keep_alive: '30m', options: { num_predict: 1 } }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  }).catch(() => {});
}

function scriptPrompt({ productName, description, cta, language, style, category }) {
  const langLabel = LANGUAGES[language] + (language === 'uz' ? ' (Latin alphabet)' : '');
  const system = `You write scripts for 15-second vertical video ads (TikTok, Reels, Shorts).
Ad type: ${CATEGORY_LABELS[category] || CATEGORY_LABELS.other}. Visual style: ${style}.
Write every field ONLY in ${langLabel}.
Return ONLY valid JSON with exactly these keys: {"hook":"...","benefit1":"...","benefit2":"...","cta":"..."}
- hook (0-3 s): a short attention-grabbing opening, at most 7 words
- benefit1 (3-8 s): the strongest point from the description, at most 10 words
- benefit2 (8-12 s): a second, different point from the description, at most 10 words
- cta (12-15 s): the call to action, based on the user's call to action, at most 5 words
Rules: rewrite the user's words into catchy ad copy; use only facts from the title and description;
never invent prices, numbers, reviews, guarantees or deadlines; no emojis, hashtags or quotation marks.`;
  const user = `Title: ${productName}\nDescription: ${description}\nCall to action: ${cta}`;
  return { system, user };
}

const CYRILLIC = /[Ѐ-ӿ]/;

/** Validates a model's JSON answer; rejects wrong-language or incomplete scripts. */
function acceptScript(content, { cta, language }) {
  const clean = (v, n) => cleanText(typeof v === 'string' ? v.replace(/^["«']+|["»']+$/g, '') : '', n);
  const script = {
    hook: clean(content?.hook, 80),
    benefit1: clean(content?.benefit1, 90),
    benefit2: clean(content?.benefit2, 90),
    cta: clean(content?.cta, 60) || cta,
  };
  if (!script.hook || !script.benefit1 || !script.benefit2 || !script.cta) throw new Error('incomplete script');
  const text = Object.values(script).join(' ');
  if (language === 'ru' && !CYRILLIC.test(text)) throw new Error('script is not in Russian');
  if (language !== 'ru' && CYRILLIC.test(text)) throw new Error(`script is not in ${LANGUAGES[language]}`);
  return script;
}

async function openaiScript(input, apiKey) {
  const { system, user } = scriptPrompt(input);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Never shorten a longer pause another request already set.
    const pauseFor = (ms) => {
      openaiPausedUntil = Math.max(openaiPausedUntil, Date.now() + ms);
    };
    const codes = [data?.error?.type, data?.error?.code];
    const keyUnusable = res.status === 401 || res.status === 403 || codes.some((c) => ['insufficient_quota', 'credit_balance_exhausted'].includes(c));
    if (keyUnusable) {
      pauseFor(OPENAI_BACKOFF_MS);
      console.warn(`[AI SCRIPT] OpenAI key unusable (HTTP ${res.status}) — not calling OpenAI for the next 30 minutes`);
    } else if (res.status === 429) {
      // Plain rate limit: brief pause, honouring Retry-After when present.
      const retryAfterMs = Number(res.headers.get('retry-after')) * 1000;
      pauseFor(retryAfterMs > 0 ? Math.min(retryAfterMs, 5 * 60 * 1000) : OPENAI_RATE_LIMIT_BACKOFF_MS);
    }
    throw new Error(`OpenAI HTTP ${res.status}: ${data?.error?.message || 'unknown error'}`);
  }
  return acceptScript(JSON.parse(data?.choices?.[0]?.message?.content || 'null'), input);
}

async function ollamaScript(input) {
  const { system, user } = scriptPrompt(input);
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return acceptScript(JSON.parse(data?.message?.content || 'null'), input);
}

export async function generateAIScript({ productName, description, cta, language, style, category = 'product' }) {
  const input = { productName, description, cta, language, style, category: CATEGORIES.includes(category) ? category : 'other' };

  if (isOpenAIActive()) {
    try {
      const script = await openaiScript(input, process.env.OPENAI_API_KEY);
      console.log(`[AI SCRIPT] OpenAI script (${input.category}/${language})`);
      return { script, source: 'openai' };
    } catch (err) {
      console.error('[AI SCRIPT] OpenAI failed:', err.message);
    }
  }

  if (await ollamaAvailable()) {
    // Small local models occasionally answer in the wrong language: one retry, then templates.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const t0 = Date.now();
        const script = await ollamaScript(input);
        console.log(`[AI SCRIPT] Ollama script (${input.category}/${language}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return { script, source: 'ollama' };
      } catch (err) {
        console.warn(`[AI SCRIPT] Ollama attempt ${attempt} failed: ${err.message}`);
      }
    }
  }

  return { script: generateFallbackScript(input), source: 'fallback' };
}

// Built-in template generator: works with no AI at all and offers a different phrasing each run.
// Phrases are deliberately generic — no invented facts, reviews or social proof in someone's ad.
const TEMPLATES = {
  ru: {
    product: {
      hooks: {
        product: ['Знакомьтесь — {name}', '{name}: то, что вы искали', 'Встречайте {name}'],
        dynamic: ['Стоп! {name} меняет всё', 'Только посмотрите на {name}', 'Три секунды — и вы захотите {name}'],
        premium: ['{name}. Создано для лучших', '{name} — когда выбираешь лучшее', 'Премиум в каждой детали: {name}'],
        ugc: ['Смотрите, что я нашёл: {name}', 'Вот почему стоит присмотреться к {name}', '{name} — без фильтров'],
      },
      closers: ['Для тех, кто выбирает лучшее', 'Попробуйте сами', 'Узнайте больше прямо сейчас'],
      cta: 'Закажите сейчас',
    },
    realty: { hooks: ['{name} — ваш новый адрес', 'Ищете помещение? {name}', 'Предложение: {name}'], closers: ['Посмотрите лично', 'Все детали — по телефону'], cta: 'Запишитесь на просмотр' },
    food: { hooks: ['Проголодались? {name} ждёт вас', '{name} — вкус, ради которого возвращаются', 'Сегодня ужинаем в {name}'], closers: ['Ждём вас в гости', 'Забронируйте столик заранее'], cta: 'Забронируйте столик' },
    shop: { hooks: ['{name} — всё нужное в одном месте', 'Загляните в {name}', 'Новинки уже в {name}'], closers: ['Приходите — поможем с выбором', 'Ждём вас в магазине'], cta: 'Приходите в магазин' },
    service: { hooks: ['{name} — сделаем за вас', 'Нужна помощь? {name}', '{name}: решаем задачу под ключ'], closers: ['Обсудим вашу задачу', 'Оставьте заявку — свяжемся с вами'], cta: 'Оставьте заявку' },
    job: { hooks: ['Мы ищем: {name}', 'Открыта вакансия — {name}', 'Присоединяйтесь к команде: {name}'], closers: ['Растите вместе с нами', 'Отправьте резюме сегодня'], cta: 'Откликнитесь сейчас' },
    event: { hooks: ['Не пропустите: {name}', '{name} — ждём вас!', 'Приглашаем: {name}'], closers: ['Приходите с друзьями', 'Все подробности — по ссылке'], cta: 'Зарегистрируйтесь' },
    other: { hooks: ['Знакомьтесь: {name}', 'Важное объявление: {name}', '{name} — узнайте подробнее'], closers: ['Узнайте больше', 'Свяжитесь с нами'], cta: 'Узнать подробнее' },
    benefits: ['Продумана каждая деталь', 'Стиль и удобство в одном', 'Создано с вниманием к деталям'],
  },
  uz: {
    product: {
      hooks: {
        product: ['{name} — siz kutgan narsa', '{name}: aynan sizga kerak', 'Tanishing: {name}'],
        dynamic: ['Toʻxtang! {name} hammasini oʻzgartiradi', '{name}ga bir qarang', 'Uch soniya — va {name} sizniki'],
        premium: ['{name}. Eng yaxshilar uchun', '{name} — eng yaxshisini tanlaganlarga', 'Har bir detalda premium: {name}'],
        ugc: ['Qarang, nima topdim: {name}', 'Nega {name}ga eʼtibor berish kerak', '{name} — filtrsiz'],
      },
      closers: ['Eng yaxshisini tanlaganlar uchun', 'Oʻzingiz sinab koʻring', 'Batafsil hoziroq bilib oling'],
      cta: 'Hozir buyurtma qiling',
    },
    realty: { hooks: ['{name} — yangi manzilingiz', 'Joy qidiryapsizmi? {name}', 'Taklif: {name}'], closers: ['Oʻzingiz kelib koʻring', 'Tafsilotlar telefon orqali'], cta: 'Koʻrishga yoziling' },
    food: { hooks: ['Qorningiz ochdimi? {name} sizni kutmoqda', '{name} — qaytib keladigan taʼm', 'Bugun {name}da kechki ovqat'], closers: ['Sizni mehmonga kutamiz', 'Stolni oldindan band qiling'], cta: 'Stol band qiling' },
    shop: { hooks: ['{name} — hammasi bir joyda', '{name}ga kiring', 'Yangiliklar {name}da'], closers: ['Keling — tanlashda yordam beramiz', 'Doʻkonda kutamiz'], cta: 'Doʻkonga keling' },
    service: { hooks: ['{name} — biz siz uchun bajaramiz', 'Yordam kerakmi? {name}', '{name}: vazifani toʻliq hal qilamiz'], closers: ['Vazifangizni muhokama qilamiz', 'Ariza qoldiring — bogʻlanamiz'], cta: 'Ariza qoldiring' },
    job: { hooks: ['Biz izlayapmiz: {name}', 'Boʻsh ish oʻrni — {name}', 'Jamoaga qoʻshiling: {name}'], closers: ['Biz bilan birga oʻsing', 'Rezyumeni bugun yuboring'], cta: 'Hoziroq javob bering' },
    event: { hooks: ['Oʻtkazib yubormang: {name}', '{name} — sizni kutamiz!', 'Taklif qilamiz: {name}'], closers: ['Doʻstlaringiz bilan keling', 'Batafsil maʼlumot — havolada'], cta: 'Roʻyxatdan oʻting' },
    other: { hooks: ['Tanishing: {name}', 'Muhim eʼlon: {name}', '{name} — batafsil bilib oling'], closers: ['Batafsil bilib oling', 'Biz bilan bogʻlaning'], cta: 'Batafsil bilish' },
    benefits: ['Har bir detal oʻylangan', 'Uslub va qulaylik birgalikda', 'Eʼtibor bilan yaratilgan'],
  },
  en: {
    product: {
      hooks: {
        product: ['Meet {name}', '{name}: exactly what you were looking for', 'Introducing {name}'],
        dynamic: ['Stop scrolling. {name} changes everything', 'Just look at {name}', 'Three seconds and you will want {name}'],
        premium: ['{name}. Crafted for those who expect more', '{name} — when only the best will do', 'Premium in every detail: {name}'],
        ugc: ['Look what I found: {name}', "Here's why {name} is worth a look", '{name}, no filter'],
      },
      closers: ['For those who choose the best', 'See it for yourself', 'Find out more today'],
      cta: 'Order now',
    },
    realty: { hooks: ['{name} — your new address', 'Looking for a space? {name}', 'Now available: {name}'], closers: ['See it in person', 'Details on request'], cta: 'Book a viewing' },
    food: { hooks: ['Hungry? {name} is waiting', '{name} — a taste worth coming back for', 'Tonight, dinner at {name}'], closers: ['We look forward to seeing you', 'Reserve your table in advance'], cta: 'Reserve a table' },
    shop: { hooks: ['{name} — everything in one place', 'Drop by {name}', 'New arrivals at {name}'], closers: ['Come in — we will help you choose', 'See you in store'], cta: 'Visit the store' },
    service: { hooks: ['{name} — we handle it for you', 'Need help? {name}', '{name}: done end to end'], closers: ["Let's discuss your task", 'Leave a request — we will call you back'], cta: 'Leave a request' },
    job: { hooks: ["We're hiring: {name}", 'Open position — {name}', 'Join the team: {name}'], closers: ['Grow with us', 'Send your CV today'], cta: 'Apply now' },
    event: { hooks: ["Don't miss it: {name}", '{name} — see you there!', "You're invited: {name}"], closers: ['Bring your friends', 'All the details at the link'], cta: 'Register now' },
    other: { hooks: ['Meet {name}', 'Announcement: {name}', '{name} — find out more'], closers: ['Find out more', 'Get in touch'], cta: 'Learn more' },
    benefits: ['Every detail considered', 'Style and comfort in one', 'Made with attention to detail'],
  },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Splits the description into two subtitle-sized selling points. */
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

const capitalize = (s) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

function generateFallbackScript({ productName, description, cta, language, style, category }) {
  const t = TEMPLATES[language] || TEMPLATES.ru;
  const c = t[category] || t.other;
  const hooks = category === 'product' ? c.hooks[style] || c.hooks.dynamic : c.hooks;
  const [first, second] = splitDescription(description).map(capitalize);
  return {
    // Function replacer: a name containing "$&" or "$$" must be inserted literally.
    hook: capitalize(shorten(pick(hooks).replace('{name}', () => productName), 90)),
    benefit1: shorten(first || pick(t.benefits), 90),
    benefit2: shorten(second || pick(c.closers), 90),
    cta: shorten(cta || c.cta, 60),
  };
}

// ── Voice (no API key needed) ─────────────────────────────────────────────────
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(Number(data.format.duration) || 0)));
  });
}

// TTS_PROVIDER: auto = online voice when reachable, offline Windows voice otherwise;
// local = offline only; google = online only.
const TTS_MODES = ['auto', 'local', 'google'];
const requestedTtsMode = (process.env.TTS_PROVIDER || 'auto').trim().toLowerCase();
export const TTS_MODE = TTS_MODES.includes(requestedTtsMode) ? requestedTtsMode : 'auto';
if (requestedTtsMode !== TTS_MODE) console.warn(`[TTS] unknown TTS_PROVIDER "${process.env.TTS_PROVIDER}" — using "auto"`);

// Offline voices come from Windows (SAPI); on other systems only the online voice exists.
const OFFLINE_VOICE_ENABLED = process.platform === 'win32' && TTS_MODE !== 'google';
const ONLINE_VOICE_ENABLED = TTS_MODE !== 'local';
const ONLINE_TTS_TIMEOUT_MS = 8000;
// With an offline fallback one quick try is enough; without one, retry before giving up.
const ONLINE_TTS_ATTEMPTS = OFFLINE_VOICE_ENABLED ? 1 : 3;
// After the online voice fails, prefer the offline one for a while so videos don't wait on timeouts.
// Only meaningful when an offline voice exists — otherwise the online voice is the only option.
const ONLINE_TTS_PAUSE_MS = 5 * 60 * 1000;
let onlineTtsPausedUntil = 0;

console.log(
  `[TTS] mode: ${TTS_MODE} (online voice: ${ONLINE_VOICE_ENABLED ? 'on' : 'off'}, offline Windows voice: ${OFFLINE_VOICE_ENABLED ? 'on' : 'off'})`
);

// Offline Windows voices (SAPI). Preferred voice per language/gender; any installed voice of the
// same culture is accepted as a substitute, but never a voice of another language.
const SAPI = {
  ru: { culture: 'ru-RU', female: 'Microsoft Irina Desktop', male: null },
  uz: { culture: 'ru-RU', female: 'Microsoft Irina Desktop', male: null },
  en: { culture: 'en-US', female: 'Microsoft Zira Desktop', male: 'Microsoft David Desktop' },
};

/** Only English has a male voice (offline David); the online voice is female-only. */
export function maleVoiceAvailable(language) {
  return language === 'en' && OFFLINE_VOICE_ENABLED;
}

/** Languages that offer a male voice on this server (exposed to the UI via /api/health). */
export const MALE_VOICE_LANGUAGES = Object.keys(LANGUAGES).filter(maleVoiceAvailable);

// PowerShell single-quoted literal: forward slashes, and ' doubled (paths like C:\Users\O'Brien).
const psString = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "''")}'`;

/** Offline voice: one PowerShell run renders every phrase to its own WAV file. */
async function localSpeech(texts, language, voiceType, workDir) {
  const cfg = SAPI[language] || SAPI.ru;
  const male = voiceType === 'male' && Boolean(cfg.male);
  const preferred = male ? cfg.male : cfg.female;
  const textPath = path.join(workDir, 'voice-text.txt');
  fs.writeFileSync(textPath, texts.join('\n'), 'utf8');
  const outPaths = texts.map((_, i) => path.join(workDir, `voice_${i}.wav`));

  // A voice of the right language is mandatory: an English voice reading Cyrillic produces garbage.
  // The chosen voice's real gender is reported back, so the video records what was actually used.
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
$lines = [IO.File]::ReadAllLines(${psString(textPath)}, [Text.Encoding]::UTF8)
$outs = @(${outPaths.map(psString).join(', ')})
# A phrase written in Cyrillic (e.g. a Russian description in an English video) can only be read by a
# Russian voice; an English voice would produce silence.
$ruVoice = $voices | Where-Object { $_.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
for ($i = 0; $i -lt $outs.Length; $i++) {
  if ($ruVoice -and $voice.Culture.Name -ne 'ru-RU' -and $lines[$i] -match '[А-Яа-яЁё]') { $synth.SelectVoice($ruVoice.Name) } else { $synth.SelectVoice($voice.Name) }
  $synth.SetOutputToWaveFile($outs[$i])
  $synth.Speak($lines[$i])
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output ("{0}|{1}" -f $voice.Name, $voice.Gender)
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60000 });
  for (const p of outPaths) {
    if (!fs.existsSync(p) || fs.statSync(p).size < 1000) throw new Error('offline voice produced no audio');
  }
  const [voice = '', gender = ''] = stdout.trim().split('|');
  return { paths: outPaths, voice, gender: gender.trim().toLowerCase() === 'male' ? 'male' : 'female' };
}

async function googleSpeech(text, language, outPath) {
  // Google TTS has no Uzbek voice — Uzbek Latin text is read with the Russian voice. A Cyrillic phrase
  // in an English video is also read in Russian rather than spelled out by the English voice.
  const lang = language === 'en' && !CYRILLIC.test(text) ? 'en' : 'ru';
  let lastError;
  for (let attempt = 1; attempt <= ONLINE_TTS_ATTEMPTS; attempt++) {
    try {
      const parts = await googleTTS.getAllAudioBase64(text, { lang, slow: false, timeout: ONLINE_TTS_TIMEOUT_MS, splitPunct: ',.!?' });
      const buffer = Buffer.concat(parts.map((p) => Buffer.from(p.base64, 'base64')));
      if (buffer.length < 1000) throw new Error('empty response');
      fs.writeFileSync(outPath, buffer);
      return outPath;
    } catch (err) {
      lastError = err;
      if (attempt < ONLINE_TTS_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

/** Online voice: one request per phrase. */
async function onlineSpeech(texts, language, workDir) {
  const paths = [];
  for (let i = 0; i < texts.length; i++) paths.push(await googleSpeech(texts[i], language, path.join(workDir, `voice_${i}.mp3`)));
  return paths;
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
 * Produces the voiceover, synchronised with the subtitles. Tries the preferred source first and the
 * other as a fallback; only when both fail does the video get a silent track.
 * `gender` is the voice actually used.
 */
export async function generateSpeech(script, language, voiceType, workDir) {
  const texts = SEGMENTS.map((seg) => script[seg.key].replace(/[.!?…]+$/, ''));
  const uzNote = language === 'uz' ? '-ru-voice' : '';

  const online = async () => {
    const clips = await onlineSpeech(texts, language, workDir);
    return { path: await alignToSegments(clips, workDir), duration: DURATION, aligned: true, kind: `tts-online${uzNote}`, gender: 'female' };
  };
  const offline = async () => {
    const result = await localSpeech(texts, language, voiceType, workDir);
    console.log(`[TTS] offline voice: ${result.voice}`);
    return { path: await alignToSegments(result.paths, workDir), duration: DURATION, aligned: true, kind: `tts-offline${uzNote}`, gender: result.gender };
  };

  // Offline first when: the online voice recently failed, or a male voice is wanted (online is
  // female-only). The online voice stays as the fallback in both cases.
  const preferOffline = (voiceType === 'male' && maleVoiceAvailable(language)) || Date.now() < onlineTtsPausedUntil;
  const sources = [];
  if (ONLINE_VOICE_ENABLED) sources.push(['online', online]);
  if (OFFLINE_VOICE_ENABLED) sources[preferOffline ? 'unshift' : 'push'](['offline', offline]);

  for (const [name, produce] of sources) {
    try {
      return await produce();
    } catch (err) {
      if (name === 'online' && OFFLINE_VOICE_ENABLED) onlineTtsPausedUntil = Date.now() + ONLINE_TTS_PAUSE_MS;
      console.warn(`[TTS] ${name} voice failed: ${err.message}`);
    }
  }
  console.error('[TTS] no voice available — using a silent audio track');
  return { path: null, duration: 0, aligned: false, kind: 'silence', gender: null };
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
