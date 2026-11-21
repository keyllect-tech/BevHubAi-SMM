const IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const IMAGE_MODEL = 'gpt-image-1';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class ImageGenerationError extends Error {
  constructor(code, message, status, cause) {
    super(message);
    this.name = 'ImageGenerationError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export function createImageGenerator({ apiKey, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  return {
    isConfigured: () => Boolean(apiKey),

    async generate({ productName, description, style, category }) {
      if (!apiKey) {
        throw new ImageGenerationError('not_configured', 'Генерация изображений не настроена', 503);
      }

      const prompt = [
        'Create one polished, photorealistic vertical advertising image for a short product video.',
        `Product: ${productName}`,
        `Description: ${description}`,
        `Visual style: ${style}`,
        `Category: ${category}`,
        'Show the product clearly with a clean composition and suitable background.',
        'Do not include text, captions, logos, watermarks, borders, or collages.',
      ].join('\n');

      let response;
      try {
        response = await fetchImpl(IMAGE_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1024x1024' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new ImageGenerationError(
          timedOut ? 'timeout' : 'network',
          timedOut ? 'Генерация изображения заняла слишком много времени' : 'Сервис генерации изображений недоступен',
          timedOut ? 504 : 502,
          err,
        );
      }

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 503;
        const code = response.status === 429 ? 'rate_limit' : response.status === 401 || response.status === 403 ? 'auth' : 'provider';
        throw new ImageGenerationError(code, 'Сервис генерации изображений отклонил запрос', status);
      }

      const encoded = data?.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_BASE64_LENGTH || !BASE64_RE.test(encoded)) {
        throw new ImageGenerationError('bad_response', 'Сервис вернул некорректное изображение', 502);
      }

      const image = Buffer.from(encoded, 'base64');
      if (image.length > MAX_IMAGE_BYTES || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new ImageGenerationError('bad_response', 'Сервис вернул неподдерживаемый формат изображения', 502);
      }
      return image;
    },
  };
}
