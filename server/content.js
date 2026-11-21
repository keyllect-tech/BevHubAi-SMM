// Ad content: categories, template phrases and the non-AI fallback script generator.
//
// Everything here works offline with no key. Templates are deliberately generic: they never invent
// prices, reviews or guarantees, and they are only used for facts the user actually typed.

import { cleanText, shorten } from './text.js';
import { detectLanguage, hasUzbekMarkers, normalizeUzbekText } from './lang.js';

/** Kinds of ads the app writes scripts for. */
export const CATEGORIES = ['product', 'realty', 'food', 'shop', 'service', 'job', 'event', 'other'];

export const CATEGORY_LABELS = {
  product: 'product for sale',
  realty: 'real estate (sale or rent of an apartment, house, office or commercial space)',
  food: 'restaurant, cafe or food delivery',
  shop: 'shop or store',
  service: 'service business',
  job: 'job vacancy / hiring announcement',
  event: 'event, class or promotion',
  other: 'general announcement',
};

// Substring keywords per ad type (ru + uz + en); the category with most hits wins.
const CATEGORY_KEYWORDS = {
  realty: ['квартир', 'коттедж', 'таунхаус', 'офис', 'аренд', 'недвижим', 'жилой', 'новострой', 'метрах', 'комнат', 'земельн', 'участк', 'ипотек', 'xonadon', 'kvartira', 'ijaraga', 'uy sotiladi'],
  food: ['кафе', 'ресторан', 'кофейн', 'доставк', 'блюдо', 'меню', 'пицц', 'суши', 'шашлык', 'еда', 'обед', 'ужин', 'bar', 'taom', 'ovqat', 'restoran', 'qahva'],
  job: ['ваканс', 'сотрудник', 'резюме', 'требуются', 'ищем', 'стажёр', 'стажер', 'стажировк', 'подработка', 'график', 'vakansiya', 'izlaymiz', 'rezyume'],
  event: ['мероприят', 'концерт', 'фестиваль', 'мастер-класс', 'семинар', 'вебинар', 'тренинг', 'выставка', 'приглашаем', 'премьера', 'нетворкинг', 'tadbir', 'concert'],
  service: ['ремонт', 'уборк', 'монтаж', 'обслуживан', 'услуг', 'клининг', 'покраск', 'сантехник', 'электрик', 'стрижк', 'барбер', 'такси', 'xizmat', 'ustalar'],
  shop: ['магазин', 'бутик', 'торговый', 'асортимент', 'распродаж', "do'kon", 'savdo'],
  product: ['купить', 'товар', 'смартфон', 'телефон', 'часы', 'наушник', 'кроссовк', 'одежд', 'косметик', 'аксессуар', 'заказать', 'сумк', 'mebel'],
};

/** Best-scoring ad category for the text; 'product' when nothing matches. */
export function detectCategory(text) {
  const t = String(text || '').toLowerCase();
  let best = 'product';
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    }
  }
  return best;
}

const CATEGORY_STYLE = { realty: 'premium', food: 'dynamic', shop: 'dynamic', service: 'product', job: 'product', event: 'dynamic', product: 'dynamic', other: 'product' };

/** Visual style that fits the ad type (auto mode). */
export function pickStyle(category) {
  return CATEGORY_STYLE[category] || 'product';
}

