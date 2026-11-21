import assert from 'node:assert/strict';
import test from 'node:test';
import { generateScript } from '../server/ai/index.js';
import { createOllamaProvider } from '../server/ai/providers/ollama.js';
import { createChatProvider } from '../server/ai/providers/openai-compatible.js';
import { findUnsupportedScriptClaims, validateGeneratedScript } from '../server/ai/validate.js';

const request = {
  productName: 'Bluetooth-наушники',
  description: 'Bluetooth-наушники для музыки.',
  cta: 'Попробуйте сейчас',
  language: 'ru',
  style: 'product',
  category: 'product',
};

const fields = (benefit1) => ({
  hook: 'Музыка для вашего дня',
  benefit1,
  benefit2: 'Выбирайте настроение',
  cta: 'Попробуйте сейчас',
});

function providerResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function ollamaResponse(content) {
  return new Response(JSON.stringify({
    message: { content: JSON.stringify(content) },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('rejects all ten factuality audit cases and allows neutral copy', (t) => {
  const cases = [
    ['negative ANC source', 'Активное шумоподавление ANC', 'Не поддерживает ANC.', ['noise-cancellation']],
    ['negative waterproof source', 'Защита от воды', 'Не водонепроницаемый корпус.', ['water-resistance']],
    ['inflated battery duration', 'Работают до 100 часов', 'До 10 часов автономной работы.', ['unsupported-time']],
    ['different Bluetooth version', 'Bluetooth 5.3', 'Bluetooth 5.2.', ['unsupported-bluetooth-version']],
    ['different compatibility target', 'Работает с iPhone', 'Совместим с Android.', ['phone-compatibility']],
    ['reversed cable inclusion', 'Кабель входит в комплект', 'Кабель не входит в комплект.', ['included-cable']],
    ['negated fast charging', 'Быстрая зарядка', 'Не поддерживает быструю зарядку.', ['fast-charging']],
    ['different charging duration', 'Зарядка за 20 минут', 'Время зарядки — 2 часа.', ['unsupported-time']],
    ['different material', 'Металлический корпус', 'Корпус из пластика.', ['metal-material']],
    ['neutral advertising', 'Идеальный выбор для вашего дня', 'Bluetooth-наушники.', []],
  ];

  for (const [name, claim, description, expected] of cases) {
    t.test(name, () => {
      assert.deepEqual(
        findUnsupportedScriptClaims(fields(claim), { productName: 'Наушники', description }),
        expected,
      );
    });
  }
});

test('keeps different numeric facts and device targets from corroborating each other', () => {
  assert.deepEqual(
    findUnsupportedScriptClaims(fields('Автономность до 10 часов, зарядка 20 минут.'), {
      productName: 'Наушники',
      description: 'Автономность до 10 часов, время зарядки 2 часа.',
    }),
    ['unsupported-time'],
  );
  assert.deepEqual(
    findUnsupportedScriptClaims(fields('Совместим с Android и iPhone.'), {
      productName: 'Наушники',
      description: 'Совместим с Android.',
    }),
    ['phone-compatibility'],
  );
});

test('numeric validation respects boundaries, units, locale separators, signs, and Bluetooth versions', () => {
  const check = (claim, description, language = 'ru') => findUnsupportedScriptClaims(
    fields(claim),
    { productName: 'Наушники', description },
    '',
    { language },
  );

  assert.deepEqual(check('До 10 часов автономной работы.', 'Не менее 10 часов автономной работы.'), ['unsupported-time']);
  assert.deepEqual(check('До 24 часов автономной работы.', 'До 1 дня автономной работы.'), []);
  assert.deepEqual(check('Работают до 10–12 часов.', 'Автономность 10 часов.'), ['unsupported-time', 'unsupported-numeric-range']);
  assert.deepEqual(check('Power 1.000 W.', 'Power 1000 W.', 'en'), ['unsupported-power']);
  assert.deepEqual(check('Power 1000 W.', 'Power 1,000 W.', 'en'), []);
  assert.deepEqual(check('Power 1000.5 W.', 'Power 1,000.5 W.', 'en'), []);
  assert.deepEqual(check('Power 1000.5 W.', 'Power 1.000,5 W.', 'en'), ['unsupported-power']);
  assert.deepEqual(check('Power 1 mW.', 'Power 1 MW.', 'en'), ['unsupported-power']);
  assert.deepEqual(check('Output power 10 W.', 'Output power -10 W.', 'en'), ['unsupported-power']);
  assert.deepEqual(check('Bluetooth 6.', 'Bluetooth 5.2.'), ['unsupported-bluetooth-version']);
  assert.deepEqual(check('Bluetooth 5.2.', 'Bluetooth 5.2.'), []);
});

test('a range in the product description does not prove its upper endpoint as an exact claim', () => {
  const check = (claim) => findUnsupportedScriptClaims(
    fields(claim),
    { productName: 'Наушники', description: 'Автономность 10–12 часов.' },
    '',
    { language: 'ru' },
  );

  assert.deepEqual(check('Автономность 12 часов.'), ['unsupported-time']);
});

test('Uzbek validation rejects English copy and accepts Uzbek Latin copy', () => {
  const source = { productName: 'Bluetooth headphones', description: 'Wireless headphones for music.' };
  const english = {
    hook: 'Choose the best headphones',
    benefit1: 'Enjoy music for your day',
    benefit2: 'Find a style for you',
    cta: 'Order today',
  };
  const uzbek = {
    hook: 'Yangi kun uchun musiqa',
    benefit1: 'Sifatli mahsulot siz uchun',
    benefit2: 'Biz bilan qulay tanlov',
    cta: 'Buyurtma bering',
  };

  assert.throws(
    () => validateGeneratedScript(english, source, undefined, { language: 'uz' }),
    (error) => error.code === 'script_validation',
  );
  assert.deepEqual(
    validateGeneratedScript(uzbek, source, undefined, { language: 'uz' }).script,
    uzbek,
  );
});

test.todo('rejects headphones ANC when only the charging case ANC is described');

test('OpenAI-compatible and Ollama providers both reject unsupported claims locally', async () => {
  const unsupported = fields('Водонепроницаемый корпус');
  const chat = createChatProvider({
    id: 'openai',
    label: 'Mock',
    baseUrl: 'https://mock.invalid/v1',
    model: 'mock-model',
    apiKey: 'not-a-real-key',
    fetchImpl: async () => providerResponse(unsupported),
  });
  const ollama = createOllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'mock-model',
    fetchImpl: async () => ollamaResponse(unsupported),
  });

  await assert.rejects(chat.generate(request), (error) => error.code === 'claim_validation');
  await assert.rejects(ollama.generate(request), (error) => error.code === 'claim_validation');
});

test('the orchestrator validates template output and does not fall back after a claim rejection', async () => {
  const rejectedProvider = {
    id: 'openai',
    label: 'Mock',
    model: 'mock-model',
    isConfigured: () => true,
    isAvailable: () => true,
    noteFailure() {},
    async generate() {
      return { script: fields('Водонепроницаемый корпус'), model: 'mock-model' };
    },
  };
  let templateCalls = 0;
  await assert.rejects(
    generateScript(request, {
      providers: [rejectedProvider],
      templateGenerator: () => {
        templateCalls += 1;
        return { script: fields('Нейтральный рекламный текст'), warning: '' };
      },
    }),
    (error) => error.code === 'claim_validation',
  );
  assert.equal(templateCalls, 0);

  const incompleteProvider = {
    ...rejectedProvider,
    async generate() {
      return { script: { hook: 'Сценарий', benefit1: '', benefit2: '', cta: 'Попробуйте' } };
    },
  };
  await assert.rejects(
    generateScript(request, {
      providers: [incompleteProvider],
      templateGenerator: () => {
        templateCalls += 1;
        return { script: fields('Нейтральный рекламный текст'), warning: '' };
      },
    }),
    (error) => error.code === 'script_validation',
  );
  assert.equal(templateCalls, 0);

  const result = await generateScript(request, { providers: [] });
  assert.equal(result.source.kind, 'template');
  assert.deepEqual(
    findUnsupportedScriptClaims(result.script, request, result.fullText, { language: request.language }),
    [],
  );
});
