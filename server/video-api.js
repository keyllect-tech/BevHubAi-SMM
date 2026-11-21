import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'node:stream';
import { currentMonthStart, newId, nowIso, transaction } from './db.js';
import { removeOwnFile } from './safe-remove.js';
import { AiError, toClientAiError } from './ai/errors.js';
import { validateGeneratedScript } from './ai/validate.js';

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VIDEO_SELECT = `SELECT v.*, (SELECT a.file_id FROM video_assets a WHERE a.video_id = v.id ORDER BY a.sort_order LIMIT 1) AS thumb_file_id FROM videos v`;
const DOWNLOADS_PER_WINDOW = 60;
const DOWNLOAD_WINDOW_MS = 5 * 60 * 1000;
const SCRIPT_WINDOW_MS = 60 * 60 * 1000;
const KNOWN_SCRIPT_SOURCES = new Set(['ai:openai', 'ai:custom', 'ai:ollama', 'ai:openrouter', 'template', 'openai', 'ollama', 'fallback']);
const UPLOAD_STARTED_AT = Symbol('uploadStartedAt');
const UPLOAD_OUTPUT_CLOSED = Symbol('uploadOutputClosed');
const PARTIAL_UPLOAD_CLEANUP = Symbol('partialUploadCleanup');

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const fileUrl = (id) => `/api/files/${id}`;

export function serializeVideo(video) {
  return {
    id: video.id,
    workspace_id: video.workspace_id,
    project_id: video.project_id,
    title: video.title,
    product_name: video.product_name,
    product_description: video.product_description,
    price: video.price,
    cta: video.cta,
    website_url: video.website_url,
    language: video.language,
    voice_type: video.voice_type,
    style: video.style,
    category: video.category,
    script_hook: video.script_hook,
    script_body: video.script_body,
    script_cta: video.script_cta,
    script_source: video.script_source,
    audio_kind: video.audio_kind,
    voice_language: video.voice_language,
    voice_exact: Boolean(video.voice_exact),
    status: video.status,
    video_url: video.status === 'completed' && video.video_file ? `/api/videos/${video.id}/file` : '',
    thumbnail_url: video.thumb_file_id ? fileUrl(video.thumb_file_id) : '',
    duration_sec: video.duration_sec,
    error_message: video.error_message,
    created_at: video.created_at,
  };
}

export function workspaceUsage(db, workspaceId) {
  const subscription = db.prepare('SELECT plan, monthly_limit, status, created_at FROM subscriptions WHERE workspace_id = ?').get(workspaceId);
  const month = currentMonthStart();
  const row = db.prepare('SELECT videos_created FROM usage WHERE workspace_id = ? AND month_start = ?').get(workspaceId, month);
  return { subscription: subscription || null, usage: { month_start: month, videos_created: row?.videos_created || 0 } };
}

