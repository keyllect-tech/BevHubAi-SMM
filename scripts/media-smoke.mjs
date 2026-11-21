import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { createIsolationConfig } from '../server/isolation-config.js';
import {
  boundedProcessTimeoutMs,
  createDeadlinePhases,
  createShutdownState,
  waitForActivityToStop,
} from './media-smoke-supervision.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const STORAGE_OVERRIDES = [
  'DATABASE_FILE',
  'UPLOADS_DIR',
  'TMP_DIR',
  'BACKUP_DIR',
  'STORAGE_ALLOWED_ROOTS',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'ISOLATED_TEST_ROOT',
  'ISOLATED_TEST_MODE',
  'ISOLATED_DESTRUCTIVE_TEST_MODE',
];
const SECRET_ENV_RE = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const VIDEO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(a, b) {
  return isWithin(a, b) || isWithin(b, a);
}

function assertNoConflictingEnvironment(env) {
  for (const name of STORAGE_OVERRIDES) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      throw new Error(`${name} is not allowed for the media smoke test`);
    }
  }
  const secretNames = Object.keys(env).filter((name) => SECRET_ENV_RE.test(name));
  if (secretNames.length) {
    throw new Error(`secret-bearing environment variables are not allowed: ${secretNames.join(', ')}`);
  }
}

