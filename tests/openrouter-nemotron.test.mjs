import assert from 'node:assert/strict';
import test from 'node:test';
import { AiError, toClientAiError } from '../server/ai/errors.js';
import {
  createOpenRouterNemotronProvider,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_ENDPOINT,
} from '../server/ai/providers/openrouter-nemotron.js';
import { findUnsupportedScriptClaims } from '../server/ai/validate.js';

const input = {
  productName: 'Чай',
  description: 'Натуральный чай с мягким вкусом',
  cta: 'Попробуйте сейчас',
  language: 'ru',
  style: 'product',
  category: 'product',
};

const script = {
  hook: 'Откройте вкус природы',
  benefit1: 'Натуральный чай каждый день',
  benefit2: 'Мягкий вкус для отдыха',
  cta: 'Попробуйте сейчас',
  fullText: 'Откройте вкус природы Натуральный чай каждый день Мягкий вкус для отдыха Попробуйте сейчас',
};
const headphonesInput = {
  productName: 'Беспроводные Bluetooth-наушники',
  description: 'Наушники для молодых людей.',
  cta: 'Попробуйте сейчас',
  language: 'ru',
  style: 'dynamic',
  category: 'product',
};

function providerResponse({ status = 200, content = JSON.stringify(script), headers = {} } = {}) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function createProvider(fetchImpl, options = {}) {
  return createOpenRouterNemotronProvider({
    apiKey: 'test-secret',
    fetchImpl,
    ...options,
  });
}

function claimScript(benefit1) {
  return {
    hook: 'Свободный ритм',
    benefit1,
    benefit2: 'Музыка для каждого момента',
    cta: 'Попробуйте сейчас',
  };
}