export function createVideoApiRouter({
  db,
  queue,
  rate,
  imagesDir,
  videosDir,
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
  interruptedMessage,
  scriptsPerHour = 30,
  createUploadId = () => crypto.randomUUID(),
  createUploadWriteStream = (target, options) => fs.createWriteStream(target, options),
}) {
  const router = express.Router();
  const upload = multer({
    storage: {
      _handleFile(req, file, callback) {
        const id = createUploadId();
        if (!UUID_RE.test(id)) return callback(new Error('Invalid generated upload ID'));
        const filename = `${id}${IMAGE_TYPES[file.mimetype]}`;
        const target = path.join(imagesDir, filename);
        const output = createUploadWriteStream(target, { flags: 'wx' });
        let opened = false;
        let resolveOutputClosed;
        const outputClosed = new Promise((resolve) => {
          resolveOutputClosed = resolve;
        });
        output.once('close', resolveOutputClosed);
        file[UPLOAD_OUTPUT_CLOSED] = outputClosed;
        output.once('open', () => {
          opened = true;
          file.destination = imagesDir;
          file.filename = filename;
          file.path = target;
        });
        pipeline(file.stream, output, async (err) => {
          if (err) {
            if (opened) await cleanupPartialUpload(req, file);
            return callback(err);
          }
          await outputClosed;
          callback(null, { destination: imagesDir, filename, path: target, size: output.bytesWritten });
        });
      },
      _removeFile(req, file, callback) {
        if (!file.path) return callback(null);
        cleanupPartialUpload(req, file).then(
          () => {
            delete file.destination;
            delete file.filename;
            delete file.path;
            callback(null);
          },
          (err) => {
            console.warn(`[UPLOAD] partial file ${path.basename(file.path)} cleanup failed (${err.code || err.message})`);
            delete file.destination;
            delete file.filename;
            delete file.path;
            callback(null);
          },
        );
      },
    },
    defParamCharset: 'utf8',
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
    fileFilter: (_req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
      cb(httpError(400, 'Неподдерживаемый формат. Разрешены JPG, PNG, WEBP'));
    },
  });

  function getOwnedVideo(req, id) {
    if (!UUID_RE.test(id)) return null;
    return db.prepare(`${VIDEO_SELECT} WHERE v.id = ? AND v.workspace_id = ?`).get(id, req.workspace.id) || null;
  }

  function getOwnedProject(req, id) {
    if (!UUID_RE.test(id || '')) return null;
    return db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(id, req.workspace.id) || null;
  }

  function takeDownloadQuota(workspaceId) {
    const result = rate.hit({ bucket: 'downloads', key: workspaceId, limit: DOWNLOADS_PER_WINDOW, windowMs: DOWNLOAD_WINDOW_MS });
    return result.allowed ? null : result.retryAfterMs;
  }

  function requireDownloadQuota(req, res) {
    if (req.method === 'HEAD') return;
    const retryAfterMs = takeDownloadQuota(req.workspace.id);
    if (!retryAfterMs) return;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    throw httpError(429, 'Слишком много скачиваний. Попробуйте через несколько минут.');
  }

  function getUsage(workspaceId) {
    return workspaceUsage(db, workspaceId);
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
    const category = CATEGORIES.includes(body.category) ? body.category : 'product';
    const uz = body.language === 'uz';
    return {
      value: {
        productName: uz ? normalizeUzbekText(productName) : productName,
        description: uz ? normalizeUzbekText(description) : description,
        cta: uz ? normalizeUzbekText(cta) : cta,
        language: body.language,
        style: body.style,
        category,
      },
    };
  }

  function parseAutoFields(body) {
    const request = cleanText(body?.request, 1200);
    if (request.length < 15) return { error: 'Опишите рекламу подробнее (минимум 15 символов)' };
    const requested = LANGUAGES[body.language] ? body.language : null;
    const language = requested || detectLanguage(request);
    const normalized = language === 'uz' ? normalizeUzbekText(request) : request;
    const category = CATEGORIES.includes(body.category) ? body.category : detectCategory(normalized);
    const style = STYLES.includes(body.style) ? body.style : pickStyle(category);
    const firstSentence = normalized.split(/[.!?]/)[0];
    const shortName = firstSentence
      .split(/\s+/)
      .slice(0, 4)
      .reduce((acc, word) => (acc.length + word.length + 1 > 40 ? acc : acc ? `${acc} ${word}` : word), '')
      .trim();
    const productName = cleanText(body?.productName, 100) || shortName || 'Реклама';
    const cta = cleanText(body?.cta, 60) || defaultCta(category, language);
    return { value: { productName, description: normalized, cta, language, style, category } };
  }

  router.get('/projects', (req, res) => {
    res.json({ projects: db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspace.id) });
  });

  router.post('/projects', (req, res) => {
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

  const uploadImage = (req, res, next) => {
    req[UPLOAD_STARTED_AT] = Date.now();
    upload.single('image')(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        return next(httpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 10MB)' : 'Некорректная загрузка файла'));
      }
      if (err.status === 400) return next(err);
      console.warn('[UPLOAD] parse error:', err.message);
      next(httpError(400, 'Некорректная загрузка файла'));
    });
  };

  function cleanupUploadedFile(req, file) {
    if (!file.path) return { removed: false, reason: 'no-owned-path' };
    const name = file.filename || path.basename(file.path);
    return transaction(db, () =>
      removeOwnFile(file.path, {
        dir: imagesDir,
        name,
        notOlderThan: req[UPLOAD_STARTED_AT],
        isUnused: () => db.prepare('SELECT 1 FROM files WHERE filename = ?').get(name) === undefined,
      }),
    );
  }

  function cleanupPartialUpload(req, file) {
    if (!file.path) return Promise.resolve({ removed: false, reason: 'no-owned-path' });
    if (file[PARTIAL_UPLOAD_CLEANUP]) return file[PARTIAL_UPLOAD_CLEANUP];

    file[PARTIAL_UPLOAD_CLEANUP] = (async () => {
      const name = path.basename(file.path);
      try {
        await file[UPLOAD_OUTPUT_CLOSED];
        const cleanup = cleanupUploadedFile(req, file);
        if (!cleanup.removed && cleanup.reason !== 'already-gone') {
          console.warn(`[UPLOAD] partial file ${name} kept (${cleanup.reason})`);
        }
        return cleanup;
      } catch (err) {
        console.warn(`[UPLOAD] partial file ${name} cleanup failed (${err.code || err.message})`);
        return { removed: false, reason: 'cleanup-failed' };
      }
    })();
    return file[PARTIAL_UPLOAD_CLEANUP];
  }

  router.post('/files', uploadImage, async (req, res) => {
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
      try {
        const cleanup = cleanupUploadedFile(req, file);
        if (!cleanup.removed && cleanup.reason !== 'already-gone') {
          console.warn(`[UPLOAD] temporary file ${path.basename(file.path)} kept (${cleanup.reason})`);
        }
      } catch (cleanupError) {
        console.warn(`[UPLOAD] cleanup failed: ${cleanupError.message}`);
      }
      throw err;
    }
  });

  router.get('/files/:id', (req, res) => {
    requireDownloadQuota(req, res);
    const row = UUID_RE.test(req.params.id)
      ? db.prepare('SELECT filename, mime_type FROM files WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id)
      : null;
    const abs = row && path.join(imagesDir, row.filename);
    if (!row || !fs.existsSync(abs)) throw httpError(404, 'Файл не найден');
    res.sendFile(abs, { headers: { 'Content-Type': row.mime_type, 'Cache-Control': 'private, max-age=3600' } });
  });

  router.post('/scripts', async (req, res) => {
    const parsed = parseScriptFields(req.body);
    if (parsed.error) throw httpError(400, parsed.error);
    if (isAiActive()) {
      const quota = rate.hit({ bucket: 'scripts', key: req.workspace.id, limit: scriptsPerHour, windowMs: SCRIPT_WINDOW_MS });
      if (!quota.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(quota.retryAfterMs / 1000)));
        throw httpError(429, 'Слишком много запросов сценария. Попробуйте через несколько минут.');
      }
    }
    let generated;
    try {
      generated = await generateScript(parsed.value);
    } catch (error) {
      const clientError = toClientAiError(error);
      if (!clientError) throw error;
      if (clientError.retryAfterMs > 0) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(clientError.retryAfterMs / 1000))));
      }
      return res.status(clientError.status).json({ error: clientError.message });
    }
    res.json({
      script: generated.script,
      fullText: generated.fullText,
      source: generated.source.id,
      sourceLabel: generated.source.label,
      sourceKind: generated.source.kind,
      provider: generated.source.provider,
      model: generated.source.model,
      warning: generated.source.warning,
      reason: generated.source.reason,
      attempts: generated.attempts,
    });
  });

  router.get('/videos', (req, res) => {
    res.json({ videos: db.prepare(`${VIDEO_SELECT} WHERE v.workspace_id = ? ORDER BY v.created_at DESC`).all(req.workspace.id).map(serializeVideo) });
  });

  router.post('/videos', (req, res) => {
    const body = req.body || {};
    const workspaceId = req.workspace.id;
    if (!UUID_RE.test(body.clientRequestId || '')) throw httpError(400, 'Некорректный запрос (clientRequestId)');
    const existing = db.prepare('SELECT id FROM videos WHERE workspace_id = ? AND client_request_id = ?').get(workspaceId, body.clientRequestId);
    if (existing) return res.status(200).json({ video: serializeVideo(getOwnedVideo(req, existing.id)), deduplicated: true });

    const isAuto = body.mode === 'auto';
    const parsed = isAuto ? parseAutoFields(body) : parseScriptFields(body);
    if (parsed.error) throw httpError(400, parsed.error);
    const { productName, description, cta, language, style, category } = parsed.value;
    const fileIds = isAuto ? [] : Array.isArray(body.fileIds) ? [...new Set(body.fileIds)] : [];
    if (fileIds.length === 0 && !isAuto) throw httpError(400, 'Загрузите фото товара');
    if (fileIds.length > 10) throw httpError(400, 'Не больше 10 фото');
    for (const id of fileIds) {
      if (typeof id !== 'string' || !UUID_RE.test(id) || !db.prepare('SELECT 1 FROM files WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) {
        throw httpError(400, 'Фото не найдено. Загрузите его заново.');
      }
    }

    let projectId = null;
    if (body.projectId) {
      if (!getOwnedProject(req, body.projectId)) throw httpError(400, 'Проект не найден');
      projectId = body.projectId;
    }
    const voiceType = !isAuto && body.voiceType === 'male' && maleVoiceAvailable(language) ? 'male' : 'female';
    const websiteUrl = cleanText(body.websiteUrl, 300);
    if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) throw httpError(400, 'Website URL должен начинаться с http:// или https://');
    const scriptInput = isAuto ? {} : body.script || {};
    const script =
      scriptInput.hook && scriptInput.benefit1 && scriptInput.benefit2 && scriptInput.cta
        ? {
            hook: cleanText(scriptInput.hook, 100),
            benefit1: cleanText(scriptInput.benefit1, 120),
            benefit2: cleanText(scriptInput.benefit2, 120),
            cta: cleanText(scriptInput.cta, 80),
          }
        : null;
    if (script) {
      try {
        validateGeneratedScript(script, { productName, description }, undefined, { language });
      } catch (error) {
        if (!(error instanceof AiError)) throw error;
        if (error.code === 'claim_validation') {
          throw httpError(422, 'Сценарий содержит неподтверждённые характеристики.');
        }
        throw httpError(400, 'Проверьте структуру и язык сценария.');
      }
    }
    const scriptSource = script
      ? KNOWN_SCRIPT_SOURCES.has(body.scriptSource)
        ? body.scriptSource
        : 'client'
      : '';

    const { subscription, usage } = getUsage(workspaceId);
    if (usage.videos_created >= (subscription?.monthly_limit || 15)) {
      throw httpError(403, 'Лимит генераций на этот месяц исчерпан. Смените тариф в разделе Billing.');
    }

    const videoId = newId();
    const ts = nowIso();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO videos (id, workspace_id, project_id, client_request_id, title, product_name, product_description, price, cta, website_url,
          language, voice_type, style, category, script_hook, script_body, script_cta, script_source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`
      ).run(
        videoId, workspaceId, projectId, body.clientRequestId, productName, productName, description, cleanText(body.price, 50), cta, websiteUrl,
        language, voiceType, style, category, script?.hook || '', script ? `${script.benefit1}\n${script.benefit2}` : '', script?.cta || '', scriptSource, ts, ts
      );
      fileIds.forEach((fileId, index) => {
        db.prepare('INSERT INTO video_assets (id, video_id, file_id, asset_type, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          newId(), videoId, fileId, 'image', index, ts
        );
      });
      db.prepare("INSERT INTO generation_jobs (id, video_id, status, progress, current_step, started_at, created_at) VALUES (?, ?, 'processing', 0, 'Queued', ?, ?)").run(newId(), videoId, ts, ts);
      db.prepare('INSERT INTO usage (workspace_id, month_start, videos_created) VALUES (?, ?, 1) ON CONFLICT (workspace_id, month_start) DO UPDATE SET videos_created = videos_created + 1').run(workspaceId, usage.month_start);
    });

    queue.enqueue(videoId);
    res.status(201).json({ video: serializeVideo(getOwnedVideo(req, videoId)) });
  });

  router.get('/videos/:id', (req, res) => {
    let video = getOwnedVideo(req, req.params.id);
    if (!video) throw httpError(404, 'Видео не найдено');
    if (video.status === 'processing' && !queue.isActive(video.id)) {
      const ts = nowIso();
      db.prepare("UPDATE videos SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(interruptedMessage, ts, video.id);
      db.prepare("UPDATE generation_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE video_id = ? AND status = 'processing'").run(interruptedMessage, ts, video.id);
      video = getOwnedVideo(req, video.id);
    }
    const assets = db
      .prepare('SELECT id, video_id, file_id, asset_type, sort_order, created_at FROM video_assets WHERE video_id = ? ORDER BY sort_order')
      .all(video.id)
      .map((asset) => ({ ...asset, file_url: fileUrl(asset.file_id) }));
    const job = db
      .prepare('SELECT status, progress, current_step, error_message, started_at, completed_at FROM generation_jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(video.id);
    res.json({ video: serializeVideo(video), assets, job: job || null });
  });

  router.post('/videos/:id/retry', (req, res) => {
    const video = getOwnedVideo(req, req.params.id);
    if (!video) throw httpError(404, 'Видео не найдено');
    if (video.status === 'processing' && queue.isActive(video.id)) throw httpError(409, 'Видео уже генерируется');
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

  router.get('/videos/:id/file', (req, res) => {
    requireDownloadQuota(req, res);
    const video = getOwnedVideo(req, req.params.id);
    const abs = video?.video_file && path.join(videosDir, video.video_file);
    if (!video || video.status !== 'completed' || !abs || !fs.existsSync(abs)) throw httpError(404, 'Видео не найдено');
    if (req.query.download === '1') {
      res.attachment(`${video.title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 80) || 'bevhub-video'}.mp4`);
    }
    res.sendFile(abs, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store' } });
  });

  return router;
}