// Built-in template generator: works with no AI at all and offers a different phrasing each run.
export const TEMPLATES = {
  ru: {
    product: {
      hooks: {
        product: ['Знакомьтесь — {name}', '{name}: то, что вы искали', 'Встречайте {name}'],
        dynamic: ['Стоп! {name} меняет всё', 'Только посмотрите на {name}', 'Три секунды — и вы захотите {name}'],
        premium: ['{name}. Создано для лучших', '{name} — когда выбираешь лучшее', 'Премиум в каждой детали: {name}'],
        ugc: ['Смотрите, что я нашёл: {name}', 'Вот почему стоит присмотреться к {name}', '{name} — без фильтров'],
      },
      closers: ['Для тех, кто выбирает лучшее', 'Попробуйте сами', 'Узнайте больше прямо сейчас'],
      cta: 'Закажите сейчас',
    },
    realty: { hooks: ['{name} — ваш новый адрес', 'Ищете помещение? {name}', 'Предложение: {name}'], closers: ['Посмотрите лично', 'Все детали — по телефону'], cta: 'Запишитесь на просмотр' },
    food: { hooks: ['Проголодались? {name} ждёт вас', '{name} — вкус, ради которого возвращаются', 'Сегодня ужинаем в {name}'], closers: ['Ждём вас в гости', 'Забронируйте столик заранее'], cta: 'Забронируйте столик' },
    shop: { hooks: ['{name} — всё нужное в одном месте', 'Загляните в {name}', 'Новинки уже в {name}'], closers: ['Приходите — поможем с выбором', 'Ждём вас в магазине'], cta: 'Приходите в магазин' },
    service: { hooks: ['{name} — сделаем за вас', 'Нужна помощь? {name}', '{name}: решаем задачу под ключ'], closers: ['Обсудим вашу задачу', 'Оставьте заявку — свяжемся с вами'], cta: 'Оставьте заявку' },
    job: { hooks: ['Мы ищем: {name}', 'Открыта вакансия — {name}', 'Присоединяйтесь к команде: {name}'], closers: ['Растите вместе с нами', 'Отправьте резюме сегодня'], cta: 'Откликнитесь сейчас' },
    event: { hooks: ['Не пропустите: {name}', '{name} — ждём вас!', 'Приглашаем: {name}'], closers: ['Приходите с друзьями', 'Все подробности — по ссылке'], cta: 'Зарегистрируйтесь' },
    other: { hooks: ['Знакомьтесь: {name}', 'Важное объявление: {name}', '{name} — узнайте подробнее'], closers: ['Узнайте больше', 'Свяжитесь с нами'], cta: 'Узнать подробнее' },
    benefits: ['Продумана каждая деталь', 'Стиль и удобство в одном', 'Создано с вниманием к деталям'],
  },
  uz: {
    product: {
      hooks: {
        product: ['{name} — siz kutgan narsa', '{name}: aynan sizga kerak', 'Tanishing: {name}'],
        dynamic: ['Toʻxtang! {name} hammasini oʻzgartiradi', '{name}ga bir qarang', 'Uch soniya — va {name} sizniki'],
        premium: ['{name}. Eng yaxshilar uchun', '{name} — eng yaxshisini tanlaganlarga', 'Har bir detalda premium: {name}'],
        ugc: ['Qarang, nima topdim: {name}', 'Nega {name}ga eʼtibor berish kerak', '{name} — filtrsiz'],
      },
      closers: ['Eng yaxshisini tanlaganlar uchun', 'Oʻzingiz sinab koʻring', 'Batafsil hoziroq bilib oling'],
      cta: 'Hozir buyurtma qiling',
    },
    realty: { hooks: ['{name} — yangi manzilingiz', 'Joy qidiryapsizmi? {name}', 'Taklif: {name}'], closers: ['Oʻzingiz kelib koʻring', 'Tafsilotlar telefon orqali'], cta: 'Koʻrishga yoziling' },
    food: { hooks: ['Qorningiz ochdimi? {name} sizni kutmoqda', '{name} — qaytib keladigan taʼm', 'Bugun {name}da kechki ovqat'], closers: ['Sizni mehmonga kutamiz', 'Stolni oldindan band qiling'], cta: 'Stol band qiling' },
    shop: { hooks: ['{name} — hammasi bir joyda', '{name}ga kiring', 'Yangiliklar {name}da'], closers: ['Keling — tanlashda yordam beramiz', 'Doʻkonda kutamiz'], cta: 'Doʻkonga keling' },
    service: { hooks: ['{name} — biz siz uchun bajaramiz', 'Yordam kerakmi? {name}', '{name}: vazifani toʻliq hal qilamiz'], closers: ['Vazifangizni muhokama qilamiz', 'Ariza qoldiring — bogʻlanamiz'], cta: 'Ariza qoldiring' },
    job: { hooks: ['Biz izlayapmiz: {name}', 'Boʻsh ish oʻrni — {name}', 'Jamoaga qoʻshiling: {name}'], closers: ['Biz bilan birga oʻsing', 'Rezyumeni bugun yuboring'], cta: 'Hoziroq javob bering' },
    event: { hooks: ['Oʻtkazib yubormang: {name}', '{name} — sizni kutamiz!', 'Taklif qilamiz: {name}'], closers: ['Doʻstlaringiz bilan keling', 'Batafsil maʼlumot — havolada'], cta: 'Roʻyxatdan oʻting' },
    other: { hooks: ['Tanishing: {name}', 'Muhim eʼlon: {name}', '{name} — batafsil bilib oling'], closers: ['Batafsil bilib oling', 'Biz bilan bogʻlaning'], cta: 'Batafsil bilish' },
    benefits: ['Har bir detal oʻylangan', 'Uslub va qulaylik birgalikda', 'Eʼtibor bilan yaratilgan'],
  },
  en: {
    product: {
      hooks: {
        product: ['Meet {name}', '{name}: exactly what you were looking for', 'Introducing {name}'],
        dynamic: ['Stop scrolling. {name} changes everything', 'Just look at {name}', 'Three seconds and you will want {name}'],
        premium: ['{name}. Crafted for those who expect more', '{name} — when only the best will do', 'Premium in every detail: {name}'],
        ugc: ['Look what I found: {name}', "Here's why {name} is worth a look", '{name}, no filter'],
      },
      closers: ['For those who choose the best', 'See it for yourself', 'Find out more today'],
      cta: 'Order now',
    },
    realty: { hooks: ['{name} — your new address', 'Looking for a space? {name}', 'Now available: {name}'], closers: ['See it in person', 'Details on request'], cta: 'Book a viewing' },
    food: { hooks: ['Hungry? {name} is waiting', '{name} — a taste worth coming back for', 'Tonight, dinner at {name}'], closers: ['We look forward to seeing you', 'Reserve your table in advance'], cta: 'Reserve a table' },
    shop: { hooks: ['{name} — everything in one place', 'Drop by {name}', 'New arrivals at {name}'], closers: ['Come in — we will help you choose', 'See you in store'], cta: 'Visit the store' },
    service: { hooks: ['{name} — we handle it for you', 'Need help? {name}', '{name}: done end to end'], closers: ["Let's discuss your task", 'Leave a request — we will call you back'], cta: 'Leave a request' },
    job: { hooks: ["We're hiring: {name}", 'Open position — {name}', 'Join the team: {name}'], closers: ['Grow with us', 'Send your CV today'], cta: 'Apply now' },
    event: { hooks: ["Don't miss it: {name}", '{name} — see you there!', "You're invited: {name}"], closers: ['Bring your friends', 'All the details at the link'], cta: 'Register now' },
    other: { hooks: ['Meet {name}', 'Announcement: {name}', '{name} — find out more'], closers: ['Find out more', 'Get in touch'], cta: 'Learn more' },
    benefits: ['Every detail considered', 'Style and comfort in one', 'Made with attention to detail'],
  },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const capitalize = (s) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

/** Splits the description into two subtitle-sized selling points. */
function splitDescription(description) {
  const sentences = String(description || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, '').trim())
    .filter(Boolean);
  if (sentences.length >= 2) return [sentences[0], sentences.slice(1).join('. ')];

  const single = sentences[0] || '';
  if (single.length > 60 && single.includes(',')) {
    // One long sentence: break it at the comma closest to the middle.
    const commas = [...single.matchAll(/,/g)].map((m) => m.index);
    const middle = single.length / 2;
    const at = commas.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best), commas[0]);
    return [single.slice(0, at).trim(), single.slice(at + 1).trim()];
  }
  return [single, ''];
}