test('success sends a bounded OpenRouter request and validates the complete Russian script', async () => {
  let requestUrl;
  let requestOptions;
  const provider = createProvider(async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return providerResponse();
  });

  const result = await provider.generate(input);
  const body = JSON.parse(requestOptions.body);

  assert.equal(requestUrl, OPENROUTER_ENDPOINT);
  assert.equal(requestOptions.method, 'POST');
  assert.equal(requestOptions.headers.Authorization, 'Bearer test-secret');
  assert.equal(body.model, DEFAULT_OPENROUTER_MODEL);
  assert.equal(body.response_format.type, 'json_object');
  assert.match(body.messages[0].content, /fullText/);
  assert.match(body.messages[0].content, /only evidence for product properties/);
  assert.match(body.messages[0].content, /one-button pairing/);
  assert.deepEqual(result.script, {
    hook: script.hook,
    benefit1: script.benefit1,
    benefit2: script.benefit2,
    cta: script.cta,
  });
  assert.equal(result.fullText, script.fullText);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

test('unsupported one-button Bluetooth pairing is detected and rejected', async () => {
  const unsupportedScript = {
    hook: 'Свободный звук без проводов',
    benefit1: 'Наслаждайтесь музыкой каждый день',
    benefit2: 'Мгновенное соединение с телефоном одной кнопкой',
    cta: 'Попробуйте сейчас',
  };
  const fullText = Object.values(unsupportedScript).join(' ');
  assert.deepEqual(
    findUnsupportedScriptClaims(unsupportedScript, headphonesInput, fullText),
    ['one-touch-pairing', 'fast-connection', 'phone-compatibility'],
  );
  const provider = createProvider(async () => providerResponse({
    content: JSON.stringify({ ...unsupportedScript, fullText }),
  }));
  await assert.rejects(provider.generate(headphonesInput), (error) => (
    error.code === 'claim_validation' && /factual validation/.test(error.message)
  ));
});

test('explicit source facts support matching claims while neutral copy remains accepted', () => {
  const supportedScript = {
    hook: 'Подключение одной кнопкой',
    benefit1: 'Мгновенное соединение с телефоном',
    benefit2: 'Выбирайте музыку под настроение',
    cta: 'Попробуйте сейчас',
  };
  const supportedSource = {
    productName: headphonesInput.productName,
    description: 'Сопряжение с телефоном одной кнопкой и мгновенное соединение.',
  };
  assert.deepEqual(findUnsupportedScriptClaims(supportedScript, supportedSource), []);

  const neutralScript = {
    hook: 'Поймай свой ритм',
    benefit1: 'Музыка рядом в каждом моменте',
    benefit2: 'Выбирай настроение и наслаждайся моментом',
    cta: 'Попробуй сегодня',
  };
  assert.deepEqual(findUnsupportedScriptClaims(neutralScript, headphonesInput), []);
});

test('local checks detect unsupported features, materials, measurements, and CTA guarantees', () => {
  const featureScript = {
    hook: 'Лучший звук сегодня',
    benefit1: 'Активное шумоподавление для поездок',
    benefit2: 'Работают до 24 часов в день',
    cta: 'Гарантированно получите идеальный звук',
  };
  assert.deepEqual(findUnsupportedScriptClaims(featureScript, headphonesInput), [
    'noise-cancellation',
    'ideal-sound-quality',
    'unverified-guarantee',
    'unsupported-time',
  ]);
  assert.deepEqual(findUnsupportedScriptClaims({
    ...featureScript,
    benefit1: 'Корпус из алюминия',
  }, headphonesInput), [
    'ideal-sound-quality',
    'aluminum-material',
    'unverified-guarantee',
    'unsupported-time',
  ]);
});

test('claim validation fails closed across polarity, numbers, aliases, and neutral copy', async (t) => {
  const cases = [
    {
      name: 'accepts an explicitly supported water-resistance claim',
      claim: 'Влагозащищенный корпус',
      description: 'Влагозащищенный корпус.',
      expected: [],
    },
    {
      name: 'does not escalate water resistance to waterproofing',
      claim: 'Водонепроницаемый корпус',
      description: 'Влагозащищенный корпус.',
      expected: ['water-resistance'],
    },
    {
      name: 'rejects unsupported water resistance',
      claim: 'Водонепроницаемый корпус',
      description: 'Наушники для музыки.',
      expected: ['water-resistance'],
    },
    {
      name: 'rejects a claim that contradicts a source negation',
      claim: 'Водонепроницаемый корпус',
      description: 'Корпус не является водонепроницаемым.',
      expected: ['water-resistance'],
    },
    {
      name: 'rejects a cable inclusion claim that reverses the source',
      claim: 'Кабель входит в комплект',
      description: 'Кабель не входит в комплект.',
      expected: ['included-cable'],
    },
    {
      name: 'accepts a matching positive cable inclusion claim',
      claim: 'Кабель входит в комплект',
      description: 'Кабель входит в комплект.',
      expected: [],
    },
    {
      name: 'rejects a different battery duration',
      claim: 'Работают до 24 часов',
      description: 'Автономность составляет 12 часов.',
      expected: ['unsupported-time'],
    },
    {
      name: 'rejects a different connection delay in seconds',
      claim: 'Задержка соединения 2 секунды',
      description: 'Задержка соединения 3 секунды.',
      expected: ['unsupported-time'],
    },
    {
      name: 'matches equivalent charging durations in hours and minutes',
      claim: 'Время зарядки 120 минут',
      description: 'Время зарядки 2 часа.',
      expected: [],
    },
    {
      name: 'matches equivalent day and hour units',
      claim: 'Работают до 24 часов',
      description: 'Автономность составляет 1 день.',
      expected: [],
    },
    {
      name: 'rejects a different warranty term in years',
      claim: 'Гарантия действует 3 года',
      description: 'Гарантия действует 2 года.',
      expected: ['unsupported-time'],
    },
    {
      name: 'matches equivalent warranty terms in years and days',
      claim: 'Гарантия действует 365 дней',
      description: 'Гарантия действует 1 год.',
      expected: [],
    },
    {
      name: 'does not accept a number merely contained in a larger value',
      claim: 'Работают до 112 часов',
      description: 'Автономность составляет 12 часов.',
      expected: ['unsupported-time'],
    },
    {
      name: 'does not reuse warranty duration as battery life',
      claim: 'Работают до 2 лет',
      description: 'Гарантия действует 2 года.',
      expected: ['unsupported-time'],
    },
    {
      name: 'rejects a different percentage',
      claim: 'Скидка 30%',
      description: 'Скидка 20%.',
      expected: ['unsupported-percentage'],
    },
    {
      name: 'rejects a different price',
      claim: 'Цена 700 рублей',
      description: 'Цена 500 рублей.',
      expected: ['unsupported-currency:rub'],
    },
    {
      name: 'rejects a different power rating',
      claim: 'Мощность 10 ватт',
      description: 'Мощность 5 Вт.',
      expected: ['unsupported-power'],
    },
    {
      name: 'accepts equivalent metric distance units',
      claim: 'Дальность 1 км',
      description: 'Дальность 1000 метров.',
      expected: [],
    },
    {
      name: 'accepts equivalent decimal memory units',
      claim: 'Объем памяти 1000 МБ',
      description: 'Объем памяти 1 ГБ.',
      expected: [],
    },
    {
      name: 'rejects a different frequency',
      claim: 'Частота 5 ГГц',
      description: 'Частота 2.4 ГГц.',
      expected: ['unsupported-frequency'],
    },
    {
      name: 'rejects a different Bluetooth version',
      claim: 'Bluetooth 5.3',
      description: 'Bluetooth 5.2.',
      expected: ['unsupported-bluetooth-version'],
    },
    {
      name: 'rejects an instant-connection synonym',
      claim: 'Мгновенное соединение',
      description: 'Bluetooth-наушники.',
      expected: ['fast-connection'],
    },
    {
      name: 'rejects a no-delay connection synonym',
      claim: 'Подключается без задержки',
      description: 'Bluetooth-наушники.',
      expected: ['fast-connection'],
    },
    {
      name: 'rejects pairing in one second',
      claim: 'Сопряжение за секунду',
      description: 'Bluetooth-наушники.',
      expected: ['fast-connection'],
    },
    {
      name: 'rejects all-day battery-life wording',
      claim: 'Работают целые сутки',
      description: 'Bluetooth-наушники.',
      expected: ['battery-life-claim'],
    },
    {
      name: 'does not infer all-day runtime from qualitative battery life',
      claim: 'Работают целые сутки',
      description: 'Долгая автономность.',
      expected: ['battery-life-claim'],
    },
    {
      name: 'rejects unsupported iPhone compatibility',
      claim: 'Совместимы с iPhone',
      description: 'Bluetooth-наушники.',
      expected: ['phone-compatibility'],
    },
    {
      name: 'does not reuse Android compatibility as iPhone compatibility',
      claim: 'Совместимы с iPhone',
      description: 'Совместимы с Android.',
      expected: ['phone-compatibility'],
    },
    {
      name: 'rejects an unsupported water-protection synonym',
      claim: 'Защита от воды',
      description: 'Bluetooth-наушники.',
      expected: ['water-resistance'],
    },
    {
      name: 'rejects unsupported active noise cancellation',
      claim: 'Активное шумоподавление ANC',
      description: 'Bluetooth-наушники.',
      expected: ['noise-cancellation'],
    },
    {
      name: 'rejects an unknown concrete technical feature',
      claim: 'Поддерживает Multipoint',
      description: 'Bluetooth-наушники.',
      expected: ['unclassified-concrete-claim'],
    },
    {
      name: 'does not confirm a feature explicitly negated in the source',
      claim: 'Поддерживает Multipoint',
      description: 'Multipoint не поддерживается.',
      expected: ['unclassified-concrete-claim'],
    },
    {
      name: 'allows neutral advertising language',
      claim: 'Поймай свой ритм и выбери музыку под настроение',
      description: 'Bluetooth-наушники.',
      expected: [],
    },
  ];

  for (const { name, claim, description, expected } of cases) {
    await t.test(name, () => {
      const unsupported = findUnsupportedScriptClaims(
        claimScript(claim),
        { productName: 'Наушники', description },
      );
      assert.deepEqual(unsupported, expected);
    });
  }
});

test('missing API key fails before fetch', async () => {
  let fetchCalls = 0;
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const provider = createOpenRouterNemotronProvider({
    fetchImpl: async () => {
      fetchCalls += 1;
      return providerResponse();
    },
  });
  if (previousKey !== undefined) process.env.OPENROUTER_API_KEY = previousKey;

  await assert.rejects(provider.generate(input), (error) => error.code === 'config');
  assert.equal(fetchCalls, 0);
});

for (const [status, code] of [[401, 'auth'], [402, 'quota'], [403, 'auth'], [404, 'config'], [429, 'rate_limit'], [502, 'server']]) {
  test(`HTTP ${status} maps to a safe ${code} error`, async () => {
    const provider = createProvider(async () => providerResponse({ status, headers: status === 429 ? { 'Retry-After': '15' } : {} }));

    await assert.rejects(provider.generate(input), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.message.includes('test-secret'), false);
      if (status === 429) assert.equal(error.retryAfterMs, 15000);
      return true;
    });
  });
}

