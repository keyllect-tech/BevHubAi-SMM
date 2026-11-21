import { LANGUAGES, VIDEO_STYLES, VOICE_TYPES, type VideoScript } from '../types/index.ts';

export interface CreateVideoValidationInput {
  productName: string;
  productDescription: string;
  cta: string;
  websiteUrl: string;
  images: Array<{ id: string }>;
  uploading: boolean;
  generatingImage: boolean;
  language: string;
  voiceType: string;
  style: string;
  scriptData: VideoScript | null;
}

export interface CreateVideoValidationIssue {
  step: number;
  message: string;
}

export interface ValidCreateVideoInput extends Omit<CreateVideoValidationInput, 'scriptData'> {
  scriptData: VideoScript;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidScript(script: VideoScript | null): script is VideoScript {
  return Boolean(
    script
      && typeof script.hook === 'string' && script.hook.trim()
      && typeof script.benefit1 === 'string' && script.benefit1.trim()
      && typeof script.benefit2 === 'string' && script.benefit2.trim()
      && typeof script.cta === 'string' && script.cta.trim(),
  );
}

export function validateWizardStep(
  step: number,
  input: CreateVideoValidationInput,
): CreateVideoValidationIssue | null {
  switch (step) {
    case 0:
      if (!input.productName.trim()) return { step: 0, message: 'Укажите название товара или услуги.' };
      if (!input.productDescription.trim()) return { step: 0, message: 'Добавьте описание товара или услуги.' };
      if (!input.cta.trim()) return { step: 0, message: 'Укажите призыв к действию.' };
      if (input.websiteUrl.trim()) {
        try {
          const url = new URL(input.websiteUrl.trim());
          if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
            return { step: 0, message: 'Адрес сайта должен начинаться с http:// или https://.' };
          }
        } catch {
          return { step: 0, message: 'Введите корректный адрес сайта с http:// или https://.' };
        }
      }
      return null;
    case 1:
      if (input.images.length === 0) return { step: 1, message: 'Загрузите хотя бы одно фото товара.' };
      if (input.images.some((image) => typeof image.id !== 'string' || !UUID_PATTERN.test(image.id))) {
        return { step: 1, message: 'Одно из фото загружено некорректно. Удалите его и загрузите снова.' };
      }
      if (input.uploading || input.generatingImage) {
        return { step: 1, message: 'Дождитесь завершения загрузки или генерации фото.' };
      }
      return null;
    case 2:
      if (!LANGUAGES.some((item) => item.id === input.language)) {
        return { step: 2, message: 'Выберите поддерживаемый язык: русский, узбекский или английский.' };
      }
      if (!VOICE_TYPES.some((item) => item.id === input.voiceType)) {
        return { step: 2, message: 'Выберите поддерживаемый тип голоса.' };
      }
      return null;
    case 3:
      if (!VIDEO_STYLES.some((item) => item.id === input.style)) {
        return { step: 3, message: 'Выберите поддерживаемый стиль видео.' };
      }
      return null;
    case 4: {
      const validation = validateCreateVideo(input);
      return validation.valid ? null : validation.issue;
    }
    default:
      return { step: 0, message: 'Проверьте данные объявления.' };
  }
}

export function validateCreateVideo(
  input: CreateVideoValidationInput,
): { valid: true; data: ValidCreateVideoInput } | { valid: false; issue: CreateVideoValidationIssue } {
  for (const step of [0, 1, 2, 3]) {
    const issue = validateWizardStep(step, input);
    if (issue) return { valid: false, issue };
  }
  if (!isValidScript(input.scriptData)) {
    return {
      valid: false,
      issue: { step: 4, message: 'Сценарий не создан или неполный. Повторите генерацию сценария.' },
    };
  }
  return { valid: true, data: { ...input, scriptData: input.scriptData } };
}

export async function submitCreateVideo<T>(
  input: CreateVideoValidationInput,
  submit: (data: ValidCreateVideoInput) => Promise<T>,
): Promise<{ valid: true; result: T } | { valid: false; issue: CreateVideoValidationIssue }> {
  const validation = validateCreateVideo(input);
  if (!validation.valid) return validation;
  return { valid: true, result: await submit(validation.data) };
}
