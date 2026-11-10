// openAiCompatTranslator가 OpenAI 호환 /chat/completions 응답을 올바르게 파싱하고,
// 실패·타임아웃을 거부하는지 검증(실제 네트워크 호출 없이 fetchImpl을 가짜로 치환한다).
// Gemini·Groq·OpenRouter·커스텀 엔드포인트가 전부 이 하나의 클라이언트를 공유한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateViaOpenAiCompat, type FetchFn } from '../src/openAiCompatTranslator';

function fakeOkFetch(responseText: string, captured?: { url?: string; body?: string; auth?: string }): FetchFn {
  return (async (url: string, init?: RequestInit) => {
    if (captured) {
      captured.url = url;
      captured.body = String(init?.body ?? '');
      captured.auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: responseText } }] }),
      text: async () => ''
    } as unknown as Response;
  }) as unknown as FetchFn;
}

test('정상 응답에서 choices[0].message.content를 뽑아낸다', async () => {
  const result = await translateViaOpenAiCompat('hello', {
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'dummy-key',
    fetchImpl: fakeOkFetch('번역된 결과')
  });
  assert.equal(result, '번역된 결과');
});

test('base URL + /chat/completions로 요청하고, 키는 Bearer 헤더·원문은 본문에 실린다', async () => {
  const captured: { url?: string; body?: string; auth?: string } = {};
  await translateViaOpenAiCompat('원문 텍스트', {
    baseUrl: 'https://api.example.com/v1',
    model: 'm1',
    apiKey: 'MY-KEY',
    fetchImpl: fakeOkFetch('ok', captured)
  });
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.auth, 'Bearer MY-KEY');
  assert.ok(captured.body?.includes('원문 텍스트'));
  assert.ok(captured.body?.includes('"model":"m1"'));
  assert.ok(captured.body?.includes('존댓말'), '공용 번역 말투 지침이 system 메시지에 실려야 한다');
});

test('base URL 끝에 슬래시가 있어도 //chat/completions처럼 겹치지 않는다', async () => {
  const captured: { url?: string } = {};
  await translateViaOpenAiCompat('텍스트', {
    baseUrl: 'https://api.example.com/v1/',
    model: 'm1',
    apiKey: 'k',
    fetchImpl: fakeOkFetch('ok', captured)
  });
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
});

test('HTTP 오류 응답이면 거부한다', async () => {
  const fetchImpl: FetchFn = (async () => ({
    ok: false,
    status: 429,
    text: async () => 'RATE_LIMIT',
    json: async () => ({})
  })) as unknown as FetchFn;
  await assert.rejects(
    translateViaOpenAiCompat('텍스트', { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k', fetchImpl }),
    /429/
  );
});

test('응답에 choices가 없거나 내용이 비어있으면 거부한다', async () => {
  const fetchImpl: FetchFn = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [] }),
    text: async () => ''
  })) as unknown as FetchFn;
  await assert.rejects(
    translateViaOpenAiCompat('텍스트', { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k', fetchImpl })
  );
});

test('설정한 시간 안에 타임아웃으로 거부된다', async () => {
  const fetchImpl: FetchFn = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as FetchFn;
  const start = Date.now();
  await assert.rejects(
    translateViaOpenAiCompat('텍스트', {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      fetchImpl,
      timeoutMs: 200
    })
  );
  assert.ok(Date.now() - start < 2000);
});
