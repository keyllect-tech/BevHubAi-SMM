// Language detection and Uzbek text handling.
//
// The app writes ads in Russian, Uzbek (Latin) and English. Everything here is deterministic:
// no network, no model — the same input always produces the same result, which is what the
// language checks in the script pipeline need.

export const UZ_APOSTROPHE = '\u02BB'; // ʻ — the canonical Uzbek Latin modifier letter (oʻ, gʻ)
export const LANGUAGES = { ru: 'Russian', uz: 'Uzbek', en: 'English' };
export const CYRILLIC_RE = /[\u0400-\u04FF]/;
const UZ_CYRILLIC_MARK_RE = /[ўқғҳЎҚҒҲ]/;

// Short words (1-3 letters) are matched whole: "bu" as a prefix would swallow the English "buy".
const UZ_WORDS = new Set([
  'va', 'siz', 'biz', 'men', 'bu', 'shu', 'u', 'ya', 'ha', 'yoq', 'bor', 'yil', 'kun', 'oy', 'soat',
  'salom', 'assalomu', 'alaykum', 'qanday', 'qanaqa', 'nega', 'nima', 'qachon', 'qayer', 'kim',
  'eng', 'hamma', 'barcha', 'har', 'bir', 'ikki', 'uch', 'hozir', 'keyin', 'endi', 'lekin', 'ammo',
  'ham', 'hamda', 'yoki', 'uchun', 'bilan', 'haqida', 'qiling', 'oling', 'keling', 'kerak', 'arzon',
  'qimmat', 'yangi', 'eski', 'katta', 'kichik', 'yaxshi', 'yomon', 'sifatli', 'tez', 'sekin',
  'ish', 'oʻrni', 'maosh', 'xizmat', 'doʻkon', 'bozor', 'mahsulot', 'tovar', 'narx', 'chegirma',
  'aksiya', 'kafolat', 'yetkazish', 'buyurtma', 'sotish', 'sotiladi', 'ijaraga', 'rezyume',
  'vakansiya', 'mijoz', 'xaridor', 'jamoa', 'taklif', 'eʼlon', 'havola', 'sayt', 'telefon',
  'manzil', 'stol', 'ovqat', 'taʼm', 'qahva', 'restoran', 'kafe', 'non', 'choy', 'suv', 'bepul',
  'tekin', 'cheksiz', 'kuni', 'barcha', 'qisqa', 'uzoq', 'darhol', 'tezda',
  // Everyday nouns that show up in ads (a product name alone is not a language signal).
  'uy', 'kvartira', 'dala', 'hovli', 'mashina', 'avtomobil', 'biznes', 'maktab', 'kurs', 'sport',
  'kiyim', 'poyabzal', 'sumka', 'mebel', 'oziq', 'doriv', 'kosmetika', 'shifoxona', 'klinika',
  'bolalar', 'ayollar', 'erkaklar', 'taʼlim', 'sogʻliq', 'sayyoh', 'yoʻl', 'ovqatlanish',
]);

// Stems (4+ letters): the word starts with one of these, so inflections still count.
const UZ_STEMS = [
  'ozbekiston', 'yaxshisi', 'sotil', 'sotib', 'sotamiz', 'buyurtma', 'chegirma', 'batafsil', 'tafsilot',
  'yetkaz', 'kafolat', 'mahsulot', 'xizmat', 'mijoz', 'telefon', 'yangilan', 'qilamiz', 'qilish', 'qilyapti',
  'kerakli', 'kerak', 'bizning', 'sizning', 'sizni', 'oʻzing', 'kutmoq', 'kutamiz', 'tanlagan', 'tanlash',
  'manzilingiz', 'qulaylik', 'ishlaydi', 'ishlayapmiz', 'izlayapmiz', 'izlaymiz', 'bogʻlan', 'qoldiring',
  'ariza', 'roʻyxat', 'ulash',   'tavsiya', 'imkoniyat', 'qulay', 'ishonchli', 'zamonaviy', 'uzoq', 'darhol', 'smartfon', 'noutbuk',
  'planshet', 'kompyuter', 'poyabzal', 'kosmetika', 'shifoxona', 'universitet', 'ovqatlanish',
];

// English function words: enough to tell an English request from Uzbek Latin.
const EN_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'without', 'from', 'to', 'of', 'in', 'on', 'at', 'by',
  'your', 'our', 'you', 'we', 'i', 'me', 'my', 'us', 'it', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'there', 'here', 'now', 'today', 'new', 'best', 'good', 'great',
  'buy', 'order', 'sale', 'price', 'deal', 'deals', 'offer', 'discount', 'delivery', 'shipping',
  'guarantee', 'free', 'save', 'only', 'just', 'all', 'every', 'more', 'most', 'get', 'shop', 'store',
  'call', 'contact', 'look', 'watch', 'meet', 'try', 'choose', 'learn', 'find', 'book', 'apply',
  'visit', 'join', 'need', 'want', 'love', 'like', 'made', 'make', 'fast', 'cheap', 'hello', 'hi', 'hey',
  'welcome', 'please', 'what', 'why', 'how', 'when', 'who', 'not', 'no', 'yes', 'can', 'will', 'would',
  'should', 'do', 'does', 'did', 'has', 'have', 'had', 'than', 'then', 'so', 'but', 'if', 'as', 'up',
  'out', 'about', 'into', 'over', 'very', 'really', 'amazing', 'perfect', 'quality',
]);

