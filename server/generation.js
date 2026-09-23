import fs from 'fs';
import path from 'path';
import { nowIso } from './db.js';
import { generateAIScript, generateSpeech, renderVideo } from './media.js';

export const INTERRUPTED_MESSAGE = 'Генерация прервана перезапуском сервера. Нажмите «Повторить».';

/**
 * In-process render queue backed by the videos / generation_jobs tables.
 * The database row is the source of truth, so the UI can poll, refresh or reconnect freely.
 */
export function createGenerationQueue({ db, imagesDir, videosDir, tmpDir, concurrency = 2 }) {
  const pending = [];
  const active = new Set();

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

    const workDir = path.join(tmpDir, videoId);
    const partPath = path.join(videosDir, `${videoId}.part.mp4`);
    const finalName = `${videoId}.mp4`;
    let lastProgress = -1;
    let lastStep = '';
    const step = (progress, currentStep) => {
      if (currentStep === lastStep && progress - lastProgress < 5) return;
      lastProgress = progress;
      lastStep = currentStep;
      updateJob.run(progress, currentStep, videoId);
    };

    try {
      if (!asset) throw new Error('У видео нет фото товара');
      const imagePath = path.join(imagesDir, asset.filename);
      if (!fs.existsSync(imagePath)) throw new Error('Фото товара не найдено на сервере');
      fs.mkdirSync(workDir, { recursive: true });

      step(10, 'Analyzing product');
      step(20, 'Writing script');
      const [benefit1, benefit2] = video.script_body.split('\n');
      let script;
      if (video.script_hook && benefit1 && benefit2 && video.script_cta) {
        script = { hook: video.script_hook, benefit1, benefit2, cta: video.script_cta };
      } else {
        const generated = await generateAIScript({
          productName: video.product_name,
          description: video.product_description,
          cta: video.cta,
          language: video.language,
          style: video.style,
        });
        script = generated.script;
        db.prepare('UPDATE videos SET script_hook = ?, script_body = ?, script_cta = ?, script_source = ?, updated_at = ? WHERE id = ?').run(
          script.hook,
          `${script.benefit1}\n${script.benefit2}`,
          script.cta,
          generated.source,
          nowIso(),
          videoId
        );
      }

      step(35, 'Generating voice');
      const voice = await generateSpeech(script, video.language, workDir);
      db.prepare('UPDATE videos SET audio_kind = ?, updated_at = ? WHERE id = ?').run(voice.kind, nowIso(), videoId);

      step(50, 'Creating video');
      await renderVideo({
        imagePath,
        voice,
        script,
        style: video.style,
        workDir,
        outputPath: partPath,
        onProgress: (ratio) => step(50 + Math.round(ratio * 45), ratio < 0.5 ? 'Creating video' : 'Adding subtitles'),
      });

      // Rename only after FFmpeg finished, so a half-written file is never served.
      fs.renameSync(partPath, path.join(videosDir, finalName));
      db.prepare("UPDATE videos SET status = 'completed', video_file = ?, duration_sec = 15, error_message = '', updated_at = ? WHERE id = ?").run(
        finalName,
        nowIso(),
        videoId
      );
      finish(videoId, 'completed', '');
      console.log(`[VIDEO] ${videoId} completed (audio: ${voice.kind})`);
    } catch (err) {
      console.error(`[VIDEO] ${videoId} failed:`, err.message);
      fs.rmSync(partPath, { force: true });
      db.prepare("UPDATE videos SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(err.message, nowIso(), videoId);
      finish(videoId, 'failed', err.message);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** After a restart nothing is rendering: fail interrupted jobs and verify finished files still exist. */
  function recoverOnStartup() {
    const ts = nowIso();
    const interrupted = db
      .prepare("UPDATE videos SET status = 'failed', error_message = ?, updated_at = ? WHERE status IN ('processing', 'queued')")
      .run(INTERRUPTED_MESSAGE, ts).changes;
    db.prepare("UPDATE generation_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE status = 'processing'").run(INTERRUPTED_MESSAGE, ts);

    let missing = 0;
    for (const v of db.prepare("SELECT id, video_file FROM videos WHERE status = 'completed'").all()) {
      if (!v.video_file || !fs.existsSync(path.join(videosDir, v.video_file))) {
        db.prepare("UPDATE videos SET status = 'failed', error_message = 'Файл видео не найден на сервере. Нажмите «Повторить».', video_file = '', updated_at = ? WHERE id = ?").run(ts, v.id);
        missing++;
      }
    }
    for (const f of fs.readdirSync(videosDir)) if (f.endsWith('.part.mp4')) fs.rmSync(path.join(videosDir, f), { force: true });
    if (interrupted || missing) console.log(`[VIDEO] recovery: ${interrupted} interrupted, ${missing} missing files marked failed`);
  }

  return { enqueue, isActive, recoverOnStartup };
}
