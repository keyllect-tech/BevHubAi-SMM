import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSpeech } from '../server/media.js';

const script = {
  hook: 'Смотрите',
  benefit1: 'Первое преимущество',
  benefit2: 'Второе преимущество',
  cta: 'Закажите сейчас',
};

test('generateSpeech returns the aligned voice produced by a provider', async () => {
  const spoken = {
    clips: ['synthetic-1.mp3', 'synthetic-2.mp3', 'synthetic-3.mp3', 'synthetic-4.mp3'],
    provider: 'mock',
    voice: 'Synthetic Voice',
    gender: 'female',
    voiceLanguage: 'ru',
    exactLanguage: true,
    warning: '',
  };

  const result = await generateSpeech(script, 'ru', 'female', 'synthetic-work-dir', {
    synthesizeImpl: async (input) => {
      assert.deepEqual(input.texts, ['Смотрите', 'Первое преимущество', 'Второе преимущество', 'Закажите сейчас']);
      assert.equal(input.language, 'ru');
      assert.equal(input.gender, 'female');
      return spoken;
    },
    alignImpl: async (clips, workDir) => {
      assert.deepEqual(clips, spoken.clips);
      assert.equal(workDir, 'synthetic-work-dir');
      return 'synthetic-work-dir/voice.wav';
    },
  });

  assert.equal(result.path, 'synthetic-work-dir/voice.wav');
  assert.equal(result.kind, 'tts-mock');
  assert.equal(result.aligned, true);
  assert.equal(result.duration, 15);
});

test('generateSpeech rejects when all TTS providers fail instead of returning silence', async () => {
  await assert.rejects(
    generateSpeech(script, 'ru', 'female', 'synthetic-work-dir', {
      synthesizeImpl: async () => {
        throw new Error('all synthetic TTS providers failed');
      },
      alignImpl: async () => assert.fail('alignment must not run without generated speech'),
    }),
    /all synthetic TTS providers failed/,
  );
});
