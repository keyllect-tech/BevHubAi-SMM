export interface User {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export interface Workspace {
  id: string;
  user_id: string;
  name: string;
  demo_mode: boolean;
  created_at: string;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  created_at: string;
}

export interface BrandKit {
  id: string;
  project_id: string;
  brand_name: string;
  logo_url: string;
  primary_color: string;
  secondary_color: string;
  default_language: string;
  default_cta: string;
  created_at: string;
}

export type VideoStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Video {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  product_name: string;
  product_description: string;
  price: string;
  cta: string;
  website_url: string;
  language: string;
  voice_type: string;
  style: string;
  category: string;
  script_hook: string;
  /** Both benefits, separated by a newline. */
  script_body: string;
  script_cta: string;
  script_source: string;
  audio_kind: string;
  status: VideoStatus;
  video_url: string;
  thumbnail_url: string;
  duration_sec: number;
  error_message: string;
  created_at: string;
}

export interface VideoAsset {
  id: string;
  video_id: string;
  file_id: string;
  file_url: string;
  asset_type: string;
  sort_order: number;
  created_at: string;
}

export interface GenerationJob {
  status: string;
  progress: number;
  current_step: string;
  error_message: string;
  started_at: string;
  completed_at: string | null;
}

export interface Subscription {
  plan: string;
  monthly_limit: number;
  status: string;
  created_at: string;
}

export interface Usage {
  month_start: string;
  videos_created: number;
}

export interface VideoScript {
  hook: string;
  benefit1: string;
  benefit2: string;
  cta: string;
}

export const GENERATION_STEPS = [
  'Queued',
  'Analyzing product',
  'Writing script',
  'Generating voice',
  'Creating video',
  'Adding subtitles',
  'Finalizing',
] as const;

export const AD_CATEGORIES = [
  { id: 'product', name: 'Товар', title: 'Название товара', titleHint: 'iPhone 15 Pro, кроссовки Nike…', descHint: 'Чем хорош товар: особенности, материалы, для кого он…' },
  { id: 'realty', name: 'Недвижимость', title: 'Объект', titleHint: 'Офис 120 м² в центре', descHint: 'Продажа или аренда, площадь, район, этаж, ремонт, парковка…' },
  { id: 'food', name: 'Ресторан / кафе', title: 'Название заведения', titleHint: 'Кафе «Самарканд»', descHint: 'Кухня, фирменные блюда, атмосфера, доставка, адрес…' },
  { id: 'shop', name: 'Магазин', title: 'Название магазина', titleHint: 'Магазин электроники «Техно»', descHint: 'Что продаёте, ассортимент, акции, адрес…' },
  { id: 'service', name: 'Услуги', title: 'Услуга', titleHint: 'Ремонт квартир под ключ', descHint: 'Что делаете, опыт, сроки, чем вы лучше…' },
  { id: 'job', name: 'Вакансия', title: 'Вакансия', titleHint: 'Junior-программист', descHint: 'Компания, обязанности, условия, график, зарплата…' },
  { id: 'event', name: 'Мероприятие', title: 'Мероприятие', titleHint: 'Мастер-класс по фотографии', descHint: 'Когда и где, программа, для кого, как попасть…' },
  { id: 'other', name: 'Другое', title: 'Заголовок', titleHint: 'О чём ваша реклама', descHint: 'Опишите, что нужно прорекламировать…' },
] as const;

/** Pre-filled call to action per ad type and language (matches the server's templates). */
export const CATEGORY_CTA: Record<string, Record<string, string>> = {
  product: { ru: 'Закажите сейчас', uz: 'Hozir buyurtma qiling', en: 'Order now' },
  realty: { ru: 'Запишитесь на просмотр', uz: 'Koʻrishga yoziling', en: 'Book a viewing' },
  food: { ru: 'Забронируйте столик', uz: 'Stol band qiling', en: 'Reserve a table' },
  shop: { ru: 'Приходите в магазин', uz: 'Doʻkonga keling', en: 'Visit the store' },
  service: { ru: 'Оставьте заявку', uz: 'Ariza qoldiring', en: 'Leave a request' },
  job: { ru: 'Откликнитесь сейчас', uz: 'Hoziroq javob bering', en: 'Apply now' },
  event: { ru: 'Зарегистрируйтесь', uz: 'Roʻyxatdan oʻting', en: 'Register now' },
  other: { ru: 'Узнать подробнее', uz: 'Batafsil bilish', en: 'Learn more' },
};

export const VIDEO_STYLES = [
  { id: 'product', name: 'Реклама товара', desc: 'Чистая рекламная подача' },
  { id: 'dynamic', name: 'Динамичный', desc: 'Быстрый TikTok/Reels стиль' },
  { id: 'premium', name: 'Премиум', desc: 'Премиальный рекламный ролик' },
  { id: 'ugc', name: 'UGC', desc: 'Стиль пользовательского контента' },
] as const;

export const LANGUAGES = [
  { id: 'ru', name: 'Русский', code: 'RU' },
  { id: 'uz', name: 'O\'zbek', code: 'UZ' },
  { id: 'en', name: 'English', code: 'EN' },
] as const;

export const VOICE_TYPES = [
  { id: 'female', name: 'Женский' },
  { id: 'male', name: 'Мужской' },
] as const;

export const CTA_OPTIONS = [
  'Купить сейчас',
  'Заказать',
  'Написать нам',
  'Узнать подробнее',
  'Order now',
  'Buy now',
  'Contact us',
  'Learn more',
] as const;

export const PLANS = [
  { id: 'starter', name: 'Starter', price: 29, monthly_limit: 15 },
  { id: 'pro', name: 'Pro', price: 99, monthly_limit: 50 },
  { id: 'agency', name: 'Agency', price: 190, monthly_limit: 200 },
] as const;
