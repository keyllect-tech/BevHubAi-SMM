import { isolationConfig } from './server/isolation-bootstrap.js';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { openDatabase, newId, nowIso, transaction, backupDatabase } from './server/db.js';
import { createAuth } from './server/auth.js';
import { createGenerationQueue, INTERRUPTED_MESSAGE } from './server/generation.js';
import { createImageGenerator, ImageGenerationError } from './server/ai/image-generation.js';
import { createVideoApiRouter, serializeVideo, VIDEO_SELECT, workspaceUsage } from './server/video-api.js';
import { readCleanupPolicy, describePolicy } from './server/cleanup-policy.js';
import { prepareTmpDir } from './server/tmp-dir.js';
import { createFileInventory } from './server/file-inventory.js';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  FONT_FILE,
  LANGUAGES,
  STYLES,
  cleanText,
  detectImageType,
  validateImageDecodes,
  generateScript,
  providerStatus,
  isAiActive,
  warmUpProviders,
  checkBinary,
  maleVoiceAvailable,
  MALE_VOICE_LANGUAGES,
  TTS_MODE,
  CATEGORIES,
  detectLanguage,
  detectCategory,
  pickStyle,
  defaultCta,
  normalizeUzbekText,
} from './server/media.js';
import { ttsStatus } from './server/tts/index.js';
import { createRateLimiter } from './server/rate-limit.js';

const ROOT = isolationConfig.projectRoot;
const PORT = Number(process.env.PORT) || 3001;
const { databaseFile: DB_FILE, uploadsDir: UPLOADS_DIR, imagesDir: IMAGES_DIR, videosDir: VIDEOS_DIR, tmpDir: TMP_DIR } = isolationConfig.paths;

