import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { nowIso } from './db.js';
import { generateScript, generateSpeech, renderVideo, renderAutoVideo, FFPROBE_BIN } from './media.js';
import { readCleanupPolicy, describePolicy } from './cleanup-policy.js';
import { removeOwnFile } from './safe-remove.js';
import { validateGeneratedScript } from './ai/validate.js';

const execFileAsync = promisify(execFile);

export const INTERRUPTED_MESSAGE = 'Генерация прервана перезапуском сервера. Нажмите «Повторить».';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows refuses to rename a file that another handle still owns. FFmpeg releases the output late
// (with `-movflags +faststart` it rewrites the file after encoding), so EPERM right after "end" is
// a timing issue, not a failed render.
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const PUBLISH_ATTEMPTS = 6;

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no blocking primitive available — fall through */
  }
};

/**
 * Deleting render leftovers must never fail a job: on Windows the file can stay locked for a moment
 * (AV scanner, OneDrive), so retry briefly and only warn when the directory really survives.
 */
function removeQuietly(target, { recursive = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(target, { recursive, force: true });
      return true;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`[VIDEO] cleanup failed for ${target}: ${err.code || err.message}`);
        return false;
      }
      sleepSync(150);
    }
  }
  return false;
}

/** Directory listing that never throws. */
function listDirSafe(dir) {
  try {
    return { ok: true, names: fs.readdirSync(dir) };
  } catch (err) {
    return { ok: false, code: err.code || 'EREADDIR', message: err.message };
  }
}

const PART_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.part\.mp4$/i;