function assertMissingRoot(root, fsApi = fs) {
  try {
    fsApi.lstatSync(root);
    throw new Error('the generated disposable root already exists');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

export function validateMediaSmokePaths({ isolation, testRoot, videoId, paths = isolation?.paths } = {}) {
  if (!testRoot || !path.isAbsolute(testRoot)) throw new Error('a disposable root is required');
  if (!VIDEO_ID_RE.test(videoId || '')) throw new Error('invalid synthetic video ID');
  if (!isolation?.assertPath || !paths) throw new Error('isolated path policy is required');

  const root = path.resolve(testRoot);
  const dataDir = path.join(root, 'data');
  const downloadDir = path.join(root, 'download-check');
  const systemTempDir = path.join(root, 'system-temp');
  const imagePath = path.join(paths.imagesDir, `${videoId}.png`);
  const outputPath = path.join(paths.videosDir, `${videoId}.mp4`);
  const samplePartPath = path.join(paths.videosDir, `${videoId}.${crypto.randomUUID()}.part.mp4`);
  const sampleWorkDir = path.join(paths.tmpDir, videoId, crypto.randomUUID());
  const downloadPath = path.join(downloadDir, `${videoId}.mp4`);
  const manifestPath = path.join(root, 'manifest.json');
  const reportPath = path.join(root, 'report.json');
  const supervisionReportPath = path.join(root, 'supervision-report.json');
  const shutdownRequestPath = path.join(root, 'shutdown-request.json');
  const ownershipMarkerPath = path.join(root, '.media-smoke-owner');

  const expectedPaths = {
    databaseFile: path.join(dataDir, 'bevhub.db'),
    uploadsDir: path.join(root, 'uploads'),
    imagesDir: path.join(root, 'uploads', 'images'),
    videosDir: path.join(root, 'uploads', 'videos'),
    tmpDir: path.join(root, 'uploads', 'tmp'),
    audioDir: path.join(root, 'uploads', 'audio'),
    backupDir: path.join(dataDir, 'backups'),
  };
  for (const [name, expected] of Object.entries(expectedPaths)) {
    if (path.resolve(paths[name]) !== path.resolve(expected)) {
      throw new Error(`${name} does not match the fixed disposable layout`);
    }
  }

  const writePaths = [
    root,
    dataDir,
    paths.databaseFile,
    `${paths.databaseFile}-wal`,
    `${paths.databaseFile}-shm`,
    paths.uploadsDir,
    paths.imagesDir,
    paths.videosDir,
    paths.tmpDir,
    paths.audioDir,
    paths.backupDir,
    imagePath,
    outputPath,
    samplePartPath,
    sampleWorkDir,
    downloadDir,
    downloadPath,
    systemTempDir,
    manifestPath,
    reportPath,
    supervisionReportPath,
    shutdownRequestPath,
    ownershipMarkerPath,
  ];
  for (const candidate of writePaths) {
    const resolved = path.resolve(isolation.assertPath(candidate));
    if (!isWithin(root, resolved)) throw new Error('a planned storage path escapes the disposable root');
  }

  if (pathsOverlap(dataDir, paths.uploadsDir)) throw new Error('database and uploads roots overlap');
  const uploadScopes = [paths.imagesDir, paths.videosDir, paths.tmpDir, paths.audioDir, downloadDir];
  for (let i = 0; i < uploadScopes.length; i++) {
    for (let j = i + 1; j < uploadScopes.length; j++) {
      if (pathsOverlap(uploadScopes[i], uploadScopes[j])) {
        throw new Error(`isolated storage paths overlap: ${uploadScopes[i]} and ${uploadScopes[j]}`);
      }
    }
  }
  if (!isWithin(paths.imagesDir, imagePath)) throw new Error('synthetic image path is outside images scope');
  if (!isWithin(paths.videosDir, outputPath) || !isWithin(paths.videosDir, samplePartPath)) {
    throw new Error('video output path is outside videos scope');
  }
  if (!isWithin(paths.tmpDir, sampleWorkDir)) throw new Error('job work path is outside temporary scope');

  return Object.freeze({
    testRoot: root,
    dataDir,
    downloadDir,
    downloadPath,
    imagePath,
    outputPath,
    manifestPath,
    reportPath,
    supervisionReportPath,
    shutdownRequestPath,
    ownershipMarkerPath,
    systemTempDir,
    samplePartPath,
    sampleWorkDir,
  });
}

export function reportSmokeFailure(disposableRoot, { rootCreated, log = console.error } = {}) {
  const state = rootCreated ? 'retained' : 'candidate (not created by this run)';
  log(`[MEDIA SMOKE] disposable root ${state}: ${disposableRoot}`);
}

function writeShutdownRequest(plan, reason) {
  plan.isolation.assertPath(plan.shutdownRequestPath);
  fs.writeFileSync(
    plan.shutdownRequestPath,
    `${JSON.stringify({ reason, pid: process.pid, requestedAt: new Date().toISOString() })}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}

export function createMediaSmokePlan({
  candidateRoot,
  videoId = crypto.randomUUID(),
  env = process.env,
  cwd = PROJECT_ROOT,
  projectRoot = PROJECT_ROOT,
  fsApi = fs,
  execArgv = [],
} = {}) {
  if (!candidateRoot) throw new Error('disposable root was not generated');
  assertNoConflictingEnvironment(env);

  const candidate = path.resolve(candidateRoot);
  const isolatedEnv = {
    ...env,
    ISOLATED_TEST_MODE: 'true',
    ISOLATED_DESTRUCTIVE_TEST_MODE: 'false',
    ISOLATED_TEST_ROOT: candidate,
  };
  const isolation = createIsolationConfig({
    env: isolatedEnv,
    cwd,
    projectRoot,
    fsApi,
    execArgv,
  });
  if (!isolation.isIsolated || isolation.isDestructiveTest) {
    throw new Error('media smoke test requires non-destructive isolated mode');
  }

  assertMissingRoot(isolation.testRoot, fsApi);
  const paths = validateMediaSmokePaths({ isolation, testRoot: isolation.testRoot, videoId });
  return Object.freeze({ isolation, ...paths, paths: isolation.paths, videoId });
}

function assertPlainExecutable(filePath, expectedPath, label) {
  const absolute = path.resolve(filePath);
  if (absolute.toLowerCase() !== path.resolve(expectedPath).toLowerCase()) {
    throw new Error(`${label} did not resolve to the bundled executable`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || path.resolve(fs.realpathSync(absolute)).toLowerCase() !== absolute.toLowerCase()) {
    throw new Error(`${label} is not a plain bundled executable`);
  }
  return absolute;
}

function replaceProcessEnvironment({ systemRoot, tempDir, powershellDir, testRoot }) {
  const allowed = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: [powershellDir, path.join(systemRoot, 'System32')].join(path.delimiter),
    TEMP: tempDir,
    TMP: tempDir,
    MEDIA_SMOKE_LAUNCHER: '1',
    ISOLATED_TEST_MODE: 'true',
    ISOLATED_TEST_ROOT: testRoot,
    TTS_PROVIDER: 'local',
    TTS_PROVIDER_ORDER: 'windows-sapi',
    EDGE_TTS_DISABLED: 'true',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(allowed)) process.env[key] = value;
}

async function checkLocalExecutables({ ffmpegPath, ffprobePath, powershellPath, deadlines }) {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);
  const options = {
    timeout: boundedProcessTimeoutMs(15000, deadlines),
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  };

  const ffmpeg = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], options);
  const encoders = `${ffmpeg.stdout}\n${ffmpeg.stderr}`;
  if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) {
    throw new Error('bundled FFmpeg must provide libx264 and AAC encoders');
  }
  await execFileAsync(ffprobePath, ['-version'], {
    ...options,
    timeout: boundedProcessTimeoutMs(15000, deadlines),
  });

  const sapiCheck = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ru-RU' })",
    '$synth.Dispose()',
    "if ($voices.Count -lt 1) { throw 'No enabled ru-RU Windows SAPI voice is installed' }",
  ].join('; ');
  await execFileAsync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', sapiCheck], {
    ...options,
    timeout: boundedProcessTimeoutMs(15000, deadlines),
  });
}

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function writeSyntheticPng(filePath) {
  const width = 512;
  const height = 512;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      raw[offset++] = 22 + Math.floor((x / width) * 70);
      raw[offset++] = 60 + Math.floor((y / height) * 100);
      raw[offset++] = 90 + Math.floor(((x + y) / (width + height)) * 100);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, image, { flag: 'wx' });
  return image.length;
}

async function waitForCompletedJob(db, videoId, queue, deadlines, shutdownState) {
  const jobDeadlineAt = performance.now() + Math.min(240000, deadlines.workRemainingMs());
  while (deadlines.workRemainingMs() > 0 && performance.now() < jobDeadlineAt) {
    if (shutdownState.requested) {
      throw Object.assign(new Error('media smoke shutdown requested'), { code: 'MEDIA_SMOKE_SHUTDOWN' });
    }
    const video = db.prepare('SELECT status, video_file, error_message FROM videos WHERE id = ?').get(videoId);
    const job = db.prepare('SELECT status, error_message FROM generation_jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1').get(videoId);
    if (video?.status === 'failed' || job?.status === 'failed') {
      throw new Error(`synthetic generation failed: ${job?.error_message || video?.error_message || 'unknown error'}`);
    }
    if (video?.status === 'completed' && job?.status === 'completed' && !queue.isActive(videoId)) return video;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadlines.workRemainingMs())));
  }
  if (deadlines.workRemainingMs() <= 0) {
    throw Object.assign(new Error('media smoke work deadline exceeded'), { code: 'MEDIA_SMOKE_DEADLINE' });
  }
  throw new Error('synthetic generation timed out');
}

async function waitForQueueStop(queue, videoId, deadlines, shutdownState) {
  return waitForActivityToStop(
    () => Boolean(queue?.isActive(videoId)),
    deadlines,
    shutdownState,
  );
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createSyntheticRows(db, plan, ids, script, imageSize) {
  const timestamp = new Date().toISOString();
  const description = 'Синтетический тестовый продукт с ярким цветом и простым дизайном.';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      ids.userId,
      `media-smoke-${ids.userId}@example.invalid`,
      'Synthetic Media Smoke',
      'not-a-real-password',
      timestamp,
    );
    db.prepare('INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      ids.workspaceId,
      ids.userId,
      'Synthetic media smoke workspace',
      timestamp,
    );
    db.prepare('INSERT INTO projects (id, workspace_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run(
      ids.projectId,
      ids.workspaceId,
      'Synthetic media smoke project',
      'Disposable media pipeline verification',
      timestamp,
    );
    db.prepare('INSERT INTO brand_kits (id, project_id, brand_name, created_at) VALUES (?, ?, ?, ?)').run(
      ids.brandKitId,
      ids.projectId,
      'Synthetic Media Smoke',
      timestamp,
    );
    db.prepare('INSERT INTO files (id, workspace_id, filename, mime_type, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      ids.fileId,
      ids.workspaceId,
      path.basename(plan.imagePath),
      'image/png',
      imageSize,
      'synthetic-smoke.png',
      timestamp,
    );
    db.prepare(
      `INSERT INTO videos (id, workspace_id, project_id, client_request_id, title, product_name, product_description,
        price, cta, website_url, language, voice_type, style, category, script_hook, script_body, script_cta,
        script_source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '', 'ru', 'female', 'dynamic', 'product', ?, ?, ?, 'template', 'processing', ?, ?)`,
    ).run(
      ids.videoId,
      ids.workspaceId,
      ids.projectId,
      ids.videoId,
      'Synthetic media smoke',
      'Synthetic product',
      description,
      script.cta,
      script.hook,
      `${script.benefit1}\n${script.benefit2}`,
      script.cta,
      timestamp,
      timestamp,
    );
    db.prepare('INSERT INTO video_assets (id, video_id, file_id, asset_type, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      ids.assetId,
      ids.videoId,
      ids.fileId,
      'image',
      0,
      timestamp,
    );
    db.prepare(
      "INSERT INTO generation_jobs (id, video_id, status, progress, current_step, started_at, created_at) VALUES (?, ?, 'processing', 0, 'Queued', ?, ?)",
    ).run(ids.jobId, ids.videoId, timestamp, timestamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (process.env.MEDIA_SMOKE_LAUNCHER !== '1') {
    throw new Error('start this CLI only through scripts/run-media-smoke.ps1');
  }
  if (process.argv.length !== 2) throw new Error('command-line arguments are not accepted');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('this smoke entrypoint requires Windows x64');

  const parentEnv = { ...process.env };
  const systemRoot = parentEnv.SystemRoot || parentEnv.WINDIR;
  if (!systemRoot) throw new Error('Windows system root is unavailable');
  const deadlineAtMs = Number(parentEnv.MEDIA_SMOKE_DEADLINE_UTC_MS);
  const deadlines = createDeadlinePhases(deadlineAtMs, {
    shutdownGraceMs: Number(parentEnv.MEDIA_SMOKE_SHUTDOWN_GRACE_MS),
    verifyGraceMs: Number(parentEnv.MEDIA_SMOKE_VERIFY_GRACE_MS),
  });
  const shutdownState = createShutdownState();
  const onShutdownSignal = () => shutdownState.requestStop('ctrl_break');
  const candidateRoot = parentEnv.MEDIA_SMOKE_DISPOSABLE_ROOT;
  const rootProof = parentEnv.MEDIA_SMOKE_ROOT_PROOF;
  if (!candidateRoot) throw new Error('launcher did not provide the disposable root');
  if (!/^[0-9a-f]{32}$/i.test(rootProof || '')) throw new Error('launcher did not provide a valid root ownership proof');
  let plan;
  try {
    plan = createMediaSmokePlan({
      candidateRoot,
      env: parentEnv,
      cwd: PROJECT_ROOT,
      projectRoot: PROJECT_ROOT,
      execArgv: process.execArgv,
    });
  } catch (error) {
    reportSmokeFailure(candidateRoot, { rootCreated: false });
    throw error;
  }
  process.on('SIGBREAK', onShutdownSignal);
  let rootOwned = false;
  let db = null;
  let queue = null;
  let primaryError = null;
  let queueStopped = true;
  let shutdownRequestWritten = false;
  const writeShutdownRequestOnce = (reason) => {
    if (shutdownRequestWritten) return;
    writeShutdownRequest(plan, reason);
    shutdownRequestWritten = true;
  };

  try {
    const ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default;
    const ffprobeInstaller = (await import('@ffprobe-installer/ffprobe')).default;
    const platformPackage = `${process.platform}-${process.arch}`;
    const ffmpegPath = assertPlainExecutable(
      ffmpegInstaller.path,
      path.join(PROJECT_ROOT, 'node_modules', '@ffmpeg-installer', platformPackage, 'ffmpeg.exe'),
      'FFmpeg',
    );
    const ffprobePath = assertPlainExecutable(
      ffprobeInstaller.path,
      path.join(PROJECT_ROOT, 'node_modules', '@ffprobe-installer', platformPackage, 'ffprobe.exe'),
      'FFprobe',
    );
    const powershellDir = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    const powershellPath = assertPlainExecutable(
      path.join(powershellDir, 'powershell.exe'),
      path.join(powershellDir, 'powershell.exe'),
      'Windows PowerShell',
    );

    fs.mkdirSync(plan.testRoot);
    rootOwned = true;
    plan.isolation.assertPath(plan.ownershipMarkerPath);
    fs.writeFileSync(plan.ownershipMarkerPath, `${rootProof}\n`, { encoding: 'ascii', flag: 'wx' });
    plan.isolation.assertPath(plan.testRoot);
    const rootStat = fs.lstatSync(plan.testRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('created test root is not a plain directory');
    const directories = [
      plan.dataDir,
      plan.paths.uploadsDir,
      plan.paths.imagesDir,
      plan.paths.videosDir,
      plan.paths.tmpDir,
      plan.downloadDir,
      plan.systemTempDir,
    ];
    for (const directory of directories) {
      plan.isolation.assertPath(directory);
      fs.mkdirSync(directory);
    }

    replaceProcessEnvironment({ systemRoot, tempDir: plan.systemTempDir, powershellDir, testRoot: plan.testRoot });
    process.chdir(plan.testRoot);

    const media = await import('../server/media.js');
    const generation = await import('../server/generation.js');
    const content = await import('../server/content.js');
    const database = await import('../server/db.js');
    const cleanup = await import('../server/cleanup-policy.js');
    if (path.resolve(media.FFMPEG_BIN).toLowerCase() !== ffmpegPath.toLowerCase()) throw new Error('media module selected an unexpected FFmpeg path');
    if (path.resolve(media.FFPROBE_BIN).toLowerCase() !== ffprobePath.toLowerCase()) throw new Error('media module selected an unexpected FFprobe path');

    await checkLocalExecutables({ ffmpegPath, ffprobePath, powershellPath, deadlines });

    plan.isolation.assertPath(plan.paths.databaseFile);
    db = database.openDatabase(plan.paths.databaseFile);
    plan.isolation.assertPath(plan.imagePath);
    const imageSize = writeSyntheticPng(plan.imagePath);

    const ids = {
      userId: database.newId(),
      workspaceId: database.newId(),
      projectId: database.newId(),
      brandKitId: database.newId(),
      fileId: database.newId(),
      videoId: plan.videoId,
      assetId: database.newId(),
      jobId: database.newId(),
    };
    const input = {
      productName: 'Synthetic product',
      description: 'Синтетический тестовый продукт с ярким цветом и простым дизайном.',
      cta: 'Узнайте подробнее',
      language: 'ru',
      style: 'dynamic',
      category: 'product',
    };
    const generated = content.generateTemplateScript(input);
    createSyntheticRows(db, plan, ids, generated.script, imageSize);

    queue = generation.createGenerationQueue({
      db,
      imagesDir: plan.paths.imagesDir,
      videosDir: plan.paths.videosDir,
      tmpDir: plan.paths.tmpDir,
      cleanupPolicy: cleanup.readCleanupPolicy({}),
      generateScriptImpl: async (scriptInput) => {
        const result = content.generateTemplateScript(scriptInput);
        return { script: result.script, source: { id: 'template' } };
      },
    });
    queue.enqueue(ids.videoId);
    const video = await waitForCompletedJob(db, ids.videoId, queue, deadlines, shutdownState);
    const outputPath = plan.isolation.assertPath(path.join(plan.paths.videosDir, video.video_file));
    if (path.resolve(outputPath) !== path.resolve(plan.outputPath)) {
      throw new Error('generation published outside the expected synthetic output path');
    }

    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size < 20 * 1024) throw new Error(`MP4 output is missing or too small (${stat.size} bytes)`);
    const { execFile } = await import('node:child_process');
    const execFileAsync = promisify(execFile);
    const probe = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath],
      {
        timeout: boundedProcessTimeoutMs(20000, deadlines),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const metadata = JSON.parse(probe.stdout);
    const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = metadata.streams?.find((stream) => stream.codec_type === 'audio');
    const durationSec = Number(metadata.format?.duration || 0);
    if (!videoStream || videoStream.codec_name !== 'h264') throw new Error('ffprobe did not find an H.264 video stream');
    if (!audioStream || audioStream.codec_name !== 'aac') throw new Error('ffprobe did not find an AAC audio stream');
    if (videoStream.width !== 1080 || videoStream.height !== 1920) throw new Error('ffprobe reported an unexpected video resolution');
    if (!Number.isFinite(durationSec) || durationSec < 14 || durationSec > 16) throw new Error(`ffprobe reported unexpected duration: ${durationSec}`);

    plan.isolation.assertPath(plan.downloadPath);
    await pipeline(fs.createReadStream(outputPath), fs.createWriteStream(plan.downloadPath, { flags: 'wx' }));
    if (sha256File(outputPath) !== sha256File(plan.downloadPath)) throw new Error('local download-copy verification failed');

    const report = {
      result: 'verified',
      projectId: ids.projectId,
      videoId: ids.videoId,
      mp4Path: outputPath,
      manifestPath: plan.manifestPath,
      reportPath: plan.reportPath,
      sizeBytes: stat.size,
      durationSec,
      resolution: `${videoStream.width}x${videoStream.height}`,
      videoCodec: videoStream.codec_name,
      audioCodec: audioStream.codec_name,
      audioKind: db.prepare('SELECT audio_kind FROM videos WHERE id = ?').get(ids.videoId).audio_kind,
      byteCopyVerified: true,
      apiDownloadEndpointTested: false,
      disposableRoot: plan.testRoot,
    };
    const manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      disposableRoot: plan.testRoot,
      databaseFile: plan.paths.databaseFile,
      projectId: ids.projectId,
      workspaceId: ids.workspaceId,
      videoId: ids.videoId,
      imagePath: plan.imagePath,
      mp4Path: outputPath,
      downloadCopyPath: plan.downloadPath,
      reportPath: plan.reportPath,
    };
    plan.isolation.assertPath(plan.manifestPath);
    fs.writeFileSync(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    plan.isolation.assertPath(plan.reportPath);
    fs.writeFileSync(plan.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    primaryError = error;
  } finally {
    if (primaryError && rootOwned) {
      try {
        writeShutdownRequestOnce(shutdownState.requested ? 'shutdown_requested' : 'harness_failure');
      } catch (requestError) {
        console.warn(`[MEDIA SMOKE] shutdown request marker failed (${requestError.code || 'unknown'})`);
      }
    }
    try {
      queueStopped = await waitForQueueStop(queue, plan.videoId, deadlines, shutdownState);
      if (!queueStopped && !primaryError) {
        primaryError = Object.assign(new Error('generation queue did not stop before the harness deadline'), {
          code: 'MEDIA_SMOKE_QUEUE_SHUTDOWN_TIMEOUT',
        });
        if (rootOwned) {
          try {
            writeShutdownRequestOnce('queue_shutdown_timeout');
          } catch (requestError) {
            console.warn(`[MEDIA SMOKE] shutdown request marker failed (${requestError.code || 'unknown'})`);
          }
        }
      }
    } catch (shutdownError) {
      queueStopped = false;
      if (!primaryError) primaryError = shutdownError;
      else console.warn(`[MEDIA SMOKE] queue shutdown wait failed (${shutdownError.code || 'unknown'})`);
      if (rootOwned) {
        try {
          writeShutdownRequestOnce('queue_shutdown_timeout');
        } catch (requestError) {
          console.warn(`[MEDIA SMOKE] shutdown request marker failed (${requestError.code || 'unknown'})`);
        }
      }
    }
    if (db && queueStopped) {
      try {
        db.close();
      } catch (closeError) {
        if (!primaryError) primaryError = closeError;
        else console.warn(`[MEDIA SMOKE] synthetic database close failed (${closeError.code || 'unknown'})`);
      }
    } else if (db) {
      console.warn('[MEDIA SMOKE] synthetic database left open for bounded supervisor termination');
    }
    process.removeListener('SIGBREAK', onShutdownSignal);
  }

  if (primaryError) {
    reportSmokeFailure(plan.testRoot, { rootCreated: rootOwned });
    throw primaryError;
  }
  if (!queueStopped) throw new Error('generation queue shutdown was not verified');
}

if (path.resolve(process.argv[1] || '') === path.resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`[MEDIA SMOKE] ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
