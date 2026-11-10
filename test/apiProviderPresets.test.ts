// 붙여넣은 키의 접두사로 제공자를 추측하는 순수 로직 검증(형식이 확실한 것만 자동 인식)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_PROVIDER_PRESETS, detectProvider } from '../src/apiProviderPresets';

test('Gemini 키(AIza로 시작)를 인식한다', () => {
  assert.equal(detectProvider('AIzaSyABCDEF1234567890')?.id, 'gemini');
});

test('Groq 키(gsk_로 시작)를 인식한다', () => {
  assert.equal(detectProvider('gsk_abcdefgh12345678')?.id, 'groq');
});

test('OpenRouter 키(sk-or-v1-로 시작)를 인식한다', () => {
  assert.equal(detectProvider('sk-or-v1-abcdef1234567890')?.id, 'openrouter');
});

test('어느 접두사와도 안 맞으면 undefined(추측하지 않음)', () => {
  assert.equal(detectProvider('sk-ant-api03-abcdef'), undefined);
  assert.equal(detectProvider('아무거나'), undefined);
  assert.equal(detectProvider(''), undefined);
});

test('접두사가 비슷해도 OpenRouter(sk-or-v1-)가 다른 sk- 계열과 안 겹친다', () => {
  assert.equal(detectProvider('sk-proj-abcdef')?.id, undefined); // OpenAI는 프리셋에 없음
});

test('프리셋마다 base URL·기본 모델·발급 페이지가 있다', () => {
  for (const preset of API_PROVIDER_PRESETS) {
    assert.ok(preset.baseUrl.startsWith('https://'));
    assert.ok(preset.defaultModel.length > 0);
    assert.ok(preset.getKeyUrl.startsWith('https://'));
  }
});
