import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateImageDecodes, IMAGE_VALIDATION_STAGE } from '../server/media.js';

function makeStructurallyValidFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgval-'));
  const file = path.join(dir, 'ok.png');
  const buf = Buffer.alloc(68, 0x00);
  Buffer.from('IEND').copy(buf, 64);
  fs.writeFileSync(file, buf);
  return { file, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function createMockExecFile({ ffprobeBehavior, ffmpegBehavior }) {
  return async (bin, args, options) => {
    if (args && args.includes('-show_entries')) {
      return ffprobeBehavior(bin, args, options);
    }
    return ffmpegBehavior(bin, args, options);
  };
}

test('validateImageDecodes: successful validation passes and logs nothing', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: JSON.stringify({ streams: [{ width: 512, height: 512 }] }) }),
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) });
    assert.deepEqual(diagnostics, []);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: ffprobe failure logs IMAGE_FFPROBE_FAILED and throws generic error', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => { const err = new Error('ffprobe crashed'); err.code = 1; err.stderr = 'ffprobe: error parsing'; throw err; },
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.FFPROBE);
    assert.equal(diagnostics[0].code, 1);
    assert.equal(diagnostics[0].stderr, 'ffprobe: error parsing');
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: missing dimensions logs IMAGE_DIMENSIONS_INVALID and throws generic error', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: JSON.stringify({ streams: [{}] }) }),
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.DIMENSIONS);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: ffmpeg failure logs IMAGE_FFMPEG_FAILED and throws generic error', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: JSON.stringify({ streams: [{ width: 512, height: 512 }] }) }),
    ffmpegBehavior: async () => { const err = new Error('ffmpeg decode error'); err.code = 1; err.stderr = Buffer.from('Invalid data found'); throw err; },
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.FFMPEG);
    assert.equal(diagnostics[0].code, 1);
    assert.equal(diagnostics[0].stderr, 'Invalid data found');
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: structure failure logs IMAGE_STRUCTURE_FAILED', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgval-'));
  const file = path.join(dir, 'bad.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // just signature, no IEND
  const diagnostics = [];
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или загружено не полностью'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.STRUCTURE);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: diagnostic logger throwing does not mask original error', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => { const err = new Error('ffprobe crashed'); err.code = 1; err.stderr = 'err'; throw err; },
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  const throwingLogger = () => { throw new Error('logger exploded'); };
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: throwingLogger }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: ENOENT marks error as internal (500)', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => { const err = new Error('not found'); err.code = 'ENOENT'; err.path = '/fake/ffprobe'; throw err; },
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.internal === true && err.message.includes('FFmpeg/FFprobe binary not found')
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.FFPROBE);
    assert.equal(diagnostics[0].code, 'ENOENT');
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: ffprobe returns empty streams logs IMAGE_DIMENSIONS_INVALID', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: JSON.stringify({ streams: [] }) }),
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.DIMENSIONS);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: ffprobe returns invalid JSON logs IMAGE_FFPROBE_FAILED', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: 'not json' }),
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.FFPROBE);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: dimension too small logs IMAGE_DIMENSIONS_INVALID', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: JSON.stringify({ streams: [{ width: 100, height: 100 }] }) }),
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение слишком маленькое (минимум 200×200)'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.DIMENSIONS);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: dimension too large logs IMAGE_DIMENSIONS_INVALID', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => ({ stdout: JSON.stringify({ streams: [{ width: 20000, height: 20000 }] }) }),
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение слишком большое (максимум 12000px)'
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, IMAGE_VALIDATION_STAGE.DIMENSIONS);
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: Windows paths masked in diagnostic stderr', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => { const err = new Error('fail'); err.code = 1; err.stderr = 'error at C:\\temp\\upload.png: bad'; throw err; },
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.ok(!diagnostics[0].stderr.includes('C:'), 'Windows path should be masked');
    assert.ok(diagnostics[0].stderr.includes('<path>'), 'Should contain <path> placeholder');
  } finally {
    cleanup(dir);
  }
});

test('validateImageDecodes: Unix paths masked in diagnostic stderr', async () => {
  const { file, dir } = makeStructurallyValidFile();
  const diagnostics = [];
  const execFile = createMockExecFile({
    ffprobeBehavior: async () => { const err = new Error('fail'); err.code = 1; err.stderr = 'error at /tmp/upload.png: bad'; throw err; },
    ffmpegBehavior: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(
      () => validateImageDecodes(file, 'image/png', { execFile, logDiagnostic: (d) => diagnostics.push(d) }),
      (err) => err.message === 'Изображение повреждено или не читается'
    );
    assert.equal(diagnostics.length, 1);
    assert.ok(!diagnostics[0].stderr.includes('/tmp/'), 'Unix path should be masked');
    assert.ok(diagnostics[0].stderr.includes('<path>'), 'Should contain <path> placeholder');
  } finally {
    cleanup(dir);
  }
});
