// Script validation shared by every AI provider.
//
// Model and template scripts share structure, language, and factual-claim validation.

import { cleanText } from '../text.js';
import { detectLanguage, foreignFields, LANGUAGES } from '../lang.js';
import { AiError } from './errors.js';

export const SCRIPT_FIELDS = ['hook', 'benefit1', 'benefit2', 'cta'];

const FIELD_LIMITS = { hook: 80, benefit1: 90, benefit2: 90, cta: 60 };
const matchingClaim = (id, claim, variant = id) => ({ id, claim, evidence: claim, variant });
const PHONE_TARGET = '(?:телефон[\\p{L}]*|смартфон[\\p{L}]*|iphone|android|ios|phone|smartphone|telefon[\\p{L}]*|smartfon[\\p{L}]*)';
const PHONE_TARGETS = `${PHONE_TARGET}(?:\\s*(?:,|and|и|or|или)\\s*${PHONE_TARGET})*`;
const PHONE_COMPATIBILITY_CLAIM = new RegExp(
  `(?:(?:подключ|соедин|сопряж|connect|pair|ulanish|bog'lanish|работает\\s+с|works?\\s+with)[\\p{L}]*[^.!?;,\\n]{0,40}?${PHONE_TARGETS}|(?:совместим[\\p{L}]*\\s+с|compatible\\s+with|подходит\\s+(?:для|к))\\s*${PHONE_TARGETS})`,
  'iu',
);
const FACT_CLAIM_RULES = [
  {
    id: 'one-touch-pairing',
    claim: /(?:(?:сопряж|подключ|соедин)[\p{L}]*[^.!?;,\n]{0,40}(?:одн[\p{L}]*\s+кнопк|одним\s+нажати[\p{L}]*|в\s+одно\s+касани[\p{L}]*|one[-\s]?button|one[-\s]?touch|single[-\s]?button|bir\s+(?:marta\s+)?bosish|bir\s+tugma)|(?:одн[\p{L}]*\s+кнопк|одним\s+нажати[\p{L}]*|в\s+одно\s+касани[\p{L}]*).{0,40}(?:сопряж|подключ|соедин)[\p{L}]*)/iu,
    evidence: /(?:(?:сопряж|подключ|соедин)[\p{L}]*[^.!?;,\n]{0,40}(?:одн[\p{L}]*\s+кнопк|одним\s+нажати[\p{L}]*|в\s+одно\s+касани[\p{L}]*|one[-\s]?button|one[-\s]?touch|single[-\s]?button|bir\s+(?:marta\s+)?bosish|bir\s+tugma)|(?:одн[\p{L}]*\s+кнопк|одним\s+нажати[\p{L}]*|в\s+одно\s+касани[\p{L}]*).{0,40}(?:сопряж|подключ|соедин)[\p{L}]*)/iu,
  },
  {
    id: 'fast-connection',
    claim: /(?:(?:быстр[\p{L}]*|fast|tez)\s+(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*|(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*[^.!?;,\n]{0,35}(?:быстр[\p{L}]*|fast|tez))/iu,
    evidence: /(?:(?:быстр[\p{L}]*|fast|tez)\s+(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*|(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*[^.!?;,\n]{0,35}(?:быстр[\p{L}]*|fast|tez))/iu,
  },
  {
    id: 'fast-connection',
    claim: /(?:(?:мгновенн[\p{L}]*|instant(?:ly)?|bir\s+zumda)\s+(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*|(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*[^.!?;,\n]{0,35}(?:мгновенн[\p{L}]*|instant|bir\s+zumda|за\s+\d+\s+секунд[а-я]*|за\s+секунду|in\s+\d+\s+seconds|без\s+задержк[\p{L}]*|without\s+delay|no\s+lag))/iu,
    evidence: /(?:(?:мгновенн[\p{L}]*|instant(?:ly)?|bir\s+zumda)\s+(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*|(?:сопряж|подключ|соедин|pair|connect|ulanish|bog'lanish)[\p{L}]*[^.!?;,\n]{0,35}(?:мгновенн[\p{L}]*|instant|bir\s+zumda|за\s+\d+\s+секунд[а-я]*|за\s+секунду|in\s+\d+\s+seconds|без\s+задержк[\p{L}]*|without\s+delay|no\s+lag))/iu,
    variant: 'instant',
  },
  {
    id: 'phone-compatibility',
    claim: PHONE_COMPATIBILITY_CLAIM,
    evidence: PHONE_COMPATIBILITY_CLAIM,
  },
  {
    ...matchingClaim('noise-cancellation', /(?:\banc\b|шумоподавлен\w*|шумоизоляц\w*|noise[- ]?cancell\w*|shovqin\w*dan\s+himoya)/iu),
  },
  {
    ...matchingClaim('studio-sound-quality', /(?:студийн[\p{L}]*\s+(?:звук|качеств[\p{L}]*)|studio[- ]quality|high[- ]fidelity|hi[- ]?fi)/iu),
  },
  {
    ...matchingClaim('bass-feature', /(?:(?:мощн[\p{L}]*|глубок[\p{L}]*)\s+бас|deep\s+bass|powerful\s+bass)/iu),
  },
  {
    ...matchingClaim('spatial-audio', /(?:объемн[\p{L}]*\s+звук|spatial\s+audio|surround\s+sound)/iu),
  },
  {
    ...matchingClaim('ideal-sound-quality', /(?:кристально\s+чист[\p{L}]*\s+звук|идеальн[\p{L}]*\s+звук|perfect\s+(?:sound|audio)|mukammal\s+(?:ovoz|tovush))/iu),
  },
  {
    ...matchingClaim('water-resistance', /(?:водонепрониц\w*|waterproof)/iu, 'waterproof'),
  },
  {
    ...matchingClaim('water-resistance', /(?:влагозащит\w*|водостойк[\p{L}]*|защит[\p{L}]*\s+от\s+воды|water[- ]resistant|suvga\s+chidamli)/iu, 'water-resistant'),
  },
  {
    ...matchingClaim('battery-life-claim', /(?:долг[\p{L}]*\s+(?:автономност[\p{L}]*|время\s+работы)|long\s+battery\s+life)/iu, 'battery-life-qualitative'),
  },
  {
    ...matchingClaim('battery-life-claim', /(?:lasts?\s+all\s+day|работа[\p{L}]*\s+целые\s+сутки|works?\s+all\s+day)/iu, 'battery-life-all-day'),
  },
  {
    ...matchingClaim('fast-charging', /(?:быстр[\p{L}]*\s+зарядк[\p{L}]*|fast\s+charging|tez\s+quvvatlash)/iu),
  },
  {
    ...matchingClaim('included-case', /(?:(?:чехол|кейс|case).{0,30}(?:в\s+комплекте|входит|прилагается|included|comes\s+with|not\s+included|не\s+входит)|(?:в\s+комплекте|входит|прилагается|included|comes\s+with|not\s+included|не\s+входит).{0,30}(?:чехол|кейс|case))/iu),
  },
  {
    ...matchingClaim('included-cable', /(?:(?:кабель|cable).{0,30}(?:в\s+комплекте|входит|прилагается|included|comes\s+with|not\s+included|не\s+входит)|(?:в\s+комплекте|входит|прилагается|included|comes\s+with|not\s+included|не\s+входит).{0,30}(?:кабель|cable))/iu),
  },
  {
    ...matchingClaim('included-charger', /(?:(?:зарядн[\p{L}]*\s+устройств[\p{L}]*|charger).{0,30}(?:в\s+комплекте|входит|прилагается|included|comes\s+with|not\s+included|не\s+входит)|(?:в\s+комплекте|входит|прилагается|included|comes\s+with|not\s+included|не\s+входит).{0,30}(?:зарядн[\p{L}]*\s+устройств[\p{L}]*|charger))/iu),
  },
  {
    ...matchingClaim('microphone', /(?:микрофон|microphone|mikrofon)/iu),
  },
  {
    ...matchingClaim('touch-control', /(?:сенсорн\w*\s+управлен\w*|touch\s+control|sensorli\s+boshqaruv)/iu),
  },
  {
    ...matchingClaim('voice-assistant', /(?:голосов\w*\s+помощник|voice\s+assistant)/iu),
  },
  {
    ...matchingClaim('leather-material', /(?:кожан\w*|leather)/iu),
  },
  {
    ...matchingClaim('aluminum-material', /(?:алюмини\w*|aluminu\w*)/iu),
  },
  {
    ...matchingClaim('metal-material', /(?:металлическ\w*|metallic)/iu),
  },
  {
    ...matchingClaim('silicone-material', /(?:силикон\w*|silicone)/iu),
  },
  {
    ...matchingClaim('titanium-material', /(?:титан\w*|titanium)/iu),
  },
  {
    ...matchingClaim('plastic-material', /(?:пластик[\p{L}]*|plastic|polycarbonate|поликарбонат[\p{L}]*)/iu),
  },
  {
    ...matchingClaim('steel-material', /(?:сталь[\p{L}]*|нержавеющ[\p{L}]*|steel|stainless\s+steel)/iu),
  },
  {
    ...matchingClaim('wood-material', /(?:деревян\w*|wooden)/iu),
  },
  {
    id: 'unverified-guarantee',
    claim: /(?:гарантир\w*|гарантирован\w*|guarantee\w*|guaranteed|kafolat\w*|(?:you will|you'll)\s+(?:get|hear|enjoy)\s+(?:the\s+)?(?:best|perfect))/iu,
    evidence: /(?:гарантир\w*|гарантирован\w*|guarantee\w*|guaranteed|kafolat\w*|(?:you will|you'll)\s+(?:get|hear|enjoy)\s+(?:the\s+)?(?:best|perfect))/iu,
  },
];

function normalizeClaimText(text) {
  return String(text || '')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʻʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const QUANTITY_UNITS = [
  { dimension: 'time', factor: 0.001, unit: '(?:milliseconds?|msecs?|ms|мс)' },
  { dimension: 'time', factor: 1, unit: '(?:seconds?|secs?|секунд[а-я]*|сек\\.?|s)' },
  { dimension: 'time', factor: 60, unit: '(?:minutes?|mins?|минут[а-я]*|мин\\.?|min)' },
  { dimension: 'time', factor: 3600, unit: '(?:hours?|hrs?|час(?:а|ов)?|ч(?:ас(?:а|ов)?)?\\.?|h)' },
  { dimension: 'time', factor: 86400, unit: '(?:days?|сут(?:ки|ок)?|день|дня|дней|дни|дн\\.?)' },
  { dimension: 'time', factor: 604800, unit: '(?:weeks?|недел[\p{L}]*|нед\\.?)' },
  { dimension: 'time', factor: 31536000, unit: '(?:years?|год(?:а|ов|у)?|лет)' },
  { dimension: 'distance', factor: 0.001, unit: '(?:millimeters?|мм)' },
  { dimension: 'distance', factor: 0.01, unit: '(?:centimeters?|см)' },
  { dimension: 'distance', factor: 1, unit: '(?:meters?|метр[а-я]*|м)' },
  { dimension: 'distance', factor: 1000, unit: '(?:kilometers?|километр[а-я]*|км)' },
  { dimension: 'memory', factor: 1, unit: '(?:bytes?|байт[а-я]*)' },
  { dimension: 'memory', factor: 1e3, unit: '(?:kb|кб)' },
  { dimension: 'memory', factor: 1e6, unit: '(?:mb|мб)' },
  { dimension: 'memory', factor: 1e9, unit: '(?:gb|гб)' },
  { dimension: 'memory', factor: 1e12, unit: '(?:tb|тб)' },
  { dimension: 'frequency', factor: 1, unit: '(?:hz|гц)' },
  { dimension: 'frequency', factor: 1e3, unit: '(?:khz|кгц)' },
  { dimension: 'frequency', factor: 1e6, unit: '(?:mhz|мгц)' },
  { dimension: 'frequency', factor: 1e9, unit: '(?:ghz|ггц)' },
  { dimension: 'power', factor: 1, unit: '(?:W|w|[Вв][Тт]|[Вв]атт[а-яА-Я]*)', caseInsensitive: false },
  { dimension: 'power', factor: 1e3, unit: '(?:kW|kw|[Кк][Вв][Тт])', caseInsensitive: false },
  { dimension: 'power', factor: 1e6, unit: 'MW', caseInsensitive: false },
  { dimension: 'power', factor: 1e-3, unit: '(?:mW|[Мм][Вв][Тт])', caseInsensitive: false },
  { dimension: 'percentage', factor: 1, unit: '(?:%|процент[а-я]*|percent(?:age)?s?)' },
  { dimension: 'currency:rub', factor: 1, unit: '(?:₽|руб(?:\\.|лей|ля)?)' },
  { dimension: 'currency:usd', factor: 1, unit: '(?:\\$|usd)' },
  { dimension: 'currency:eur', factor: 1, unit: '(?:€|eur)' },
  { dimension: 'currency:uzs', factor: 1, unit: '(?:uzs|сум[а-я]*)' },
];

const NUMBER_PATTERN = '(?<value>[+-]?(?:\\d{1,3}(?:[\\s\\u00a0\\u202f,]\\d{3})+|\\d+)(?:[.,]\\d+)?)';
const RANGE_NUMBER_PATTERN = '[+-]?(?:\\d{1,3}(?:[\\s\\u00a0\\u202f,]\\d{3})+|\\d+)(?:[.,]\\d+)?';

function parseLocalizedNumber(rawValue, language) {
  const raw = rawValue.replace(/[\s\u00a0\u202f]/g, '');
  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');
  let normalized = raw;

  if (comma >= 0 && dot >= 0) {
    if (language === 'en') {
      if (!/^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/.test(raw)) return null;
      normalized = raw.replace(/,/g, '');
    } else {
      if (!/^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/.test(raw)) return null;
      normalized = raw.replace(/\./g, '').replace(',', '.');
    }
  } else if (comma >= 0) {
    if (language === 'en') {
      if (!/^[+-]?\d{1,3}(?:,\d{3})+$/.test(raw)) return null;
      normalized = raw.replace(/,/g, '');
    } else {
      normalized = raw.replace(',', '.');
    }
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function quantityClauseBounds(text, start, end) {
  const sentence = sentenceBounds(text, start);
  const prefix = text.slice(sentence.start, start);
  const suffix = text.slice(end, sentence.end);
  const separator = /[,;]|(?<![\p{L}])(?:but|however|whereas|and|но|однако|и)(?![\p{L}])/giu;
  let clauseStart = sentence.start;
  for (const match of prefix.matchAll(separator)) {
    if (match[0] === ',' && /\d/.test(prefix[match.index - 1] || '') && /\d/.test(prefix[match.index + 1] || '')) continue;
    clauseStart = sentence.start + match.index + match[0].length;
  }
  let clauseEnd = sentence.end;
  for (const match of suffix.matchAll(separator)) {
    if (match[0] === ',' && /\d/.test(suffix[match.index - 1] || '') && /\d/.test(suffix[match.index + 1] || '')) continue;
    clauseEnd = end + match.index;
    break;
  }
  return { start: clauseStart, end: clauseEnd };
}

function quantityBound(text, start, clauseStart) {
  const prefix = text.slice(clauseStart, start).toLocaleLowerCase().trimEnd();
  if (/(?:at least|no less than|not less than|minimum(?: of)?|не менее|от|kamida|eng kamida|dan boshlab)\s*$/u.test(prefix)) return 'minimum';
  if (/(?:more than|greater than|over|свыше|более чем|dan ortiq|ko'proq)\s*$/u.test(prefix)) return 'greater-than';
  if (/(?:less than|under|меньше чем|kamroq)\s*$/u.test(prefix)) return 'less-than';
  if (/(?:up to|at most|no more than|not more than|до|не более|не больше|не свыше|максимум|gacha|ko'pi bilan)\s*$/u.test(prefix)) return 'maximum';
  return 'exact';
}

function quantityBoundSupports(sourceBound, outputBound, sourceValue, outputValue) {
  const equal = Math.abs(sourceValue - outputValue) <= Math.max(1, Math.abs(outputValue)) * 1e-9;
  if (sourceBound === 'exact') {
    return equal && outputBound !== 'greater-than' && outputBound !== 'less-than';
  }
  return sourceBound === outputBound && equal;
}

function quantityRangeSignature(text, start, end, dimension, factor, unit, language, caseInsensitive) {
  const flags = caseInsensitive ? 'giu' : 'gu';
  const pattern = new RegExp(
    `(?<first>${RANGE_NUMBER_PATTERN})\\s*(?:[-–—]|\\bto\\b|до)\\s*(?<second>${RANGE_NUMBER_PATTERN})\\s*(?<unit>${unit})(?=$|[\\s.,!?;:])`,
    flags,
  );
  for (const match of text.matchAll(pattern)) {
    if (start < match.index || end > match.index + match[0].length) continue;
    const first = parseLocalizedNumber(match.groups.first, language);
    const second = parseLocalizedNumber(match.groups.second, language);
    if (first === null || second === null) return null;
    return `${dimension}:${Math.min(first, second) * factor}:${Math.max(first, second) * factor}`;
  }
  return null;
}

function extractQuantities(text, language) {
  const quantities = [];
  for (const { dimension, factor, unit, caseInsensitive = true } of QUANTITY_UNITS) {
    const pattern = new RegExp(`${NUMBER_PATTERN}\\s*(?<unit>${unit})(?=$|[\\s.,!?;:])`, caseInsensitive ? 'giu' : 'gu');
    for (const match of text.matchAll(pattern)) {
      const clause = quantityClauseBounds(text, match.index, match.index + match[0].length);
      const parsedValue = parseLocalizedNumber(match.groups.value, language);
      quantities.push({
        dimension,
        value: parsedValue === null ? null : parsedValue * factor,
        context: quantityContext(text, match.index, match.index + match[0].length),
        bound: quantityBound(text, match.index, clause.start),
        polarity: claimPolarity(text, match.index, match.index + match[0].length),
        range: quantityRangeSignature(
          text,
          match.index,
          match.index + match[0].length,
          dimension,
          factor,
          unit,
          language,
          caseInsensitive,
        ),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  const bluetoothVersion = /(?:bluetooth|блютуз)\s*(?:(?:version|ver\.?|v|верси[яи])\s*)?(?<value>\d+(?:\.\d+)*)(?!\.\d|\d)/giu;
  for (const match of text.matchAll(bluetoothVersion)) {
    quantities.push({
      dimension: 'bluetooth-version',
      value: match.groups.value,
      factor: 1,
      context: 'bluetooth',
      bound: 'exact',
      polarity: claimPolarity(text, match.index, match.index + match[0].length),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  const prefixedCurrency = /(?<unit>[$€₽])\s*(?<value>[+-]?(?:\d{1,3}(?:[\s\u00a0\u202f,]\d{3})+|\d+)(?:[.,]\d+)?)(?=$|[\s.,!?;:])/gu;
  for (const match of text.matchAll(prefixedCurrency)) {
    const dimension = match.groups.unit === '$' ? 'currency:usd' : match.groups.unit === '€' ? 'currency:eur' : 'currency:rub';
    const clause = quantityClauseBounds(text, match.index, match.index + match[0].length);
    quantities.push({
      dimension,
      value: parseLocalizedNumber(match.groups.value, language),
      factor: 1,
      context: quantityContext(text, match.index, match.index + match[0].length),
      bound: quantityBound(text, match.index, clause.start),
      polarity: claimPolarity(text, match.index, match.index + match[0].length),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return quantities;
}

function sentenceBounds(text, position) {
  const left = text.slice(0, position);
  const right = text.slice(position);
  const separator = /[.!?;]["'»”)]*\s+|\n/gu;
  const previous = [...left.matchAll(separator)].at(-1);
  const next = separator.exec(right);
  return {
    start: previous ? previous.index + previous[0].length : 0,
    end: next ? position + next.index : text.length,
  };
}

function claimPolarity(text, start, end, ruleId = '') {
  const bounds = sentenceBounds(text, start);
  const before = text.slice(Math.max(bounds.start, start - 60), start);
  const after = text.slice(end, Math.min(bounds.end, end + 60));
  const claim = text.slice(start, end);
  const local = `${claim} ${before} ${after}`;
  if (ruleId === 'fast-connection' && /(?:без\s+задержк|without\s+delay|no\s+lag|не\s+имеет\s+задержек)/iu.test(local)) {
    return 'positive';
  }
  const beforeWords = before.split(/\s+/).slice(-5).join(' ');
  const afterWords = after.split(/\s+/).slice(0, 5).join(' ');
  const negation = /(?:(?:^|[^\p{L}\p{N}_])(?:не|нет|без)(?=$|[^\p{L}\p{N}_])|отсутств[\p{L}]*|\bnot\b|\bno\b|\bwithout\b|does\s+not|doesn't|is\s+not|isn't|\byo'q\b|\bemas\b)/iu;
  return negation.test(claim) || negation.test(beforeWords) || negation.test(afterWords)
    ? 'negative'
    : 'positive';
}

function quantityContext(text, start, end) {
  const { start: clauseStart, end: clauseEnd } = quantityClauseBounds(text, start, end);
  const clause = text.slice(clauseStart, clauseEnd).toLocaleLowerCase();
  const offset = start - clauseStart;
  const rules = [
    ['charging', /(?:зарядк|заряж|charging|charger)/giu],
    ['battery-life', /(?:батаре|аккумулятор|автоном|battery\s+life|lasts?\s+up\s+to|работа[\p{L}]*\s+(?:до|целые\s+сутки)|works?\s+all\s+day)/giu],
    ['warranty', /(?:гарант|warranty)/giu],
    ['connection', /(?:подключ|соедин|сопряж|задержк|latency|pair(?:ing)?|connect(?:ion)?)/giu],
    ['price', /(?:цен[аы]|стоимост|price|cost|скидк|discount|руб|usd|eur|сум)/giu],
    ['power', /(?:мощност|power|ватт|watt)/giu],
    ['memory', /(?:памят|объем|storage|memory)/giu],
    ['frequency', /(?:частот|frequency)/giu],
    ['distance', /(?:расстояни|дальност|дистанц|range)/giu],
    ['bluetooth', /(?:bluetooth|блютуз)/giu],
  ];
  const candidates = [];
  for (const [context, pattern] of rules) {
    for (const match of clause.matchAll(pattern)) {
      candidates.push({ context, distance: Math.abs(match.index - offset) });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  if (!candidates.length || candidates[0].distance > 60) return 'unclassified';
  if (candidates[1]?.distance === candidates[0].distance && candidates[1].context !== candidates[0].context) {
    return 'unclassified';
  }
  return candidates[0].context;
}

function extractRuleFacts(text) {
  const facts = [];
  for (const rule of FACT_CLAIM_RULES) {
    const pattern = new RegExp(rule.claim.source, `${rule.claim.flags.replace(/[gy]/g, '')}g`);
    for (const match of text.matchAll(pattern)) {
      facts.push({
        id: rule.id,
        variant: rule.variant || rule.id,
        polarity: claimPolarity(text, match.index, match.index + match[0].length, rule.id),
        start: match.index,
        end: match.index + match[0].length,
        targets: rule.id === 'phone-compatibility' ? phoneCompatibilityTargets(match[0]) : null,
      });
    }
  }
  return facts;
}

function phoneCompatibilityTargets(claim) {
  const targets = new Set();
  for (const match of claim.matchAll(/iphone|android|ios|smartphone|phone|смартфон|телефон|smartfon|telefon/giu)) {
    if (/iphone/i.test(match[0])) targets.add('iphone');
    else if (/android/i.test(match[0])) targets.add('android');
    else if (/ios/i.test(match[0])) targets.add('ios');
    else if (/smartphone|смартфон|smartfon/i.test(match[0])) targets.add('smartphone');
    else targets.add('phone');
  }
  return [...targets].sort();
}

const UNKNOWN_ASSERTION_PATTERN = /(?:поддерживает|поддерживаются|supports?|совместим[\p{L}]*\s+с|compatible\s+with|подходит\s+(?:для|к)|works?\s+with|работает\s+с|оснащен[\p{L}]*|equipped\s+with|изготовлен[\p{L}]*\s+из|made\s+of|входит\s+в\s+комплект|не\s+входит\s+в\s+комплект|included|not\s+included)\s+[^.!?;]{1,80}/giu;
const TECHNICAL_FEATURE_PATTERN = /\b(?:aptx(?:\s+hd)?|ldac|aac|multipoint|ipx\d+|nfc|qi|dolby(?:\s+atmos)?|hi-res)\b/giu;

function unsupportedUnknownAssertions(outputText, sourceText, knownFacts) {
  const unsupported = [];
  for (const match of outputText.matchAll(UNKNOWN_ASSERTION_PATTERN)) {
    const parts = match[0].split(/\s+(?:и|and)\s+|,\s*/iu);
    let offset = match.index;
    for (const part of parts) {
      const start = outputText.indexOf(part, offset);
      if (start < 0) continue;
      offset = start + part.length;
      const covered = knownFacts.some((fact) => fact.start < offset && fact.end > start);
      if (covered) continue;
      const exactClaim = normalizeClaimText(part);
      const polarity = claimPolarity(outputText, start, start + part.length);
      const sourceIndex = sourceText.indexOf(exactClaim);
      const sourceSupports = sourceIndex >= 0
        && claimPolarity(sourceText, sourceIndex, sourceIndex + exactClaim.length) === polarity;
      if (!sourceSupports) unsupported.push('unclassified-concrete-claim');
    }
  }
  return unsupported;
}

function unsupportedTechnicalFeatures(outputText, sourceText, knownFacts) {
  const unsupported = [];
  for (const match of outputText.matchAll(TECHNICAL_FEATURE_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (knownFacts.some((fact) => fact.start < end && fact.end > start)) continue;
    const sourceIndex = sourceText.indexOf(match[0]);
    const sourceSupports = sourceIndex >= 0
      && claimPolarity(sourceText, sourceIndex, sourceIndex + match[0].length)
        === claimPolarity(outputText, start, end);
    if (!sourceSupports) unsupported.push('unclassified-concrete-claim');
  }
  return unsupported;
}

/** Detects selected concrete claims unless the product title or description supports them. */
export function findUnsupportedScriptClaims(script, source = {}, fullText = '', { language } = {}) {
  const sourceRaw = [source.productName, source.description].filter(Boolean).join('. ');
  const sourceText = normalizeClaimText(sourceRaw);
  const fieldTexts = [script?.hook, script?.benefit1, script?.benefit2, script?.cta].filter(Boolean);
  const fieldOutputText = fieldTexts.join('. ');
  let separatedFullText = String(fullText || '');
  for (const field of fieldTexts) {
    const index = separatedFullText.indexOf(field);
    if (index >= 0) {
      const end = index + field.length;
      separatedFullText = `${separatedFullText.slice(0, end)}. ${separatedFullText.slice(end)}`;
    }
  }
  const rawOutputTexts = [fieldOutputText, separatedFullText].filter(Boolean);
  const outputTexts = rawOutputTexts.map(normalizeClaimText);
  const outputFacts = outputTexts.flatMap((text) => extractRuleFacts(text));
  const sourceFacts = extractRuleFacts(sourceText);
  const unsupported = outputFacts
    .filter((fact) => !sourceFacts.some((sourceFact) => (
      sourceFact.id === fact.id
      && sourceFact.variant === fact.variant
      && sourceFact.polarity === fact.polarity
      && JSON.stringify(sourceFact.targets) === JSON.stringify(fact.targets)
    )))
    .map((fact) => fact.id);

  const sourceLanguage = source.language
    || (() => {
      const sourceLanguageText = source.description || source.productName || '';
      const detected = detectLanguage(sourceLanguageText);
      if (/[Ѐ-ӿ]/u.test(sourceLanguageText)) return detected;
      return detected === 'en' || detected === 'uz' ? detected : language || detected;
    })();
  const outputLanguage = language || source.language || detectLanguage(fieldOutputText) || 'ru';
  const sourceQuantities = extractQuantities(sourceRaw, sourceLanguage);
  const outputQuantities = rawOutputTexts.flatMap((text) => extractQuantities(text, outputLanguage));
  for (const quantity of outputQuantities) {
    const supported = sourceQuantities.some((sourceQuantity) => (
      sourceQuantity.dimension === quantity.dimension
      && sourceQuantity.context === quantity.context
      && sourceQuantity.polarity === quantity.polarity
      && quantity.context !== 'unclassified'
      && (sourceQuantity.range || quantity.range
        ? sourceQuantity.range === quantity.range
        : quantity.dimension === 'bluetooth-version'
        ? sourceQuantity.value === quantity.value
        : typeof quantity.value === 'number'
          && typeof sourceQuantity.value === 'number'
          && quantityBoundSupports(
            sourceQuantity.bound,
            quantity.bound,
            sourceQuantity.value,
            quantity.value,
          ))
    ));
    if (!supported) unsupported.push(`unsupported-${quantity.dimension}`);
  }
  const numericRanges = /(?:до|up to|less than|более чем|свыше)\s+\d+(?:[.,]\d+)?\s*(?:раз|times|x\b|fold)/giu;
  const intervalPattern = /\d+(?:[.,]\d+)?\s*(?:[-–—]|\bto\b)\s*\d+(?:[.,]\d+)?\s*(?:milliseconds?|seconds?|minutes?|hours?|days?|years?|секунд[\p{L}]*|минут[\p{L}]*|час[\p{L}]*|дн[\p{L}]*|год[\p{L}]*|лет)(?=$|[\s.,!?;:])/giu;
  const unsupportedRange = rawOutputTexts.some((text) => (
    [...text.toLocaleLowerCase().matchAll(numericRanges)]
      .some((match) => !sourceText.includes(normalizeClaimText(match[0])))
    || [...text.toLocaleLowerCase().matchAll(intervalPattern)].length > 0
  ));
  if (unsupportedRange) {
    unsupported.push('unsupported-numeric-range');
  }
  return [...new Set([
    ...unsupported,
    ...outputTexts.flatMap((text) => unsupportedUnknownAssertions(text, sourceText, extractRuleFacts(text))),
    ...outputTexts.flatMap((text) => unsupportedTechnicalFeatures(text, sourceText, extractRuleFacts(text))),
  ])];
}

/** Coerces whatever the model returned into the four script fields. */
export function normalizeScript(content) {
  const clean = (value, maxLen) =>
    cleanText(typeof value === 'string' ? value.replace(/^["«'„“”]+|["»'„“”]+$/g, '') : '', maxLen);
  return {
    hook: clean(content?.hook, FIELD_LIMITS.hook),
    benefit1: clean(content?.benefit1, FIELD_LIMITS.benefit1),
    benefit2: clean(content?.benefit2, FIELD_LIMITS.benefit2),
    cta: clean(content?.cta, FIELD_LIMITS.cta),
  };
}

/** Validates the four required script fields and their requested language. */
export function validateScript(script, { language } = {}) {
  const missing = SCRIPT_FIELDS.filter((f) => !script[f]);
  if (missing.length) throw new Error(`incomplete script (missing ${missing.join(', ')})`);

  const letters = SCRIPT_FIELDS.map((f) => script[f]).join(' ').replace(/[^\p{L}]/gu, '');
  const cyrillic = (letters.match(/[\u0400-\u04FF]/g) || []).length;

  // Russian must be mostly Cyrillic; any other language must not be Cyrillic at all.
  if (language === 'ru' && (!cyrillic || cyrillic / letters.length < 0.5)) throw new Error('script is not in Russian');
  if (language !== 'ru' && cyrillic) throw new Error(`script is not in ${LANGUAGES[language] || language}`);

  const foreign = foreignFields(script, language);
  if (foreign.length) throw new Error(`script has ${foreign.join(', ')} in the wrong language`);

  return script;
}

export function validateScriptText(text, { language } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('complete ad text is missing');
  validateScript(
    { hook: text, benefit1: text, benefit2: text, cta: text },
    { language },
  );
  return text;
}

export function validateGeneratedScript(script, source, fullText, { language, provider } = {}) {
  let completeText;
  try {
    validateScript(script, { language });
    completeText = typeof fullText === 'string' && fullText.trim()
      ? fullText
      : SCRIPT_FIELDS.map((field) => script[field]).join('. ');
    validateScriptText(completeText, { language });
  } catch {
    throw new AiError('script_validation', 'Generated script failed structural validation', { provider });
  }
  let unsupported;
  try {
    unsupported = findUnsupportedScriptClaims(script, source, completeText, { language });
  } catch {
    throw new AiError('claim_validation', 'Generated script failed factual validation', { provider });
  }
  if (unsupported.length) {
    throw new AiError('claim_validation', 'Generated script failed factual validation', { provider });
  }
  return { script, fullText: completeText };
}