// One decision point for every automatic deletion. Every category is OFF unless it is explicitly
// enabled twice (per-category mode + the global switch), so a fresh checkout or a typo deletes nothing.
const cleanupPolicy = readCleanupPolicy(process.env);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PLANS = { starter: 15, pro: 50, agency: 200 };
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${PORT}`)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

for (const dir of [IMAGES_DIR, VIDEOS_DIR]) {
  isolationConfig.assertPath(dir);
  fs.mkdirSync(dir, { recursive: true });
}

// `uploads/tmp` holds scratch trees a running render may be writing into right now. Nothing inside is
// removed: the category is locked in the policy, and `prepareTmpDir` reports, warns and creates.
isolationConfig.assertPath(TMP_DIR);
prepareTmpDir({ tmpDir: TMP_DIR, policy: cleanupPolicy });

isolationConfig.assertPath(DB_FILE);
const db = openDatabase(DB_FILE);
const auth = createAuth(db);
const imageGenerator = createImageGenerator({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_IMAGE_MODEL,
});
// Inventory covers every file below `uploads`, not just the two directories the database references:
// `uploads/audio` and files dropped straight into `uploads` had no owner before. They are reported for
// manual review, never deleted — no table references them, so nothing can vouch for them.
// `trustedRoot` is the physical boundary: uploads must resolve inside the project root, so a link that
// redirects the tree (or a scope that resolves outside it) blocks the run instead of being walked.
const inventory = createFileInventory({
  db,
  imagesDir: IMAGES_DIR,
  videosDir: VIDEOS_DIR,
  uploadsDir: UPLOADS_DIR,
  audioDir: isolationConfig.paths.audioDir,
  trustedRoot: ROOT,
  ttlHours: Number(process.env.ORPHAN_FILE_TTL_HOURS) || 24,
});
const queue = createGenerationQueue({ db, imagesDir: IMAGES_DIR, videosDir: VIDEOS_DIR, tmpDir: TMP_DIR, cleanupPolicy });

// Recovery is diagnosis only: it reports jobs interrupted by the restart and videos whose file is not
// on disk, and changes no video row. Clearing `video_file` is a separate, explicitly confirmed step.
const recovery = queue.recoverOnStartup();
if (recovery.storageError) {
  console.warn(`[VIDEO] recovery: storage unreadable (${recovery.storageError.code}) — no video row was touched`);
} else if (recovery.missing.length) {
  console.warn(`[VIDEO] recovery: ${recovery.missing.length} video(s) report a missing file — rows left untouched (enable CLEANUP_MISSING_LINKS_MODE=apply to clear them)`);
}
if (cleanupPolicy.missingLinks.apply && !recovery.storageError) {
  queue.markMissingVideos(recovery);
}

// Persistent counters (see server/rate-limit.js): they live in SQLite, so a restart does not hand out
// a fresh quota.
const rate = createRateLimiter(db);

// ── Helpers ───────────────────────────────────────────────────────────────────
const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const fileUrl = (id) => `/api/files/${id}`;

function getOwnedProject(req, id) {
  if (!UUID_RE.test(id || '')) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(id, req.workspace.id) || null;
}

function getUsage(workspaceId) {
  return workspaceUsage(db, workspaceId);
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// ── Security headers ────────────────────────────────────────────────────────────────────────────
// CSP ships in report-only mode: nothing is blocked, violations are logged by the browser (and by
// `reportOnly` tooling). Set CSP_REPORT_ONLY=false only after the report comes back clean.
const CSP_REPORT_ONLY = process.env.CSP_REPORT_ONLY !== 'false';
const API_ORIGIN = (process.env.VITE_API_URL || '').replace(/\/+$/, '');

// Everything the app loads is same-origin: one JS bundle, one CSS file, images and MP4 from /api.
// `style-src 'unsafe-inline'` is required because React writes inline style attributes; it is the
// only relaxation here. `connect-src` also allows the API origin when the frontend is served from a
// different domain (the COOKIE_SAMESITE=none deployment).
const CSP = [
  "default-src 'self'",
  `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  const secure = req.secure;
  res.setHeader(
    CSP_REPORT_ONLY ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
    secure ? `${CSP}; upgrade-insecure-requests` : CSP
  );
  // HSTS only over HTTPS: sending it on plain HTTP would be ignored at best and would pin a
  // not-yet-ready domain to HTTPS at worst. No includeSubDomains/preload until every subdomain is ready.
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use('/api', cors({ origin: ALLOWED_ORIGINS, credentials: true }));
// Session cookies are SameSite=Lax; additionally reject state-changing requests from foreign origins.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: 'Запрос с недопустимого источника' });
  // Sec-Fetch-Site is set by the browser and cannot be scripted by a page, so it catches form posts
  // from another site even when the browser omits Origin. Missing (curl, server-to-server) is allowed.
  if (req.headers['sec-fetch-site'] === 'cross-site' && !origin) {
    return res.status(403).json({ error: 'Запрос с недопустимого источника' });
  }
  next();
});
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', async (_req, res) => {
  const ffmpegVersion = checkBinary(FFMPEG_BIN, 'ffmpeg');
  const ffprobeVersion = checkBinary(FFPROBE_BIN, 'ffprobe');
  const [ai, tts] = await Promise.all([
    providerStatus().catch((err) => {
      console.warn('[HEALTH] AI status failed:', err.message);
      return [];
    }),
    ttsStatus().catch((err) => {
      console.warn('[HEALTH] TTS status failed:', err.message);
      return [];
    }),
  ]);
  res.json({
    ok: Boolean(ffmpegVersion && ffprobeVersion),
    database: true,
    ffmpeg: Boolean(ffmpegVersion),
    ffprobe: Boolean(ffprobeVersion),
    ffmpegVersion,
    ffprobeVersion,
    subtitleFont: Boolean(FONT_FILE),
    ttsMode: TTS_MODE,
    maleVoiceLanguages: MALE_VOICE_LANGUAGES,
    aiProviders: ai,
    // Only claim AI is active when a provider is configured AND not paused after a failure:
    // a key that returns 429 is configured but cannot write anything.
    aiActive: ai.some((p) => p.configured && p.available),
    ttsProviders: tts,
  });
});

app.use('/api/auth', auth.router);

const api = express.Router();
api.use(auth.requireAuth);
api.use(createVideoApiRouter({
  db,
  queue,
  rate,
  imagesDir: IMAGES_DIR,
  videosDir: VIDEOS_DIR,
  cleanText,
  detectImageType,
  validateImageDecodes,
  generateScript,
  isAiActive,
  maleVoiceAvailable,
  LANGUAGES,
  STYLES,
  CATEGORIES,
  normalizeUzbekText,
  detectLanguage,
  detectCategory,
  pickStyle,
  defaultCta,
  interruptedMessage: INTERRUPTED_MESSAGE,
  scriptsPerHour: Number(process.env.SCRIPTS_PER_HOUR) || 30,
}));

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

setInterval(() => rate.sweep(), 60 * 60 * 1000).unref();

const IMAGE_GENERATIONS_PER_HOUR = 5;
const IMAGE_GENERATION_WINDOW_MS = 60 * 60 * 1000;

