// thinkingFilter의 거부 레코드 판별·다중 사고 텍스트 추출·번역 필요 여부 판별을 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSkippableRecord,
  extractThinkingText,
  extractThinkingTexts,
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

// 교차검증 보강: 한 레코드의 content[]에 여러 개의 thinking 블록이 있을 때 모두 추출한다(실측 301건)
test('한 레코드 안에 thinking 블록이 여러 개 있으면 빠짐없이 전부 추출한다', () => {
  const record = {
    message: {
      content: [
        { type: 'thinking', thinking: 'First step of reasoning in English.' },
        { type: 'tool_use', name: 'Read' },
        { type: 'thinking', thinking: 'Second step of reasoning after tool call.' }
      ]
    }
  };
  assert.deepEqual(extractThinkingTexts(record), [
    'First step of reasoning in English.',
    'Second step of reasoning after tool call.'
  ]);
  assert.deepEqual(pickTranslatable([record]), [
    'First step of reasoning in English.',
    'Second step of reasoning after tool call.'
  ]);
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

// 교차검증 보강: 닫히지 않은 백틱, 콜론 구두점(Note:), 슬래시 병기(read/write), 파일명 포함 짧은 영어 문장 미탐 방지
test('홀수 개의 닫히지 않은 백틱이 있어도 다음 줄 영어 문단을 삼키지 않고 번역 대상으로 판정한다', () => {
  const text = 'Wait, there is a stray ` backtick here.\nNow I need to check the implementation details and verify the behavior.';
  assert.equal(needsTranslation(text), true);
});

test('파일 경로와 콜론 구두점이 섞인 짧은 순수 영어 사고 문장도 누락 없이 번역한다', () => {
  assert.equal(needsTranslation('Note: Let me read src/extension.ts first.'), true);
});

// 리뷰 I6: 실제 레코드 모양(거부 레코드 + summarized 표시모드 + 혼합 언어)을 조합한 회귀 테스트.
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