/** stat without throwing; null when the path cannot be inspected. */
function safeStatSync(abs) {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

// A caller that forgets to pass a policy gets the fail-closed one, not the ambient environment: a
// cleanup path must never delete because a variable happened to be set somewhere.
const FAIL_CLOSED_POLICY = readCleanupPolicy({});

/**
 * Per-run paths for one execution of a job.
 *
 * Every run gets a fresh UUID, so the scratch directory and the render file cannot collide with an
 * earlier run of the same video (a retry) or with another process rendering the same video. That is the
 * ownership proof the cleanup in `run()` relies on: the directory and the file it deletes were created by
 * this run and by nothing else.
 *
 * @returns {{runId: string, workDir: string, partPath: string, finalPath: string}}
 */
export function jobPaths({ tmpDir, videosDir, videoId }) {
  const runId = crypto.randomUUID();
  return {
    runId,
    workDir: path.join(tmpDir, videoId, runId),
    partPath: path.join(videosDir, `${videoId}.${runId}.part.mp4`),
    finalPath: path.join(videosDir, `${videoId}.mp4`),
  };
}

/**
 * Atomically claims an output path that must not exist yet. Uses exclusive creation
 * (O_CREAT|O_EXCL / CREATE_NEW), so the existence check and creation are one operation: there is no
 * window in which another process can create the file between "exists?" and "open". The file is
 * closed immediately; the caller owns the slot. FFmpeg may then write into this file (fluent-ffmpeg
 * passes -y), which is safe because the file did not exist before this run claimed it.
 *
 * @returns {{claimed: true}|{claimed: false, code?: string, message: string}}
 */
export function claimExclusiveOutput(filePath) {
  try {
    const fd = fs.openSync(filePath, 'wx');
    try { fs.closeSync(fd); } catch {}
    return { claimed: true };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { claimed: false, code: 'EEXIST', message: 'already exists' };
    return { claimed: false, code: err && err.code, message: err && err.message ? String(err.message) : String(err) };
  }
}

/**
 * Removes the per-run scratch directory of a job.
 *
 * Ownership is the successful exclusive `mkdir` in `run()` and nothing else: a directory this run did
 * not create (`EEXIST`) is left exactly as it is, contents included. Without that proof the path would
 * be deleted on an "it is probably ours" basis, which is the rule this whole cleanup is built against.
 *
 * @returns {{removed: boolean, reason: 'removed'|'delete-failed'|'not-owner'}}
 */
export function removeRunWorkDir({ workDir, ownsWorkDir, label = '', log = console }) {
  if (!ownsWorkDir) {
    log.warn(`[VIDEO] ${label}: ${workDir} was not created by this run — leaving it untouched`);
    return { removed: false, reason: 'not-owner' };
  }
  const removed = removeQuietly(workDir, { recursive: true });
  return { removed, reason: removed ? 'removed' : 'delete-failed' };
}

/**
 * Removes the render file of a failed job.
 *
 * Deleted only when all of these hold: the policy enables temp cleanup, the failure happened *before* a
 * valid file existed (`rendered === false`), the path is the one this run was writing, and the file was
 * written by this run (mtime not older than the run). A file that was already there is kept.
 *
 * @returns {{removed: boolean, reason: string}}
 */
export function cleanupFailedRender({ partPath, rendered, policy = FAIL_CLOSED_POLICY, startedAt }) {
  if (rendered) return { removed: false, reason: 'valid-render-kept' };
  if (!policy.generationTemp.apply) return { removed: false, reason: 'cleanup-disabled' };
  const result = removeOwnFile(partPath, { dir: path.dirname(partPath), name: path.basename(partPath), notOlderThan: startedAt });
  return { removed: result.removed, reason: result.reason };
}

/**
 * Decides what to do with a `*.part.mp4` file found in the videos directory.
 *
 * The name alone never proves the file is garbage: the process that created it may still be rendering
 * it right now, and there is no cross-process ownership record to check against. Age is not proof of
 * anything either (a render can legitimately take longer than the process uptime). So this function has
 * **no `delete` verdict at all**: every unrecognised `.part.mp4` is kept, and the report says why.
 *
 * The render files written by `run()` carry a per-run UUID, so a leftover can be attributed to a video
 * but never to a process — which is exactly why nothing is deleted here.
 *
 * Automatic removal returns only when per-file ownership can be proven (stage C locks), and even then
 * only behind `CLEANUP_TMP_MODE=apply`.
 *
 * @returns {'keep:active'|'keep:referenced'|'keep:row-exists'|'keep:unowned'|'not-a-part'}
 */
export function classifyPartFile({ name, activeJobIds = [], referencedNames = [], videoIds = [] }) {
  if (!PART_RE.test(name)) return 'not-a-part';
  const id = name.slice(0, 36);
  if (activeJobIds.includes(id)) return 'keep:active';
  if (referencedNames.includes(name)) return 'keep:referenced';
  if (videoIds.includes(id)) return 'keep:row-exists';
  return 'keep:unowned';
}

/**
 * Decides what to do with a completed video whose file is not in the directory listing.
 *
 * `missing` — the only verdict that may later justify clearing `video_file`, and only behind an explicit
 * policy — requires a readable, non-empty directory, a successful `stat` and a file that is really not
 * there. An empty or unreadable directory, or a file whose `stat` failed (EACCES/EBUSY/temporary I/O
 * error), means "we cannot tell" and must never change a row.
 *
 * @returns {'no-file'|'empty-dir'|'unreadable'|'present'|'missing'}
 */
export function classifyMissingVideo({ fileName, present, dirEmpty, unreadable = [] }) {
  if (!fileName) return 'no-file';
  if (dirEmpty) return 'empty-dir';
  if (unreadable.includes(fileName)) return 'unreadable';
  return present.has(fileName) ? 'present' : 'missing';
}

/**
 * Checks that the rendered file is a complete, playable MP4 before it is published.
 * A half-written or truncated file must never reach the user, and a file that merely *looks* done
 * (faststart rewrites it) must not be served early.
 *
 * @returns {Promise<{ok: boolean, reason: string, durationSec: number, width: number, height: number}>}
 */
export async function probeRenderedVideo(filePath) {
  const bad = (reason) => ({ ok: false, reason, durationSec: 0, width: 0, height: 0 });
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size || stat.size < 20 * 1024) return bad(`файл слишком мал (${stat.size} байт)`);
  } catch (err) {
    return bad(`файл не найден (${err.code || err.message})`);
  }
  if (!FFPROBE_BIN) return { ok: true, reason: 'ffprobe недоступен — проверка пропущена', durationSec: 0, width: 0, height: 0 };

  let data;
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    data = JSON.parse(stdout);
  } catch (err) {
    return bad(`ffprobe не смог прочитать файл (${String(err.message).split('\n')[0]})`);
  }

  const streams = data?.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) return bad('в файле нет видеодорожки');
  if (video.codec_name !== 'h264') return bad(`видео закодировано как ${video.codec_name}, ожидался h264`);
  if (video.width !== 1080 || video.height !== 1920) return bad(`кадр ${video.width}x${video.height}, ожидался 1080x1920`);
  if (!audio) return bad('в файле нет аудиодорожки');
  if (audio.codec_name !== 'aac') return bad(`звук закодирован как ${audio.codec_name}, ожидался aac`);

  const durationSec = Number(data?.format?.duration || 0);
  if (!Number.isFinite(durationSec) || durationSec < 14 || durationSec > 16) return bad(`длительность ${durationSec} с, ожидалось ~15 с`);

  return { ok: true, reason: '', durationSec, width: video.width, height: video.height };
}

