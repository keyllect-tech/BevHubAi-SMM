import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { openDatabase, newId, nowIso, currentMonthStart, transaction } from './server/db.js';
import { createAuth } from './server/auth.js';
import { createGenerationQueue, INTERRUPTED_MESSAGE } from './server/generation.js';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  FONT_FILE,
  LANGUAGES,
  STYLES,
  cleanText,
  detectImageType,
  validateImageDecodes,
  generateAIScript,
  isOpenAIActive,
  maleVoiceAvailable,
} from './server/media.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const DB_FILE = process.env.DATABASE_FILE || path.join(ROOT, 'data', 'bevhub.db');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PLANS = { starter: 15, pro: 50, agency: 200 };
const VOICE_TYPES = ['female', 'male'];
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${PORT}`)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

for (const dir of [IMAGES_DIR, VIDEOS_DIR]) fs.mkdirSync(dir, { recursive: true });
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const db = openDatabase(DB_FILE);
const auth = createAuth(db);
const queue = createGenerationQueue({ db, imagesDir: IMAGES_DIR, videosDir: VIDEOS_DIR, tmpDir: TMP_DIR });
queue.recoverOnStartup();

// ── Helpers ───────────────────────────────────────────────────────────────────
const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const fileUrl = (id) => `/api/files/${id}`;

const VIDEO_SELECT = `SELECT v.*, (SELECT a.file_id FROM video_assets a WHERE a.video_id = v.id ORDER BY a.sort_order LIMIT 1) AS thumb_file_id FROM videos v`;

function serializeVideo(v) {
  return {
    id: v.id,
    workspace_id: v.workspace_id,
    project_id: v.project_id,
    title: v.title,
    product_name: v.product_name,
    product_description: v.product_description,
    price: v.price,
    cta: v.cta,
    website_url: v.website_url,
    language: v.language,
    voice_type: v.voice_type,
    style: v.style,
    script_hook: v.script_hook,
    script_body: v.script_body,
    script_cta: v.script_cta,
    script_source: v.script_source,
    audio_kind: v.audio_kind,
    status: v.status,
    video_url: v.status === 'completed' && v.video_file ? `/api/videos/${v.id}/file` : '',
    thumbnail_url: v.thumb_file_id ? fileUrl(v.thumb_file_id) : '',
    duration_sec: v.duration_sec,
    error_message: v.error_message,
    created_at: v.created_at,
  };
}

function getOwnedVideo(req, id) {
  if (!UUID_RE.test(id)) return null;
  return db.prepare(`${VIDEO_SELECT} WHERE v.id = ? AND v.workspace_id = ?`).get(id, req.workspace.id) || null;
}

function getOwnedProject(req, id) {
  if (!UUID_RE.test(id || '')) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(id, req.workspace.id) || null;
}

function getUsage(workspaceId) {
  const subscription = db.prepare('SELECT plan, monthly_limit, status, created_at FROM subscriptions WHERE workspace_id = ?').get(workspaceId);
  const month = currentMonthStart();
  const row = db.prepare('SELECT videos_created FROM usage WHERE workspace_id = ? AND month_start = ?').get(workspaceId, month);
  return { subscription: subscription || null, usage: { month_start: month, videos_created: row?.videos_created || 0 } };
}

function parseScriptFields(body) {
  const productName = cleanText(body?.productName, 100);
  const description = cleanText(body?.description, 600);
  const cta = cleanText(body?.cta, 60);
  if (!productName) return { error: 'Укажите название товара' };
  if (!description) return { error: 'Добавьте описание товара' };
  if (!cta) return { error: 'Укажите призыв к действию (CTA)' };
  if (!LANGUAGES[body.language]) return { error: 'Неподдерживаемый язык' };
  if (!STYLES.includes(body.style)) return { error: 'Неподдерживаемый стиль видео' };
  return { value: { productName, description, cta, language: body.language, style: body.style } };
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/api', cors({ origin: ALLOWED_ORIGINS, credentials: true }));
// Session cookies are SameSite=Lax; additionally reject state-changing requests from foreign origins.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: 'Запрос с недопустимого источника' });
  next();
});
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    database: true,
    ffmpeg: fs.existsSync(FFMPEG_BIN),
    ffprobe: fs.existsSync(FFPROBE_BIN),
    subtitleFont: Boolean(FONT_FILE),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.use('/api/auth', auth.router);

const api = express.Router();
api.use(auth.requireAuth);

// ── Workspace / dashboard / billing ───────────────────────────────────────────
api.patch('/workspace', (req, res) => {
  const name = cleanText(req.body?.name, 80);
  if (!name) throw httpError(400, 'Название не может быть пустым');
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, req.workspace.id);
  res.json({ workspace: { ...req.workspace, name } });
});

api.get('/dashboard', (req, res) => {
  const w = req.workspace.id;
  const videos = db.prepare(`${VIDEO_SELECT} WHERE v.workspace_id = ? ORDER BY v.created_at DESC LIMIT 6`).all(w).map(serializeVideo);
  const totalVideos = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE workspace_id = ?').get(w).n;
  const projectsCount = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?').get(w).n;
  res.json({ videos, totalVideos, projectsCount, ...getUsage(w) });
});

api.get('/billing', (req, res) => res.json(getUsage(req.workspace.id)));

api.post('/billing/plan', (req, res) => {
  const plan = req.body?.plan;
  if (!PLANS[plan]) throw httpError(400, 'Неизвестный тариф');
  db.prepare('UPDATE subscriptions SET plan = ?, monthly_limit = ? WHERE workspace_id = ?').run(plan, PLANS[plan], req.workspace.id);
  res.json(getUsage(req.workspace.id));
});

// ── Projects & brand kits ─────────────────────────────────────────────────────
api.get('/projects', (req, res) => {
  res.json({ projects: db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspace.id) });
});

api.post('/projects', (req, res) => {
  const name = cleanText(req.body?.name, 80);
  const description = cleanText(req.body?.description, 500);
  if (!name) throw httpError(400, 'Укажите название проекта');
  const id = newId();
  const ts = nowIso();
  transaction(db, () => {
    db.prepare('INSERT INTO projects (id, workspace_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.workspace.id, name, description, ts);
    db.prepare('INSERT INTO brand_kits (id, project_id, brand_name, created_at) VALUES (?, ?, ?, ?)').run(newId(), id, name, ts);
  });
  res.status(201).json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) });
});

api.patch('/projects/:id', (req, res) => {
  const project = getOwnedProject(req, req.params.id);
  if (!project) throw httpError(404, 'Проект не найден');
  const name = cleanText(req.body?.name, 80);
  if (!name) throw httpError(400, 'Укажите название проекта');
  db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(name, cleanText(req.body?.description, 500), project.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) });
});

api.delete('/projects/:id', (req, res) => {
  const project = getOwnedProject(req, req.params.id);
  if (!project) throw httpError(404, 'Проект не найден');
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  res.json({ ok: true });
});

api.get('/projects/:id/brand-kit', (req, res) => {
  const project = getOwnedProject(req, req.params.id);
  if (!project) throw httpError(404, 'Проект не найден');
  res.json({ brandKit: db.prepare('SELECT * FROM brand_kits WHERE project_id = ?').get(project.id) || null });
});

api.put('/projects/:id/brand-kit', (req, res) => {
  const project = getOwnedProject(req, req.params.id);
  if (!project) throw httpError(404, 'Проект не найден');
  const b = req.body || {};
  const primary = COLOR_RE.test(b.primary_color) ? b.primary_color : null;
  const secondary = COLOR_RE.test(b.secondary_color) ? b.secondary_color : null;
  if (!primary || !secondary) throw httpError(400, 'Цвет должен быть в формате #RRGGBB');
  if (!LANGUAGES[b.default_language]) throw httpError(400, 'Неподдерживаемый язык');
  let logoUrl = '';
  if (b.logo_url) {
    const fileId = String(b.logo_url).replace('/api/files/', '');
    if (!UUID_RE.test(fileId) || !db.prepare('SELECT 1 FROM files WHERE id = ? AND workspace_id = ?').get(fileId, req.workspace.id)) {
      throw httpError(400, 'Логотип не найден. Загрузите его заново.');
    }
    logoUrl = fileUrl(fileId);
  }
  const values = [cleanText(b.brand_name, 80), logoUrl, primary, secondary, b.default_language, cleanText(b.default_cta, 60)];
  const existing = db.prepare('SELECT id FROM brand_kits WHERE project_id = ?').get(project.id);
  if (existing) {
    db.prepare('UPDATE brand_kits SET brand_name = ?, logo_url = ?, primary_color = ?, secondary_color = ?, default_language = ?, default_cta = ? WHERE id = ?').run(...values, existing.id);
  } else {
    db.prepare('INSERT INTO brand_kits (brand_name, logo_url, primary_color, secondary_color, default_language, default_cta, id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      ...values,
      newId(),
      project.id,
      nowIso()
    );
  }
  res.json({ brandKit: db.prepare('SELECT * FROM brand_kits WHERE project_id = ?').get(project.id) });
});

// ── Files (private per workspace) ─────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    // Never trust the client filename: random name + extension derived from the MIME type.
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${IMAGE_TYPES[file.mimetype]}`),
  }),
  // Without this multer decodes filenames as latin1, mangling Cyrillic/emoji names in the UI.
  defParamCharset: 'utf8',
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    cb(httpError(400, 'Неподдерживаемый формат. Разрешены JPG, PNG, WEBP'));
  },
});