// Uzbek Cyrillic → Uzbek Latin (official 1993+ alphabet). Only letters that differ from Russian.
const UZ_CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sh', ъ: 'ʼ', э: 'e', ю: 'yu', я: 'ya', ь: '', ы: 'i', ё: 'yo',
  қ: 'q', ғ: 'g' + UZ_APOSTROPHE, ҳ: 'h', ў: 'o' + UZ_APOSTROPHE, ә: 'a', ң: 'n', ө: 'o', ү: 'u', җ: 'j', і: 'i',
};

const normalizeTokens = (text) => {
  const tokens = [];
  for (const raw of text.toLowerCase().match(/[a-zʻʼ’']+/g) || []) {
    const t = raw.replace(/^'+|'+$/g, '');
    if (!t) continue;
    tokens.push(t);
    // "o'zbekiston" must also count as the plain "ozbekiston" spelling.
    if (t.includes("'")) tokens.push(t.replace(/'/g, ''));
    if (t.includes('ʼ')) tokens.push(t.replace(/ʼ/g, ''));
  }
  return tokens;
};

const hitsUz = (word) => UZ_WORDS.has(word) || UZ_STEMS.some((stem) => word.startsWith(stem));

/** True when the text uses letters that only exist in Uzbek Cyrillic (ў, қ, ғ, ҳ). */
export function isUzbekCyrillic(text) {
  if (!CYRILLIC_RE.test(text)) return false;
  return UZ_CYRILLIC_MARK_RE.test(text);
}

/** Uzbek Cyrillic → Uzbek Latin. Other scripts are returned unchanged. */
export function transliterateUzbekCyrillic(text) {
  if (!isUzbekCyrillic(text)) return text;
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const latin = UZ_CYRILLIC_TO_LATIN[lower];
    if (latin === undefined) {
      out += ch;
      continue;
    }
    // ғ → gʻ and ў → oʻ keep their capital when the source was capitalised.
    const isUpper = ch !== lower;
    out += isUpper ? latin.charAt(0).toUpperCase() + latin.slice(1) : latin;
  }
  return out;
}

/**
 * Uzbek is written with one modifier letter (oʻ, gʻ). Mixed apostrophe styles look broken in
 * subtitles, so every variant becomes U+02BB. Applied to Uzbek text only — English contractions
 * ("don't") must keep the ASCII apostrophe.
 */
export function normalizeUzbekApostrophes(text) {
  return text.replace(/[\u02BC'\u2018\u2019\u0060\u00B4\u02B9]/g, UZ_APOSTROPHE);
}

/** Canonical form used before any Uzbek text is generated, stored or rendered. */
export function normalizeUzbekText(text) {
  return normalizeUzbekApostrophes(transliterateUzbekCyrillic(text));
}

/**
 * Which language a free-text request is written in.
 * Cyrillic → ru, unless it carries Uzbek-only letters (ў, қ, ғ, ҳ) → uz.
 * Latin → uz or en by stop words; unknown Latin defaults to ru (the UI language).
 */
export function detectLanguage(text) {
  const value = String(text || '');
  if (UZ_CYRILLIC_MARK_RE.test(value)) return 'uz';
  if (CYRILLIC_RE.test(value)) return 'ru';
  let uz = 0;
  let en = 0;
  for (const token of normalizeTokens(value)) {
    if (hitsUz(token)) uz += 1;
    else if (EN_WORDS.has(token)) en += 1;
  }
  // The Uzbek modifier apostrophe (ʻ / ʼ) never appears in English or Russian Latin transliteration.
  if (uz === 0 && /[\u02BB\u02BC]/.test(value)) uz = 1;
  if (uz === 0 && en === 0) return 'ru';
  return uz >= en ? 'uz' : 'en';
}

export function containsCyrillic(text) {
  return CYRILLIC_RE.test(String(text || ''));
}

/** True when the text contains at least one Uzbek word or the Uzbek modifier letter. */
export function hasUzbekMarkers(text) {
  const value = String(text || '');
  if (/[\u02BB\u02BC]/.test(value)) return true;
  return normalizeTokens(value).some(hitsUz);
}

/**
 * Fields of a script that are not written in the requested language.
 * Uzbek Latin must contain a recognizable Uzbek signal; otherwise English or ambiguous Latin text
 * must not pass merely because it is not Cyrillic.
 */
export function foreignFields(script, language) {
  const fields = ['hook', 'benefit1', 'benefit2', 'cta'];
  const bad = [];
  const isUzbekCopy = language === 'uz'
    && detectLanguage(fields.map((field) => String(script?.[field] || '')).join(' ')) === 'uz';
  for (const field of fields) {
    const text = String(script?.[field] || '');
    if (!text) continue;
    if (language === 'ru' && !containsCyrillic(text)) bad.push(field);
    else if (language === 'en' && containsCyrillic(text)) bad.push(field);
    else if (language === 'uz' && (containsCyrillic(text) || detectLanguage(text) === 'en' || !isUzbekCopy)) bad.push(field);
  }
  return bad;
}