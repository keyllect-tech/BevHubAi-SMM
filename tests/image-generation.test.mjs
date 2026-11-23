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

test('image generator uses OpenRouter default model and returns PNG bytes from b64_json', async () => {
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
  assert.equal(request.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-key');
  assert.equal(body.model, 'openai/gpt-image-2');
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.output_format, 'png');
  assert.match(body.prompt, /Зелёный чай с жасмином/);
  assert.deepEqual(result, png);
});

test('image generator accepts an explicitly configured model', async () => {
  let requestBody;
  const generator = createImageGenerator({
    apiKey: 'synthetic-key',
    model: 'openai/gpt-image-2.6',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    },
  });

  await generator.generate(input);
  assert.equal(requestBody.model, 'openai/gpt-image-2.6');
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

test('image generator classifies a retired or unknown model as an invalid upstream request', async () => {
  const generator = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'private upstream detail' } }), { status: 404 }),
  });

  await assert.rejects(
    generator.generate(input),
    (err) =>
      err instanceof ImageGenerationError &&
      err.code === 'invalid_request' &&
      err.status === 502 &&
      err.upstreamStatus === 404 &&
      !err.message.includes('private upstream detail') &&
      !err.message.includes('synthetic-key'),
  );
});

test('image generator classifies upstream authorization failures without exposing response content', async () => {
  for (const upstreamStatus of [401, 403]) {
    const generator = createImageGenerator({
      apiKey: 'synthetic-key',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'private upstream detail' } }), {
          status: upstreamStatus,
        }),
    });

    await assert.rejects(
      generator.generate(input),
      (err) =>
        err instanceof ImageGenerationError &&
        err.code === 'auth' &&
        err.status === 502 &&
        err.upstreamStatus === upstreamStatus &&
        !err.message.includes('private upstream detail') &&
        !err.message.includes('synthetic-key'),
    );
  }
});

test('image generator preserves rate-limit status and classifies provider failures', async () => {
  const rateLimited = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private upstream detail' } }), { status: 429 }),
  });
  await assert.rejects(
    rateLimited.generate(input),
    (err) =>
      err instanceof ImageGenerationError &&
      err.code === 'rate_limit' &&
      err.status === 429 &&
      err.upstreamStatus === 429 &&
      !err.message.includes('private upstream detail'),
  );

  const providerFailed = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private upstream detail' } }), { status: 503 }),
  });
  await assert.rejects(
    providerFailed.generate(input),
    (err) =>
      err instanceof ImageGenerationError &&
      err.code === 'provider' &&
      err.status === 502 &&
      err.upstreamStatus === 503 &&
      !err.message.includes('private upstream detail'),
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

test('image generator rejects invalid base64 data', async () => {
  const generator = createImageGenerator({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: 'not-valid-base64!' }] }), { status: 200 }),
  });

  await assert.rejects(
    generator.generate(input),
    (err) => err instanceof ImageGenerationError && err.code === 'bad_response' && err.status === 502,
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
