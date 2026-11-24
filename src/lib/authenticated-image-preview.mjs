const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function detectImageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function responseError(response) {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) return '';
  const body = await response.json().catch(() => null);
  return typeof body?.error === 'string' ? body.error.trim().slice(0, 240) : '';
}

export async function createAuthenticatedImagePreview(src, {
  signal,
  fetchImpl = fetch,
  urlImpl = URL,
} = {}) {
  let response;
  try {
    response = await fetchImpl(src, { credentials: 'include', signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error('Не удалось загрузить изображение: запрос заблокирован сетью, CORS или политикой cookies.');
  }

  if (!response.ok) {
    const detail = await responseError(response);
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const reportedType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
  const responseBlob = await response.blob();
  const bytes = new Uint8Array(await responseBlob.arrayBuffer());
  if (bytes.length === 0) throw new Error('Сервер вернул пустое изображение (HTTP 200).');

  const actualType = detectImageType(bytes);
  if (!actualType || !IMAGE_TYPES.has(actualType)) {
    throw new Error(`Ответ не является JPG, PNG или WEBP (HTTP 200, Content-Type: ${reportedType || 'не указан'}).`);
  }

  const blob = responseBlob.type === actualType ? responseBlob : new Blob([bytes], { type: actualType });
  const objectUrl = urlImpl.createObjectURL(blob);
  let disposed = false;
  return {
    objectUrl,
    warning: reportedType !== actualType
      ? `Content-Type ${reportedType || 'не указан'} не совпадает с форматом файла ${actualType}.`
      : null,
    dispose() {
      if (disposed) return;
      disposed = true;
      urlImpl.revokeObjectURL(objectUrl);
    },
  };
}