test('network failure is reported without exposing the underlying error text', async () => {
  const provider = createProvider(async () => {
    throw new TypeError('fetch failed: test-secret at https://private.invalid');
  });

  await assert.rejects(provider.generate(input), (error) => {
    assert.equal(error.code, 'network');
    assert.equal(error.message, 'OpenRouter is unreachable');
    assert.equal(error.message.includes('private.invalid'), false);
    return true;
  });
});

test('timeout is classified without exposing the underlying error text', async () => {
  const provider = createProvider(async () => {
    throw Object.assign(new Error('timeout test-secret'), { name: 'TimeoutError' });
  });

  await assert.rejects(provider.generate(input), (error) => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.message, 'OpenRouter request timed out');
    return true;
  });
});

test('invalid upstream JSON is rejected safely', async () => {
  const provider = createProvider(async () => new Response('{not json', { status: 200 }));

  await assert.rejects(provider.generate(input), (error) => error.code === 'bad_response');
});

test('invalid model JSON and incomplete scripts are rejected', async () => {
  for (const content of [
    'not json',
    JSON.stringify({ hook: script.hook, benefit1: script.benefit1, cta: script.cta }),
    JSON.stringify({ ...script, hook: 'я'.repeat(81) }),
  ]) {
    const provider = createProvider(async () => providerResponse({ content }));
    await assert.rejects(provider.generate(input), (error) => error.code === 'bad_response');
  }
});

