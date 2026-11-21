import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createImageGenerator, ImageGenerationError } from '../server/ai/image-generation.js';
import { createRateLimiter } from '../server/rate-limit.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const input = {
  productName: 'Чай',
  description: 'Зелёный чай с жасмином',
  style: 'premium',
  category: 'product',
};

test('image generator sends a bounded OpenAI Images request and returns PNG bytes', async () => {
  let request;
  const generator = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    },
  });

  const result = await generator.generate(input);
  const body = JSON.parse(request.options.body);
  assert.equal(generator.isConfigured(), true);
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-key');
  assert.equal(body.model, 'gpt-image-1');
  assert.match(body.prompt, /Зелёный чай с жасмином/);
  assert.deepEqual(result, png);
});

test('image generator rejects missing configuration without making a request', async () => {
  let called = false;
  const generator = createImageGenerator({
    fetchImpl: async () => {
      called = true;
      throw new Error('must not be called');
    },
  });

  await assert.rejects(generator.generate(input), (err) => err instanceof ImageGenerationError && err.code === 'not_configured');
  assert.equal(called, false);
});

test('image generator reports provider errors without exposing upstream response content', async () => {
  const generator = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private upstream detail' } }), { status: 401 }),
  });

  await assert.rejects(
    generator.generate(input),
    (err) => err instanceof ImageGenerationError && err.status === 503 && !err.message.includes('private upstream detail'),
  );
});

test('image generator maps timeout and network failures without exposing request credentials', async () => {
  const timeoutGenerator = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => {
      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  await assert.rejects(
    timeoutGenerator.generate(input),
    (err) => err instanceof ImageGenerationError && err.code === 'timeout' && err.status === 504 && !err.message.includes('synthetic-key'),
  );

  const networkGenerator = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => {
      throw new Error('connection failed');
    },
  });
  await assert.rejects(
    networkGenerator.generate(input),
    (err) => err instanceof ImageGenerationError && err.code === 'network' && err.status === 502 && !err.message.includes('synthetic-key'),
  );
});

test('image generator rejects malformed JSON and missing image data', async () => {
  const malformedJson = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response('{invalid json', { status: 200 }),
  });
  await assert.rejects(
    malformedJson.generate(input),
    (err) => err instanceof ImageGenerationError && err.code === 'bad_response',
  );

  const missingImage = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 }),
  });
  await assert.rejects(
    missingImage.generate(input),
    (err) => err instanceof ImageGenerationError && err.code === 'bad_response',
  );
});

test('image generator rejects non-PNG and oversized responses', async () => {
  const wrongFormat = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not png').toString('base64') }] }), { status: 200 }),
  });
  await assert.rejects(wrongFormat.generate(input), (err) => err instanceof ImageGenerationError && err.code === 'bad_response');

  const oversized = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: 'A'.repeat(14 * 1024 * 1024) }] }), { status: 200 }),
  });
  await assert.rejects(oversized.generate(input), (err) => err instanceof ImageGenerationError && err.code === 'bad_response');
});

test('image-generation quota limits a workspace and keeps other workspaces independent', () => {
  const db = new DatabaseSync(':memory:');
  const originalNow = Date.now;
  let now = 1_700_000_000_000;

  try {
    const limiter = createRateLimiter(db);
    Date.now = () => now++;

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(
        limiter.hit({ bucket: 'image-generation', key: 'workspace-a', limit: 5, windowMs: 60 * 60 * 1000 }).allowed,
        true,
      );
    }
    assert.equal(
      limiter.hit({ bucket: 'image-generation', key: 'workspace-a', limit: 5, windowMs: 60 * 60 * 1000 }).allowed,
      false,
    );
    assert.equal(
      limiter.hit({ bucket: 'image-generation', key: 'workspace-b', limit: 5, windowMs: 60 * 60 * 1000 }).allowed,
      true,
    );
  } finally {
    Date.now = originalNow;
    db.close();
  }
});
