// thinkingFilter의 거부 레코드 판별·사고 텍스트 추출·번역 필요 여부 판별을 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSkippableRecord,
  extractThinkingText,
  needsTranslation,
  pickTranslatable
} from '../src/thinkingFilter';

test('거부/오류 레코드는 건너뛴다', () => {
  assert.equal(isSkippableRecord({ isApiErrorMessage: true }), true);
  assert.equal(isSkippableRecord({ apiRefusalCategory: 'safety' }), true);
  assert.equal(isSkippableRecord({ refusedMessageId: 'abc' }), true);
  assert.equal(isSkippableRecord({}), false);
});

// 리뷰 C2: thinkingDisplay는 실데이터에서 항상 "summarized" 같은 표시 모드 플래그였고
// 실제 사고 텍스트가 아니었다(667/716건 실측). content[].thinking이 진짜 본문이다.
test('thinkingDisplay가 summarized여도 content[].thinking의 실제 텍스트를 쓴다', () => {
  const record = {
    thinkingDisplay: 'summarized',
    message: {
      content: [{ type: 'thinking', thinking: 'actual reasoning text', signature: 'sig123' }]
    }
  };
  assert.equal(extractThinkingText(record), 'actual reasoning text');
});

test('content[].type==="thinking"에서 찾는다', () => {
  const record = {
    message: { content: [{ type: 'text', text: '본문' }, { type: 'thinking', thinking: 'reasoning text here' }] }
  };
  assert.equal(extractThinkingText(record), 'reasoning text here');
});

test('사고 블록이 전혀 없으면 null', () => {
  assert.equal(extractThinkingText({ message: { content: [{ type: 'text', text: '본문' }] } }), null);
});

test('거부 레코드는 사고 블록이 있어도 null', () => {
  const record = {
    isApiErrorMessage: true,
    message: { content: [{ type: 'thinking', thinking: 'ignored' }] }
  };
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

// 리뷰 I2: 백틱 코드 스팬·경로/파일명 토큰은 한글 비율 계산에서 빼야
// 사용자가 실제로 쓰는 "코드 식별자·경로 섞인 한국어 문장"이 오탐으로 번역 큐에 들어가지 않는다.
test('백틱 코드 스팬이 섞인 한국어 문장은 번역 불필요', () => {
  assert.equal(
    needsTranslation('`src/agyTranslator.ts`의 `defaultCommandBuilder`를 확인했다'),
    false
  );
});

test('윈도우 경로가 섞인 한국어 문장은 번역 불필요', () => {
  assert.equal(
    needsTranslation('C:\\Users\\user\\claude-thinking-ko\\src\\extension.ts 파일에서 오류가 났다'),
    false
  );
});

// 리뷰 I6: 실제 레코드 모양(거부 레코드 + summarized 표시모드 + 혼합 언어)을 조합한 회귀 테스트.
// C1·C2 같은 "필드 이름은 맞는데 값/위치 가정이 틀린" 버그를 가장 싸게 잡아낼 수 있는 자리다.
test('실제 레코드 모양 조합에서 번역 대상만 정확히 뽑는다', () => {
  const records: unknown[] = [
    { type: 'queue-operation' },
    {
      isApiErrorMessage: true,
      thinkingDisplay: 'summarized',
      message: { content: [{ type: 'thinking', thinking: 'ignored because refusal' }] }
    },
    {
      thinkingDisplay: 'summarized',
      message: {
        content: [{ type: 'thinking', thinking: '이미 완전한 한국어 문장이라 번역이 필요 없다 이것도 한국어다' }]
      }
    },
    {
      thinkingDisplay: 'summarized',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'I am planning the approach for this component and will write the tests before implementation'
          }
        ]
      }
    }
  ];
  assert.deepEqual(pickTranslatable(records), [
    'I am planning the approach for this component and will write the tests before implementation'
  ]);
});