// Any failure while parsing the upload is a bad request, not a server error (busboy throws
// plain Errors, e.g. "Unexpected end of form", which are not MulterError instances).
const uploadImage = (req, res, next) =>
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(httpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 10MB)' : 'Некорректная загрузка файла'));
    }
    if (err.status === 400) return next(err);
    console.warn('[UPLOAD] parse error:', err.message);
    next(httpError(400, 'Некорректная загрузка файла'));
  });

api.post('/files', uploadImage, async (req, res) => {
  const file = req.file;
  if (!file) throw httpError(400, 'Выберите изображение');
  try {
    const detected = detectImageType(file.path);
    if (!detected) throw httpError(400, 'Файл не является изображением JPG, PNG или WEBP');
    if (detected !== file.mimetype) throw httpError(400, 'Содержимое файла не совпадает с его типом');
    try {
      await validateImageDecodes(file.path, detected);
    } catch (err) {
      if (err.internal) throw err;
      throw httpError(400, err.message);
    }
    const id = newId();
    const originalName = cleanText(file.originalname, 120).replace(/[\\/]/g, '_');
    db.prepare('INSERT INTO files (id, workspace_id, filename, mime_type, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      req.workspace.id,
      path.basename(file.path),
      detected,
      file.size,
      originalName,
      nowIso()
    );
    res.status(201).json({ file: { id, url: fileUrl(id), name: originalName, mime_type: detected, size: file.size } });
  } catch (err) {
    fs.rmSync(file.path, { force: true });
    throw err;
  }
});

