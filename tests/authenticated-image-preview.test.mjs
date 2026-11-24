import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedImagePreview } from '../src/lib/authenticated-image-preview.mjs';

const IMAGE_FIXTURES = [
  ['image/jpeg', [0xff, 0xd8, 0xff, 0x00]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]],
];

function createUrlApi() {
  const created = [];
  const revoked = [];
  return {
    created,
    revoked,
    urlImpl: {
      createObjectURL(blob) {
        created.push(blob);
        return `blob:preview-${created.length}`;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  };
}

for (const [mimeType, bytes] of IMAGE_FIXTURES) {
  test(`authenticated preview loads ${mimeType} with credentials and revokes its object URL`, async () => {
    const urls = createUrlApi();
    let request;
    const preview = await createAuthenticatedImagePreview('/api/files/test-id', {
      urlImpl: urls.urlImpl,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(new Uint8Array(bytes), { headers: { 'content-type': `${mimeType}; charset=binary` } });
      },
    });

    assert.equal(request.url, '/api/files/test-id');
    assert.equal(request.options.credentials, 'include');
    assert.equal(urls.created[0].type, mimeType);
    assert.equal(preview.warning, null);
    assert.equal(preview.objectUrl, 'blob:preview-1');
    preview.dispose();
    preview.dispose();
    assert.deepEqual(urls.revoked, ['blob:preview-1']);
  });
}

test('authenticated preview exposes the protected file endpoint HTTP error', async () => {
  const urls = createUrlApi();
  await assert.rejects(
    createAuthenticatedImagePreview('/api/files/missing', {
      urlImpl: urls.urlImpl,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Файл не найден' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /HTTP 404: Файл не найден/,
  );
  assert.equal(urls.created.length, 0);
});

test('authenticated preview corrects a wrong response MIME from the image signature', async () => {
  const urls = createUrlApi();
  const preview = await createAuthenticatedImagePreview('/api/files/wrong-mime', {
    urlImpl: urls.urlImpl,
    fetchImpl: async () => new Response(new Uint8Array(IMAGE_FIXTURES[1][1]), {
      headers: { 'content-type': 'application/octet-stream' },
    }),
  });

  assert.equal(urls.created[0].type, 'image/png');
  assert.match(preview.warning, /application\/octet-stream.*image\/png/);
  preview.dispose();
});

test('authenticated preview reports non-image and empty success responses instead of showing broken alt text', async (t) => {
  for (const [label, body, expected] of [
    ['non-image body', 'not an image', /Ответ не является JPG, PNG или WEBP/],
    ['empty body', new Uint8Array(), /пустое изображение/],
  ]) {
    await t.test(label, async () => {
      const urls = createUrlApi();
      await assert.rejects(
        createAuthenticatedImagePreview('/api/files/bad', {
          urlImpl: urls.urlImpl,
          fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/webp' } }),
        }),
        expected,
      );
      assert.equal(urls.created.length, 0);
    });
  }
});

test('authenticated preview describes browser-blocked requests without leaking low-level details', async () => {
  const urls = createUrlApi();
  await assert.rejects(
    createAuthenticatedImagePreview('/api/files/test-id', {
      urlImpl: urls.urlImpl,
      fetchImpl: async () => {
        throw new TypeError('CORS failure with private implementation detail');
      },
    }),
    (error) => {
      assert.match(error.message, /сетью, CORS или политикой cookies/);
      assert.doesNotMatch(error.message, /private implementation detail/);
      return true;
    },
  );
});