/**
 * Publishes the finished render under its final name.
 *
 * 1. the file is validated first, so a broken render is never renamed into place;
 * 2. the rename is retried with growing pauses, because FFmpeg/Windows may still hold the handle;
 * 3. if the destination itself is locked (a viewer or a download is streaming the previous file),
 *    the finished video is published under a fresh name instead of being thrown away.
 *
 * @returns {Promise<{finalPath: string, durationSec: number, renamed: boolean}>}
 */
/**
 * Picks a publication target that does not exist yet, without ever overwriting an existing file.
 * The preferred target is `finalPath`; if it is already taken, a fresh name next to it is chosen.
 * Each candidate is claimed atomically with exclusive creation to avoid a check/open race; the claim
 * placeholder is removed before the render is moved into place (the rename targets a name this run has
 * proven free). `renamed` is true when the file could not be published under the requested name.
 *
 * @returns {{targetPath: string, renamed: boolean}}
 */
export function reservePublishTarget(finalPath) {
  const ext = path.extname(finalPath) || '.mp4';
  const base = finalPath.slice(0, finalPath.length - ext.length);
  const candidates = [finalPath];
  for (let i = 0; i < 20; i++) candidates.push(`${base}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}${ext}`);
  for (const candidate of candidates) {
    const claim = claimExclusiveOutput(candidate);
    if (claim.claimed) {
      try { fs.rmSync(candidate, { force: true }); } catch {}
      return { targetPath: candidate, renamed: candidate !== finalPath };
    }
    if (claim.code !== 'EEXIST') {
      throw Object.assign(new Error(`Не удалось зарезервировать имя файла: ${claim.code || claim.message}`), { rendered: true });
    }
  }
  throw Object.assign(new Error('Не удалось подобрать свободное имя файла'), { rendered: true });
}

/**
 * Returns publication targets to try, in order: the requested path first, then fresh alternatives in
 * the same directory. Alternatives are never overwrites — each attempt publishes with an exclusive
 * link, so an existing file (or a concurrent creator) simply makes that candidate fail with EEXIST.
 */
export function publishTargetCandidates(finalPath) {
  const ext = path.extname(finalPath) || '.mp4';
  const base = finalPath.slice(0, finalPath.length - ext.length);
  const out = [finalPath];
  for (let i = 0; i < 20; i++) out.push(`${base}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}${ext}`);
  return out;
}

/**
 * Publishes the finished render without ever overwriting an existing file.
 *
 * 1. The render is validated first, so a broken file is never published.
 * 2. Publishing is an atomic hard-link of `partPath` to the target name (same filesystem: both live in
 *    `videosDir`). `link` fails with EEXIST if the target already exists and never replaces it, so a
 *    pre-existing or concurrently created file cannot be clobbered. After a successful link the part file
 *    is removed. Lock/busy errors are retried with backoff; EEXIST moves to a fresh alternative name.
 *
 * @returns {Promise<{finalPath: string, requestedPath: string, durationSec: number, renamed: boolean}>}
 */