test('wrong-language and inconsistent full text are rejected', async () => {
  const wrongLanguage = { ...script, hook: 'Discover a wonderful taste' };
  const incompleteFullText = { ...script, fullText: 'Откройте вкус природы' };
  const wrongLanguageProvider = createProvider(async () => providerResponse({ content: JSON.stringify(wrongLanguage) }));
  const incompleteFullTextProvider = createProvider(async () => providerResponse({ content: JSON.stringify(incompleteFullText) }));
  await assert.rejects(wrongLanguageProvider.generate(input), (error) => error.code === 'script_validation');
  await assert.rejects(incompleteFullTextProvider.generate(input), (error) => error.code === 'bad_response');
});

test('English and Uzbek outputs are accepted when all script fields match the requested language', async () => {
  const cases = [
    {
      language: 'en',
      script: {
        hook: 'Discover a fresh taste',
        benefit1: 'Natural tea for every day',
        benefit2: 'A gentle taste for rest',
        cta: 'Try it today',
      },
    },
    {
      language: 'uz',
      script: {
        hook: 'Yangi ta’mni kashf eting',
        benefit1: 'Har kuni tabiiy choy',
        benefit2: 'Dam olish uchun mayin ta’m',
        cta: 'Bugun sinab ko’ring',
      },
    },
  ];

  for (const { language, script: fields } of cases) {
    const responseScript = {
      ...fields,
      fullText: Object.values(fields).join(' '),
    };
    const provider = createProvider(async () => providerResponse({ content: JSON.stringify(responseScript) }));
    const result = await provider.generate({ ...input, language });
    assert.equal(result.fullText, responseScript.fullText);
  }
});

test('input limits are enforced before making a request', async () => {
  let fetchCalls = 0;
  const provider = createProvider(async () => {
    fetchCalls += 1;
    return providerResponse();
  });

  await assert.rejects(provider.generate({ ...input, description: 'x'.repeat(601) }), (error) => error.status === 400);
  assert.equal(fetchCalls, 0);
});

test('client-safe mapping covers upstream statuses without exposing details or secrets', () => {
  for (const [status, code, clientStatus] of [
    [401, 'auth', 502],
    [402, 'quota', 503],
    [403, 'auth', 502],
    [404, 'config', 502],
    [429, 'rate_limit', 429],
    [502, 'server', 502],
  ]) {
    const mapped = toClientAiError(new AiError(code, 'upstream included test-secret', {
      status,
      provider: 'openrouter',
    }));
    assert.equal(mapped.status, clientStatus);
    assert.equal(mapped.message.includes('test-secret'), false);
  }
  assert.equal(toClientAiError(new Error('unclassified')), null);
});