api.get('/files/:id', (req, res) => {
  const row = UUID_RE.test(req.params.id)
    ? db.prepare('SELECT filename, mime_type FROM files WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id)
    : null;
  const abs = row && path.join(IMAGES_DIR, row.filename);
  if (!row || !fs.existsSync(abs)) throw httpError(404, 'Файл не найден');
  res.sendFile(abs, { headers: { 'Content-Type': row.mime_type, 'Cache-Control': 'private, max-age=3600' } });
});

// ── Scripts & videos ──────────────────────────────────────────────────────────
// Each script preview can hit the (operator-billed) OpenAI API, so cap it per workspace.
const SCRIPTS_PER_HOUR = Number(process.env.SCRIPTS_PER_HOUR) || 30;
const scriptCalls = new Map();

function takeScriptQuota(workspaceId) {
  const now = Date.now();
  const recent = (scriptCalls.get(workspaceId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= SCRIPTS_PER_HOUR) return false;
  recent.push(now);
  scriptCalls.set(workspaceId, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, times] of scriptCalls) {
    const recent = times.filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length) scriptCalls.set(id, recent);
    else scriptCalls.delete(id);
  }
}, 30 * 60 * 1000).unref();

api.post('/scripts', async (req, res) => {
  const parsed = parseScriptFields(req.body);
  if (parsed.error) throw httpError(400, parsed.error);
  // The quota protects the OpenAI bill; the free local generator is not limited.
  if (isOpenAIActive() && !takeScriptQuota(req.workspace.id)) {
    throw httpError(429, 'Слишком много запросов сценария. Попробуйте через несколько минут.');
  }
  res.json(await generateAIScript(parsed.value));
});

api.get('/videos', (req, res) => {
  res.json({ videos: db.prepare(`${VIDEO_SELECT} WHERE v.workspace_id = ? ORDER BY v.created_at DESC`).all(req.workspace.id).map(serializeVideo) });
});