export async function publishRenderedVideo(partPath, finalPath, { probe = probeRenderedVideo } = {}) {
  const check = await probe(partPath);
  if (!check.ok) {
    throw Object.assign(new Error(`Готовый файл не прошёл проверку: ${check.reason}`), { rendered: false });
  }

  const candidates = publishTargetCandidates(finalPath);
  let idx = 0;
  let targetPath = candidates[idx];
  let lastError = null;

  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS && idx < candidates.length; attempt++) {
    try {
      fs.linkSync(partPath, targetPath);
      try { fs.rmSync(partPath, { force: true }); } catch {}
      return { finalPath: targetPath, requestedPath: finalPath, durationSec: check.durationSec, renamed: targetPath !== finalPath };
    } catch (err) {
      lastError = err;
      if (err && err.code === 'EEXIST') {
        // Target name is taken (pre-existing or concurrent) — never overwrite; try a fresh alternative.
        idx += 1;
        targetPath = candidates[idx];
        continue;
      }
      if (LOCK_CODES.has(err && err.code)) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      throw Object.assign(new Error(`Не удалось сохранить видео: ${(err && err.code) || (err && err.message) || err}`), { rendered: true });
    }
  }

  // The render itself is fine: keep the .part file for manual recovery instead of deleting it.
  console.error(`[VIDEO] не удалось опубликовать ${path.basename(targetPath || finalPath)}: ${lastError?.code || lastError?.message}. Файл сохранён как ${partPath}`);
  throw Object.assign(
    new Error(`Видео готово, но не удалось сохранить файл (${lastError?.code || lastError?.message}). Файл остался на сервере: ${path.basename(partPath)}`),
    { rendered: true }
  );
}
/**
 * In-process render queue backed by the videos / generation_jobs tables.
 * The database row is the source of truth, so the UI can poll, refresh or reconnect freely.
 *
 * `cleanupPolicy` defaults to "delete nothing": a caller that forgets to pass one gets a queue that
 * leaves every leftover file in place instead of one that silently sweeps `uploads`.
 */
