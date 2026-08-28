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
  voice_url: string;
  style: string;
  script_hook: string;
  script_body: string;
  script_cta: string;
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
  asset_type: string;
  file_url: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  sort_order: number;
  created_at: string;
}

export interface GenerationJob {
  id: string;
  video_id: string;
  status: VideoStatus;
  progress: number;
  current_step: string;
  provider: string;
  error_message: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  workspace_id: string;
  plan: string;
  monthly_limit: number;
  status: string;
  created_at: string;
}

export interface Usage {
  id: string;
  workspace_id: string;
  month_start: string;
  videos_created: number;
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

export const VIDEO_STYLES = [
  { id: 'product', name: 'Product Ad', desc: 'Чистая рекламная подача' },
  { id: 'dynamic', name: 'Dynamic', desc: 'Быстрый TikTok/Reels стиль' },
  { id: 'premium', name: 'Premium', desc: 'Премиальный рекламный ролик' },
  { id: 'ugc', name: 'UGC', desc: 'Стиль пользовательского контента' },
] as const;

export const LANGUAGES = [
  { id: 'ru', name: 'Русский', flag: '🇷🇺' },
  { id: 'uz', name: 'O\'zbek', flag: '🇺🇿' },
  { id: 'en', name: 'English', flag: '🇬🇧' },
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