/** Category/language-appropriate call to action (same strings as the template generator). */
export function defaultCta(category, language) {
  const t = TEMPLATES[language] || TEMPLATES.ru;
  return (t[category] || t.other).cta;
}

/**
 * Can the user's own description be used as a benefit line in a video of this language?
 * Quoting a Russian description inside an Uzbek video is exactly the ru/uz mix we must avoid, and
 * there is no translation step in the template path — so the template lines are used instead.
 */
function descriptionFitsLanguage(description, language) {
  if (!description) return false;
  if (language === 'uz') return detectLanguage(description) === 'uz' || hasUzbekMarkers(description);
  return detectLanguage(description) === language;
}

/**
 * Offline script: template hook/benefits/CTA, using the user's description only when it is written
 * in the requested language. Returns a warning when facts from the description were dropped.
 */
export function generateTemplateScript({ productName, description, cta, language, style, category }) {
  const lang = TEMPLATES[language] ? language : 'ru';
  const t = TEMPLATES[lang];
  const c = t[category] || t.other;
  const hooks = category === 'product' ? c.hooks[style] || c.hooks.dynamic : c.hooks;

  const usableDescription = descriptionFitsLanguage(description, lang);
  const [first, second] = splitDescription(usableDescription ? description : '').map(capitalize);

  const script = {
    // Function replacer: a name containing "$&" or "$$" must be inserted literally.
    hook: capitalize(shorten(pick(hooks).replace('{name}', () => productName), 90)),
    benefit1: shorten(first || pick(t.benefits), 90),
    benefit2: shorten(second || pick(c.closers), 90),
    cta: shorten(cta || c.cta, 60),
  };

  let warning = '';
  if (!usableDescription && description) {
    const descriptionLanguage = detectLanguage(description);
    warning =
      lang === 'uz'
        ? 'Описание написано не на узбекском — в сценарий подставлены типовые узбекские формулировки, факты из описания не переведены.'
        : `Описание написано не на языке «${lang}» (определён: ${descriptionLanguage}) — использованы типовые формулировки.`;
  }
  return { script, warning };
}

/** Normalizes text that will be shown as Uzbek (Cyrillic → Latin, one apostrophe style). */
export function asUzbek(text, maxLen) {
  return cleanText(normalizeUzbekText(text), maxLen);
}