api.post('/videos', (req, res) => {
  const body = req.body || {};
  const w = req.workspace.id;

  if (!UUID_RE.test(body.clientRequestId || '')) throw httpError(400, 'Некорректный запрос (clientRequestId)');
  // Idempotency: the same submit (double click, network retry) returns the already created video.
  const existing = db.prepare('SELECT id FROM videos WHERE workspace_id = ? AND client_request_id = ?').get(w, body.clientRequestId);
  if (existing) return res.status(200).json({ video: serializeVideo(getOwnedVideo(req, existing.id)), deduplicated: true });

  const parsed = parseScriptFields(body);
  if (parsed.error) throw httpError(400, parsed.error);
  const { productName, description, cta, language, style } = parsed.value;

  const fileIds = Array.isArray(body.fileIds) ? [...new Set(body.fileIds)] : [];
  if (fileIds.length === 0) throw httpError(400, 'Загрузите фото товара');
  if (fileIds.length > 10) throw httpError(400, 'Не больше 10 фото');
  for (const id of fileIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id) || !db.prepare('SELECT 1 FROM files WHERE id = ? AND workspace_id = ?').get(id, w)) {
      throw httpError(400, 'Фото не найдено. Загрузите его заново.');
    }
  }

  let projectId = null;
  if (body.projectId) {
    if (!getOwnedProject(req, body.projectId)) throw httpError(400, 'Проект не найден');
    projectId = body.projectId;
  }
  // Only English has a male voice; store what will actually be rendered so the UI never shows a
  // voice the video does not have.
  const voiceType = body.voiceType === 'male' && VOICE_TYPES.includes(body.voiceType) && maleVoiceAvailable(language) ? 'male' : 'female';
  const websiteUrl = cleanText(body.websiteUrl, 300);
  if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) throw httpError(400, 'Website URL должен начинаться с http:// или https://');

  const s = body.script || {};
  const script =
    s.hook && s.benefit1 && s.benefit2 && s.cta
      ? { hook: cleanText(s.hook, 100), benefit1: cleanText(s.benefit1, 120), benefit2: cleanText(s.benefit2, 120), cta: cleanText(s.cta, 80) }
      : null;
  const scriptSource = script && ['openai', 'fallback'].includes(body.scriptSource) ? body.scriptSource : script ? 'client' : '';

  const { subscription, usage } = getUsage(w);
  if (usage.videos_created >= (subscription?.monthly_limit || 15)) {
    throw httpError(403, 'Лимит генераций на этот месяц исчерпан. Смените тариф в разделе Billing.');
  }

  const videoId = newId();
  const ts = nowIso();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO videos (id, workspace_id, project_id, client_request_id, title, product_name, product_description, price, cta, website_url,
        language, voice_type, style, script_hook, script_body, script_cta, script_source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`
    ).run(
      videoId, w, projectId, body.clientRequestId, productName, productName, description, cleanText(body.price, 50), cta, websiteUrl,
      language, voiceType, style, script?.hook || '', script ? `${script.benefit1}\n${script.benefit2}` : '', script?.cta || '', scriptSource, ts, ts
    );
    fileIds.forEach((fileId, i) => {
      db.prepare('INSERT INTO video_assets (id, video_id, file_id, asset_type, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), videoId, fileId, 'image', i, ts);
    });
    db.prepare("INSERT INTO generation_jobs (id, video_id, status, progress, current_step, started_at, created_at) VALUES (?, ?, 'processing', 0, 'Queued', ?, ?)").run(newId(), videoId, ts, ts);
    db.prepare('INSERT INTO usage (workspace_id, month_start, videos_created) VALUES (?, ?, 1) ON CONFLICT (workspace_id, month_start) DO UPDATE SET videos_created = videos_created + 1').run(w, usage.month_start);
  });

  queue.enqueue(videoId);
  res.status(201).json({ video: serializeVideo(getOwnedVideo(req, videoId)) });
});

api.get('/videos/:id', (req, res) => {
  let video = getOwnedVideo(req, req.params.id);
  if (!video) throw httpError(404, 'Видео не найдено');

  // A "processing" row with nothing rendering it can never finish — surface it as failed.
  if (video.status === 'processing' && !queue.isActive(video.id)) {
    const ts = nowIso();
    db.prepare("UPDATE videos SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(INTERRUPTED_MESSAGE, ts, video.id);
    db.prepare("UPDATE generation_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE video_id = ? AND status = 'processing'").run(INTERRUPTED_MESSAGE, ts, video.id);
    video = getOwnedVideo(req, video.id);
  }

  const assets = db
    .prepare('SELECT id, video_id, file_id, asset_type, sort_order, created_at FROM video_assets WHERE video_id = ? ORDER BY sort_order')
    .all(video.id)
    .map((a) => ({ ...a, file_url: fileUrl(a.file_id) }));
  const job = db
    .prepare('SELECT status, progress, current_step, error_message, started_at, completed_at FROM generation_jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(video.id);
  res.json({ video: serializeVideo(video), assets, job: job || null });
});

api.post('/videos/:id/retry', (req, res) => {
  const video = getOwnedVideo(req, req.params.id);
  if (!video) throw httpError(404, 'Видео не найдено');
  if (video.status === 'processing' && queue.isActive(video.id)) throw httpError(409, 'Видео уже генерируется');

  // Re-rendering a finished video is a new generation and counts against the plan;
  // retrying a failed one is free.
  const isRegenerate = video.status === 'completed';
  const { subscription, usage } = getUsage(req.workspace.id);
  if (isRegenerate && usage.videos_created >= (subscription?.monthly_limit || 15)) {
    throw httpError(403, 'Лимит генераций на этот месяц исчерпан. Смените тариф в разделе Billing.');
  }

  const ts = nowIso();
  transaction(db, () => {
    db.prepare("UPDATE videos SET status = 'processing', error_message = '', updated_at = ? WHERE id = ?").run(ts, video.id);
    db.prepare("INSERT INTO generation_jobs (id, video_id, status, progress, current_step, started_at, created_at) VALUES (?, ?, 'processing', 0, 'Queued', ?, ?)").run(newId(), video.id, ts, ts);
    if (isRegenerate) {
      db.prepare('INSERT INTO usage (workspace_id, month_start, videos_created) VALUES (?, ?, 1) ON CONFLICT (workspace_id, month_start) DO UPDATE SET videos_created = videos_created + 1').run(req.workspace.id, usage.month_start);
    }
  });
  queue.enqueue(video.id);
  res.json({ video: serializeVideo(getOwnedVideo(req, video.id)) });
});

api.get('/videos/:id/file', (req, res) => {
  const video = getOwnedVideo(req, req.params.id);
  const abs = video?.video_file && path.join(VIDEOS_DIR, video.video_file);
  if (!video || video.status !== 'completed' || !abs || !fs.existsSync(abs)) throw httpError(404, 'Видео не найдено');
  if (req.query.download === '1') {
    res.attachment(`${video.title.replace(/[\\/:*?"<>| -]+/g, '_').slice(0, 80) || 'bevhub-video'}.mp4`);
  }
  res.sendFile(abs, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store' } });
});

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 10MB)' : 'Некорректная загрузка файла' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
  if (err.expose && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('[SERVER] unhandled error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' });
});

