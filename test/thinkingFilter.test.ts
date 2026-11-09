// thinkingFilter의 거부 레코드 판별·사고 텍스트 추출·번역 필요 여부 판별을 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSkippableRecord, extractThinkingText, needsTranslation } from '../src/thinkingFilter';

test('거부/오류 레코드는 건너뛴다', () => {
  assert.equal(isSkippableRecord({ isApiErrorMessage: true }), true);
  assert.equal(isSkippableRecord({ apiRefusalCategory: 'safety' }), true);
  assert.equal(isSkippableRecord({ refusedMessageId: 'abc' }), true);
  assert.equal(isSkippableRecord({}), false);
});

test('thinkingDisplay가 있으면 그 텍스트를 쓴다', () => {
  const record = { thinkingDisplay: 'Planning the approach' };
  assert.equal(extractThinkingText(record), 'Planning the approach');
});

test('thinkingDisplay가 없으면 content[].type==="thinking"에서 찾는다', () => {
  const record = {
    message: { content: [{ type: 'text', text: '본문' }, { type: 'thinking', thinking: 'reasoning text here' }] }
  };
  assert.equal(extractThinkingText(record), 'reasoning text here');
});

test('사고 블록이 전혀 없으면 null', () => {
  assert.equal(extractThinkingText({ message: { content: [{ type: 'text', text: '본문' }] } }), null);
});

test('거부 레코드는 사고 블록이 있어도 null', () => {
  const record = { isApiErrorMessage: true, thinkingDisplay: 'ignored' };
  assert.equal(extractThinkingText(record), null);
});

test('순수 한국어 문장은 번역 불필요', () => {
  assert.equal(needsTranslation('이것은 완전한 한국어 문장입니다 설계를 검토하겠습니다'), false);
});

test('영문 식별자 하나 섞인 한국어 문장은 번역 불필요', () => {
  assert.equal(needsTranslation('useEffect 의존성 배열에 누락된 값이 있다 그래서 고쳐야 한다'), false);
});

test('영어 위주 문단은 번역 필요', () => {
  assert.equal(needsTranslation('I am planning the approach for this component and will write the tests first before implementation'), true);
});