export function createGenerationQueue({
  db,
  imagesDir,
  videosDir,
  tmpDir,
  concurrency = 2,
  cleanupPolicy = readCleanupPolicy({}),
  generateScriptImpl = generateScript,
  generateSpeechImpl = generateSpeech,
  renderVideoImpl = renderVideo,
  renderAutoVideoImpl = renderAutoVideo,
  publishRenderedVideoImpl = publishRenderedVideo,
}) {
  const pending = [];
  const active = new Set();
  console.log(`[CLEANUP] generation leftovers: ${describePolicy(cleanupPolicy)}`);

  const updateJob = db.prepare(
    "UPDATE generation_jobs SET progress = ?, current_step = ? WHERE video_id = ? AND status = 'processing'"
  );

  function isActive(videoId) {
    return active.has(videoId) || pending.includes(videoId);
  }

  function enqueue(videoId) {
    if (isActive(videoId)) return;
    pending.push(videoId);
    pump();
  }

  function pump() {
    while (active.size < concurrency && pending.length) {
      const videoId = pending.shift();
      active.add(videoId);
      run(videoId)
        .catch((err) => console.error(`[VIDEO] unexpected error for ${videoId}:`, err))
        .finally(() => {
          active.delete(videoId);
          pump();
        });
    }
  }

  function finish(videoId, status, errorMessage) {
    const ts = nowIso();
    db.prepare("UPDATE generation_jobs SET status = ?, progress = ?, current_step = ?, error_message = ?, completed_at = ? WHERE video_id = ? AND status = 'processing'").run(
      status,
      status === 'completed' ? 100 : 0,
      status === 'completed' ? 'Finalizing' : 'Failed',
      errorMessage,
      ts,
      videoId
    );
  }

  async function run(videoId) {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video || video.status !== 'processing') return;

    const asset = db
      .prepare(
        `SELECT f.filename FROM video_assets a JOIN files f ON f.id = a.file_id
         WHERE a.video_id = ? ORDER BY a.sort_order LIMIT 1`
      )
      .get(videoId);

    // Every run of a job gets its own scratch directory and its own render file. Both names contain a
    // fresh UUID, so nothing this run writes can collide with another process (or with an earlier run of
    // the same video after a retry) — which is what makes the cleanup in `finally` safe to run.
    const { workDir, partPath, finalPath } = jobPaths({ tmpDir, videosDir, videoId });
    // Ownership marker: nothing with an older mtime can have been written by this run.
    const startedAt = Date.now();
    // The per-run directory may be removed in `finally` only after this run created it. It is created
    // exclusively below, so `EEXIST` means somebody else's directory: then it is left alone.
    let ownsWorkDir = false;
    const finalName = path.basename(finalPath);
    let lastProgress = -1;
    let lastStep = '';
    const step = (progress, currentStep) => {
      if (currentStep === lastStep && progress - lastProgress < 5) return;
      lastProgress = progress;
      lastStep = currentStep;
      updateJob.run(progress, currentStep, videoId);
    };

    try {
      // A video without photo assets renders in auto mode: generated gradient background.
      const imagePath = asset && path.join(imagesDir, asset.filename);
      if (asset && !fs.existsSync(imagePath)) throw new Error('Фото товара не найдено на сервере');

      step(10, 'Analyzing product');
      step(20, 'Writing script');
      const [benefit1, benefit2] = video.script_body.split('\n');
      let script;
      let generated;
      if (video.script_hook && benefit1 && benefit2 && video.script_cta) {
        script = { hook: video.script_hook, benefit1, benefit2, cta: video.script_cta };
      } else {
        generated = await generateScriptImpl({
          productName: video.product_name,
          description: video.product_description,
          cta: video.cta,
          language: video.language,
          style: video.style,
          category: video.category,
        });
        script = generated.script;
      }
      validateGeneratedScript(
        script,
        { productName: video.product_name, description: video.product_description },
        generated?.fullText,
        { language: video.language, provider: generated?.source?.provider },
      );
      if (generated) {
        db.prepare('UPDATE videos SET script_hook = ?, script_body = ?, script_cta = ?, script_source = ?, updated_at = ? WHERE id = ?').run(
          script.hook,
          `${script.benefit1}\n${script.benefit2}`,
          script.cta,
          generated.source.id,
          nowIso(),
          videoId
        );
      }

      // Validation must finish before this run creates a render file or starts TTS/FFmpeg.
      // Parent `uploads/tmp/<videoId>` is shared and created recursively; the run directory itself is
      // created exclusively, and only that successful `mkdir` makes this run its owner. `EEXIST` means
      // something already uses this exact name — with a fresh UUID that cannot happen, and if it ever
      // does, refusing to write into it (and to delete it) is the safe outcome.
      fs.mkdirSync(path.dirname(workDir), { recursive: true });
      fs.mkdirSync(workDir);
      ownsWorkDir = true;

      // Claim the render output slot atomically (O_CREAT|O_EXCL / CREATE_NEW). This proves no file
      // existed at this path and reserves it without a check/open race, so FFmpeg cannot overwrite a
      // pre-existing file even if a name were reused. FFmpeg writes into the file this run created.
      const partClaim = claimExclusiveOutput(partPath);
      if (!partClaim.claimed) {
        throw new Error(`Не удалось зарезервировать файл рендера: ${partClaim.code || partClaim.message}`);
      }

      step(35, 'Generating voice');
      const voice = await generateSpeechImpl(script, video.language, video.voice_type, workDir);
      // Record what actually spoke: a substitute voice (e.g. a Russian voice reading Uzbek) is stored
      // together with the language it really speaks, so the UI can say so instead of guessing.
      db.prepare(
        'UPDATE videos SET audio_kind = ?, voice_type = COALESCE(?, voice_type), voice_language = ?, voice_exact = ?, updated_at = ? WHERE id = ?'
      ).run(
        voice.kind,
        voice.gender,
        voice.voiceLanguage || '',
        voice.exactLanguage ? 1 : 0,
        nowIso(),
        videoId
      );
      if (voice.warning) console.warn(`[VIDEO] ${videoId} voice limitation: ${voice.warning}`);

      step(50, 'Creating video');
      const onProgress = (ratio) => step(50 + Math.round(ratio * 45), ratio < 0.5 ? 'Creating video' : 'Adding subtitles');
      if (asset) {
        await renderVideoImpl({
          imagePath,
          voice,
          script,
          style: video.style,
          workDir,
          outputPath: partPath,
          onProgress,
        });
      } else {
        await renderAutoVideoImpl({
          voice,
          script,
          style: video.style,
          category: video.category,
          price: video.price,
          website: video.website_url,
          workDir,
          outputPath: partPath,
          onProgress,
        });
      }

      // Rename only after FFmpeg finished and the file is verified, so a half-written file is never served.
      const published = await publishRenderedVideoImpl(partPath, path.join(videosDir, finalName));
      db.prepare("UPDATE videos SET status = 'completed', video_file = ?, duration_sec = ?, error_message = '', updated_at = ? WHERE id = ?").run(
        path.basename(published.finalPath),
        Math.max(1, Math.round(published.durationSec || 15)),
        nowIso(),
        videoId
      );
      finish(videoId, 'completed', '');
      console.log(`[VIDEO] ${videoId} completed (audio: ${voice.kind}${published.renamed ? ', saved under an alternative name' : ''})`);
    } catch (err) {
      console.error(`[VIDEO] ${videoId} failed:`, err.message);
      // A render that produced a valid file but could not be moved must keep that file. The failed render
      // itself is removed only when temp cleanup is enabled, only if no valid file was produced, and only
      // if the file was written by *this* run (mtime check inside `removeOwnFile`).
      const cleanup = cleanupFailedRender({ partPath, rendered: err.rendered === true, policy: cleanupPolicy, startedAt });
      if (!cleanup.removed && cleanup.reason !== 'cleanup-disabled' && fs.existsSync(partPath)) {
        console.warn(`[VIDEO] ${path.basename(partPath)} kept (${cleanup.reason})`);
      }
      db.prepare('UPDATE videos SET status = ?, error_message = ?, updated_at = ? WHERE id = ?').run(
        'failed',
        err.message,
        nowIso(),
        videoId
      );
      finish(videoId, 'failed', err.message);
    } finally {
      // Scratch files for *this* job, in this process's own per-run directory. The directory name holds a
      // UUID minted by this run, and only the successful exclusive `mkdir` above proves the run created
      // it, so removing it cannot affect user data and is not gated on the cleanup policy.
      removeRunWorkDir({ workDir, ownsWorkDir, label: videoId });
    }
  }

  /** After a restart nothing is rendering: fail interrupted jobs and verify finished files still exist. */
  function recoverOnStartup() {
    const ts = nowIso();
    const interrupted = db
      .prepare("UPDATE videos SET status = 'failed', error_message = ?, updated_at = ? WHERE status IN ('processing', 'queued')")
      .run(INTERRUPTED_MESSAGE, ts).changes;
    db.prepare("UPDATE generation_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE status = 'processing'").run(INTERRUPTED_MESSAGE, ts);

    // Marking a completed video as failed destroys the only link to its file, so it happens only when
    // Diagnosis only. A missing file is *reported*, never acted upon: the storage may simply not be
    // mounted, and clearing `video_file` would throw away the only link to the user's video. Changing a
    // row for this reason is a separate, explicitly confirmed operation (`markMissingVideos`).
    const listing = listDirSafe(videosDir);
    if (!listing.ok) {
      console.warn(`[VIDEO] recovery: cannot read ${videosDir} (${listing.code}) — nothing was changed`);
      return {
        interrupted,
        storageError: { code: listing.code, message: listing.message },
        present: [],
        unreadable: [],
        missing: [],
        unverifiable: [],
        parts: [],
        partsRemoved: 0,
      };
    }

    // `present` holds only files that could actually be inspected. A name whose `stat` fails (EACCES,
    // EBUSY, a temporary I/O error) is unknown, and unknown must not become "missing".
    const present = [];
    const unreadable = [];
    const presentSet = new Set();
    const unreadableSet = new Set();
    for (const name of listing.names) {
      const stat = safeStatSync(path.join(videosDir, name));
      if (!stat || !stat.isFile()) {
        unreadable.push(name);
        unreadableSet.add(name);
        continue;
      }
      present.push(name);
      presentSet.add(name);
    }

    const missing = [];
    const unverifiable = [];
    for (const v of db.prepare("SELECT id, video_file FROM videos WHERE status = 'completed'").all()) {
      if (!v.video_file) continue;
      const verdict = classifyMissingVideo({ fileName: v.video_file, present: presentSet, dirEmpty: listing.names.length === 0, unreadable });
      if (verdict === 'missing') missing.push({ id: v.id, file: v.video_file });
      else if (verdict === 'empty-dir' || verdict === 'unreadable') unverifiable.push({ id: v.id, file: v.video_file, verdict });
    }

    // `.part.mp4` files are only ever reported here. Nothing is deleted: the owning process may still be
    // rendering, and ownership cannot be proven across processes.
    const referencedNames = new Set();
    for (const row of db.prepare("SELECT video_file AS name FROM videos WHERE video_file <> ''").all()) {
      referencedNames.add(row.name);
    }
    for (const row of db.prepare("SELECT id || '.part.mp4' AS name FROM generation_jobs WHERE status IN ('processing', 'queued')").all()) {
      referencedNames.add(row.name);
    }
    const knownPartIds = new Set();
    for (const name of referencedNames) {
      if (PART_RE.test(name)) knownPartIds.add(name.slice(0, 36));
    }
    for (const v of db.prepare("SELECT id FROM videos WHERE video_file <> ''").all()) knownPartIds.add(v.id);

    const parts = [];
    for (const name of listing.names) {
      const verdict = classifyPartFile({
        name,
        activeJobIds: [...active, ...pending],
        referencedNames: [...referencedNames],
        videoIds: [...knownPartIds],
      });
      if (verdict === 'not-a-part') continue;
      parts.push({ file: name, verdict, deletable: false });
      if (verdict === 'keep:unowned') {
        console.warn(`[VIDEO] recovery: ${name} is not referenced by any row and is kept — cross-process ownership cannot be proven`);
      }
    }

    if (interrupted || missing.length || parts.length) {
      console.log(
        `[VIDEO] recovery: ${interrupted} interrupted job(s), ${missing.length} video(s) with a missing file (reported, nothing changed)` +
          `${parts.length ? `, ${parts.length} render leftover(s) kept` : ''}`
      );
      for (const v of unverifiable) console.warn(`[VIDEO] recovery: ${v.file} — ${v.verdict === 'empty-dir' ? 'storage directory is empty' : 'file is not readable'} — row left untouched`);
    }
    return {
      interrupted,
      storageError: null,
      present,
      unreadable,
      missing,
      unverifiable,
      parts,
      partsRemoved: 0,
    };
  }

  /**
   * Explicitly confirmed follow-up to `recoverOnStartup`: clears `video_file` for videos whose file is
   * provably absent. Never runs automatically — the caller must opt in (a policy flag). Every row it
   * changes is reported, and a row whose file is merely unreadable is never touched.
   */
  function markMissingVideos(report) {
    const ts = nowIso();
    const changed = [];
    for (const v of report.missing) {
      const info = db.prepare("UPDATE videos SET status = 'failed', error_message = ?, video_file = '', updated_at = ? WHERE id = ? AND video_file = ?").run(
        'Файл видео не найден на сервере. Нажмите «Повторить».',
        ts,
        v.id,
        v.file
      );
      if (info.changes) changed.push(v.id);
    }
    if (changed.length) console.log(`[VIDEO] ${changed.length} video(s) marked as missing their file (explicitly requested)`);
    return changed;
  }

  return { enqueue, isActive, recoverOnStartup, markMissingVideos };
}