api.post('/images/generate', async (req, res) => {
  const productName = cleanText(req.body?.productName, 100);
  const description = cleanText(req.body?.description, 600);
  if (!productName || !description) throw httpError(400, 'Укажите название товара и описание');

  const style = STYLES.includes(req.body?.style) ? req.body.style : 'product';
  const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'product';
  if (!imageGenerator.isConfigured()) {
    console.warn('[IMAGE] generation failed (upstream_status=none, http_status=503, code=not_configured)');
    return res.status(503).json({ error: 'Генерация изображений не настроена' });
  }

  const quota = rate.hit({
    bucket: 'image-generation',
    key: req.workspace.id,
    limit: IMAGE_GENERATIONS_PER_HOUR,
    windowMs: IMAGE_GENERATION_WINDOW_MS,
  });
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(quota.retryAfterMs / 1000)));
    throw httpError(429, 'Слишком много запросов генерации изображений. Попробуйте позже.');
  }

  try {
    const image = await imageGenerator.generate({ productName, description, style, category });
    res.type('png').set('Cache-Control', 'no-store').send(image);
  } catch (err) {
    if (!(err instanceof ImageGenerationError)) throw err;
    console.warn(`[IMAGE] generation failed (upstream_status=${err.upstreamStatus ?? 'none'}, http_status=${err.status}, code=${err.code})`);
    res.status(err.status).json({ error: err.message });
  }
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
// Deletion is policy-gated and, in dry-run, produces a candidate list without touching anything.
// `off` (the default) only logs the counts.
const ORPHAN_TTL_HOURS = Number(process.env.ORPHAN_FILE_TTL_HOURS) || 24;

/** Logs one cleanup pass. A journal of these runs is stage B; nothing here writes to disk. */
function logCleanup(entry) {
  console.log(`[CLEANUP] ${entry.mode}: ${entry.summary}`);
  if (entry.blocked.length) console.warn(`[CLEANUP] blocked: ${entry.blocked.join(', ')}`);
}

function cleanupOrphanFiles() {
  const mode = cleanupPolicy.orphan.mode;
  if (mode === 'off') return null;

  const result = inventory.scan();
  const entry = {
    mode,
    summary:
      `${result.counts.scanned} scanned, ${result.counts.deletable} candidate(s), ` +
      `${result.counts.tooNew} too new, ${result.counts.referenced} referenced, ` +
      `${result.counts.missingOnDisk} missing on disk, ${result.counts.errors} error(s)`,
    blocked: result.blocked,
    candidates: result.candidates.map((f) => ({ rel: f.rel, size: f.size, mtime: f.mtime, reason: f.reason })),
  };

  if (mode === 'dry-run') {
    logCleanup(entry);
    return entry;
  }

  if (result.blocked.length) {
    entry.outcome = 'blocked';
    logCleanup(entry);
    return entry;
  }

  const outcome = inventory.apply(result);
  entry.outcome = `removed ${outcome.removed.length}, failed ${outcome.failed.length}, skipped ${outcome.skipped.length}`;
  logCleanup(entry);
  return entry;
}

if (cleanupPolicy.orphan.mode !== 'off') cleanupOrphanFiles();
else console.log('[CLEANUP] automatic file deletion is disabled (set CLEANUP_ENABLED=true and CLEANUP_ORPHAN_MODE=apply to enable)');
// The timer is only installed when cleanup can actually do something: an hourly "we did nothing" log
// would be noise, and a disabled feature must not keep a handle in the event loop.
if (cleanupPolicy.orphan.mode !== 'off') setInterval(cleanupOrphanFiles, 60 * 60 * 1000).unref();

// Nightly snapshot of the database: a bad migration or a disk failure must not cost the user their videos.
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const runBackup = () => {
  try {
    const { target, removed, rotated } = backupDatabase(db, DB_FILE, {
      keep: Number(process.env.BACKUP_KEEP) || 10,
      rotate: cleanupPolicy.backups.apply,
      directory: isolationConfig.paths.backupDir,
    });
    console.log(`[BACKUP] wrote ${path.basename(target)}${removed.length ? `, removed ${removed.length} old` : ''}${rotated ? '' : ' (rotation off)'}`);
  } catch (err) {
    console.error(`[BACKUP] failed: ${err.message}`);
  }
};
runBackup();
setInterval(runBackup, BACKUP_EVERY_MS).unref();

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[DB] ${DB_FILE}`);
  console.log(`[FFMPEG] ${FFMPEG_BIN}`);
  console.log(`[FONT] ${FONT_FILE || 'NOT FOUND — Cyrillic subtitles will not render. Set SUBTITLE_FONT.'}`);
  providerStatus()
    .then((rows) => {
      console.log(`[AI SCRIPT] providers: ${rows.map((p) => `${p.id}=${p.configured ? (p.available ? 'ready' : 'configured') : 'off'}`).join(', ')}`);
    })
    .catch((err) => console.warn('[AI SCRIPT] status failed:', err.message));
  warmUpProviders();
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${PORT} is already in use — another backend instance is running. Stop it or set PORT.`);
  } else {
    console.error('[SERVER] error:', err);
  }
  process.exit(1);
});