// Images uploaded in a wizard the user never finished would otherwise stay on disk forever.
const ORPHAN_TTL_HOURS = Number(process.env.ORPHAN_FILE_TTL_HOURS) || 24;
function cleanupOrphanFiles() {
  const cutoff = new Date(Date.now() - ORPHAN_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const orphans = db
    .prepare(
      `SELECT id, filename FROM files
       WHERE created_at < ?
         AND id NOT IN (SELECT file_id FROM video_assets)
         AND ('/api/files/' || id) NOT IN (SELECT logo_url FROM brand_kits)`
    )
    .all(cutoff);
  for (const f of orphans) {
    fs.rmSync(path.join(IMAGES_DIR, f.filename), { force: true });
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  }

  // Files the database knows nothing about (leftovers of older runs) also age out.
  const untracked = (dir, known) => {
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (!stat.isFile() || known.has(name) || stat.mtimeMs > Date.now() - ORPHAN_TTL_HOURS * 60 * 60 * 1000) continue;
      fs.rmSync(full, { force: true });
      removed++;
    }
    return removed;
  };
  const knownImages = new Set(db.prepare('SELECT filename FROM files').all().map((r) => r.filename));
  const knownVideos = new Set(db.prepare("SELECT video_file FROM videos WHERE video_file <> ''").all().map((r) => r.video_file));
  const strays = untracked(IMAGES_DIR, knownImages) + untracked(VIDEOS_DIR, knownVideos);

  if (orphans.length || strays) console.log(`[CLEANUP] removed ${orphans.length} unused upload(s), ${strays} untracked file(s)`);
}
cleanupOrphanFiles();
setInterval(cleanupOrphanFiles, 60 * 60 * 1000).unref();

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[DB] ${DB_FILE}`);
  console.log(`[FFMPEG] ${FFMPEG_BIN}`);
  console.log(`[FONT] ${FONT_FILE || 'NOT FOUND — Cyrillic subtitles will not render. Set SUBTITLE_FONT.'}`);
  console.log(`[AI SCRIPT] OpenAI ${process.env.OPENAI_API_KEY ? 'configured' : 'not configured — fallback templates'}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${PORT} is already in use — another backend instance is running. Stop it or set PORT.`);
  } else {
    console.error('[SERVER] error:', err);
  }
  process.exit(1);
});
