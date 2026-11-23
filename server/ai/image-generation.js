const IMAGE_ENDPOINT = 'https://openrouter.ai/api/v1/images';
const DEFAULT_IMAGE_MODEL = 'recraft/recraft-v4.1-flash-v2:free';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function detectImageType(image) {
  if (image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (image.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'image/jpeg';
  if (image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export class ImageGenerationError extends Error {
  constructor(code, message, status, cause, upstreamStatus) {
    super(message);
    this.name = 'ImageGenerationError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

function classifyProviderError(status) {
  if (status === 402) {
    return {
      code: 'payment_required',
      message: 'OpenRouter отклонил запрос: платёжное ограничение или исчерпан лимит бесплатного доступа. Платная модель не будет выбрана.',
      status: 402,
    };
  }
  if (status === 401 || status === 403) {
    return { code: 'auth', message: 'Сервис генерации изображений отклонил авторизацию', status: 502 };
  }
  if (status === 404) {
    return {
      code: 'model_unavailable',
      message: 'Бесплатная модель или endpoint OpenRouter недоступны. Платный fallback отключён.',
      status: 404,
    };
  }
  if (status === 400 || status === 422) {
    return { code: 'invalid_request', message: 'OpenRouter отклонил параметры запроса', status: 502 };
  }
  if (status === 429) {
    return { code: 'rate_limit', message: 'Лимит запросов сервиса генерации изображений исчерпан. Попробуйте позже.', status: 429 };
  }
  return { code: 'provider', message: 'Сервис генерации изображений временно недоступен', status: 502 };
}

export function createImageGenerator({ apiKey, model = DEFAULT_IMAGE_MODEL, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  const selectedModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_IMAGE_MODEL;
  const configuredApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';

  return {
    isConfigured: () => Boolean(configuredApiKey),

    async generate({ productName, description, style, category }) {
      if (!configuredApiKey) {
        throw new ImageGenerationError('not_configured', 'Генерация изображений не настроена', 503);
      }
      if (!selectedModel.endsWith(':free')) {
        throw new ImageGenerationError(
          'paid_model_blocked',
          'Разрешены только модели OpenRouter с вариантом :free. Платная генерация отключена.',
          503,
        );
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
            Authorization: `Bearer ${configuredApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: selectedModel,
            prompt,
            aspect_ratio: '9:16',
            provider: { allow_fallbacks: false },
          }),
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
        const error = classifyProviderError(response.status);
        throw new ImageGenerationError(error.code, error.message, error.status, undefined, response.status);
      }

      const generatedImage = data?.data?.[0];
      const encoded = generatedImage?.b64_json;
      if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_BASE64_LENGTH || !BASE64_RE.test(encoded)) {
        throw new ImageGenerationError('bad_response', 'Сервис вернул некорректное изображение', 502);
      }

      const image = Buffer.from(encoded, 'base64');
      if (image.length > MAX_IMAGE_BYTES) {
        throw new ImageGenerationError('bad_response', 'Сервис вернул неподдерживаемый формат изображения', 502);
      }

      const detectedType = detectImageType(image);
      const reportedType = typeof generatedImage.media_type === 'string'
        ? generatedImage.media_type.split(';', 1)[0].trim().toLowerCase()
        : null;
      if (!detectedType || (reportedType && reportedType !== detectedType)) {
        throw new ImageGenerationError('bad_response', 'Сервис вернул неподдерживаемый формат изображения', 502);
      }
      return { image, mimeType: detectedType };
    },
  };
}
