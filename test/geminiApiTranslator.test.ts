// geminiApiTranslator가 Gemini REST API 응답을 올바르게 파싱하고, 실패·타임아웃을 거부하는지 검증
// (실제 네트워크 호출 없이 fetchImpl을 가짜로 치환한다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateWithGeminiApi, type FetchFn } from '../src/geminiApiTranslator';

function fakeOkFetch(responseText: string, captured?: { url?: string; body?: string }): FetchFn {
  return (async (url: string, init?: RequestInit) => {
    if (captured) {
      captured.url = url;
      captured.body = String(init?.body ?? '');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: responseText }] } }] }),
      text: async () => ''
    } as unknown as Response;
  }) as unknown as FetchFn;
}

test('정상 응답에서 candidates[0].content.parts의 text를 뽑아낸다', async () => {
  const result = await translateWithGeminiApi('hello', {
    apiKey: 'dummy-key',
    fetchImpl: fakeOkFetch('번역된 결과용 ㅎㅎ')
  });
  assert.equal(result, '번역된 결과용 ㅎㅎ');
});

test('API 키와 원문이 요청 본문·URL에 올바르게 실린다', async () => {
  const captured: { url?: string; body?: string } = {};
  await translateWithGeminiApi('원문 텍스트', { apiKey: 'MY-KEY', fetchImpl: fakeOkFetch('ok', captured) });
  assert.ok(captured.url?.includes('key=MY-KEY'));
  assert.ok(captured.body?.includes('원문 텍스트'));
  assert.ok(captured.body?.includes('존댓말'), '공용 번역 말투 지침이 systemInstruction에 실려야 한다');
});

test('HTTP 오류 응답이면 거부한다', async () => {
  const fetchImpl: FetchFn = (async () => ({
    ok: false,
    status: 429,
    text: async () => 'RATE_LIMIT',
    json: async () => ({})
  })) as unknown as FetchFn;
  await assert.rejects(translateWithGeminiApi('텍스트', { apiKey: 'k', fetchImpl }), /429/);
});

test('응답에 candidates가 없으면 거부한다', async () => {
  const fetchImpl: FetchFn = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [] }),
    text: async () => ''
  })) as unknown as FetchFn;
  await assert.rejects(translateWithGeminiApi('텍스트', { apiKey: 'k', fetchImpl }));
});

test('설정한 시간 안에 타임아웃으로 거부된다', async () => {
  const fetchImpl: FetchFn = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as FetchFn;
  const start = Date.now();
  await assert.rejects(translateWithGeminiApi('텍스트', { apiKey: 'k', fetchImpl, timeoutMs: 200 }));
  assert.ok(Date.now() - start < 2000);
});
