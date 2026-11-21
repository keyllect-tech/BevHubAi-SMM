import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submitCreateVideo,
  validateCreateVideo,
  validateWizardStep,
} from '../src/lib/create-video-validation.ts';

const validInput = () => ({
  productName: 'Product',
  productDescription: 'Product description',
  cta: 'Buy now',
  websiteUrl: 'https://example.test',
  images: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  uploading: false,
  generatingImage: false,
  language: 'ru',
  voiceType: 'female',
  style: 'dynamic',
  scriptData: {
    hook: 'Hook',
    benefit1: 'Benefit one',
    benefit2: 'Benefit two',
    cta: 'Call to action',
  },
});

test('advertisement step requires name, description, CTA, and an http(s) URL when supplied', () => {
  const input = validInput();
  assert.equal(validateWizardStep(0, { ...input, productName: '  ' })?.step, 0);
  assert.match(validateWizardStep(0, { ...input, productDescription: '' })?.message || '', /описание/i);
  assert.match(validateWizardStep(0, { ...input, cta: ' ' })?.message || '', /призыв/i);
  assert.match(validateWizardStep(0, { ...input, websiteUrl: 'ftp://example.test' })?.message || '', /http/i);
  assert.equal(validateWizardStep(0, { ...input, websiteUrl: '' }), null);
});

test('photo step requires an uploaded image with a UUID and no active upload', () => {
  const input = validInput();
  assert.match(validateWizardStep(1, { ...input, images: [] })?.message || '', /фото/i);
  assert.match(validateWizardStep(1, { ...input, images: [{ id: 'not-a-uuid' }] })?.message || '', /некорректно/i);
  assert.match(validateWizardStep(1, { ...input, uploading: true })?.message || '', /Дождитесь/i);
  assert.equal(validateWizardStep(1, input), null);
});

test('voice and style steps reject unsupported values', () => {
  const input = validInput();
  assert.match(validateWizardStep(2, { ...input, language: 'fr' })?.message || '', /язык/i);
  assert.match(validateWizardStep(2, { ...input, voiceType: 'robot' })?.message || '', /голоса/i);
  assert.match(validateWizardStep(3, { ...input, style: 'cinematic' })?.message || '', /стиль/i);
  assert.equal(validateWizardStep(2, input), null);
  assert.equal(validateWizardStep(3, input), null);
});

test('video submission does not call createVideo for invalid form data', async () => {
  let calls = 0;
  const result = await submitCreateVideo(
    { ...validInput(), images: [] },
    async () => { calls++; },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issue.step, 1);
  assert.equal(calls, 0);
});

test('video submission calls createVideo with valid required script and form data', async () => {
  const expected = { video: { id: 'video-id' } };
  let submitted;
  const result = await submitCreateVideo(validInput(), async (input) => {
    submitted = input;
    return expected;
  });

  assert.equal(result.valid, true);
  assert.equal(result.result, expected);
  assert.deepEqual(submitted.scriptData, validInput().scriptData);
});

test('missing or incomplete script prevents video submission and can be retried', async () => {
  let calls = 0;
  const missingScript = await submitCreateVideo(
    { ...validInput(), scriptData: null },
    async () => { calls++; },
  );
  const incompleteScript = await submitCreateVideo(
    { ...validInput(), scriptData: { ...validInput().scriptData, benefit1: ' ' } },
    async () => { calls++; },
  );

  assert.equal(missingScript.valid, false);
  assert.equal(missingScript.issue.step, 4);
  assert.match(missingScript.issue.message, /Повторите генерацию/i);
  assert.equal(incompleteScript.valid, false);
  assert.equal(incompleteScript.issue.step, 4);
  assert.equal(calls, 0);
});

test('full validation identifies the first invalid wizard step', () => {
  const validation = validateCreateVideo({ ...validInput(), language: 'fr', style: 'unknown' });
  assert.equal(validation.valid, false);
  assert.equal(validation.issue.step, 2);
});
