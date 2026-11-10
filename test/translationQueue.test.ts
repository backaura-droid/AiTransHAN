// TranslationQueue가 동시 실행 없이 순서대로 처리하고, 실패해도 멈추지 않으며, filePath를 결과까지 그대로 넘기는지 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationQueue } from '../src/translationQueue';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('동시에 두 건이 겹치지 않고 순서대로 처리된다', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const order: string[] = [];
  const q = new TranslationQueue(
    async (text) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(20, null);
      running--;
      order.push(text);
      return `번역:${text}`;
    },
    () => {}
  );
  q.enqueue('f', 'a');
  q.enqueue('f', 'b');
  q.enqueue('f', 'c');
  await delay(100, null);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxConcurrent, 1);
});

test('번역 실패해도 큐가 멈추지 않고 다음 항목을 처리한다', async () => {
  const results: Array<{ filePath: string; input: string; ok: boolean }> = [];
  const q = new TranslationQueue(
    async (text) => {
      if (text === 'fail') throw new Error('agy 실패');
      return `번역:${text}`;
    },
    (filePath, input, result) => results.push({ filePath, input, ok: result.ok })
  );
  q.enqueue('A.jsonl', 'fail');
  q.enqueue('A.jsonl', 'ok-after');
  await delay(50, null);
  assert.deepEqual(results, [
    { filePath: 'A.jsonl', input: 'fail', ok: false },
    { filePath: 'A.jsonl', input: 'ok-after', ok: true }
  ]);
});

// 2026-11-10: agy 호출 왕복(12~14초)이 걸리는 동안 패널이 멈춘 것처럼 보인다는 피드백 —
// "번역 중" 표시를 깜빡이게 할 수 있도록, 큐가 바쁜 상태로 전환/해제되는 시점을 알려줘야 한다.
test('onBusyChange: 처리 시작 시 true, 큐가 완전히 빌 때 false를 딱 한 번씩만 알린다', async () => {
  const busyHistory: boolean[] = [];
  const q = new TranslationQueue(
    async (text) => {
      await delay(15, null);
      return text;
    },
    () => {},
    (busy) => busyHistory.push(busy)
  );
  q.enqueue('f', 'a');
  q.enqueue('f', 'b'); // 이미 처리 중이므로 true가 중복으로 더 오면 안 된다
  await delay(60, null);
  assert.deepEqual(busyHistory, [true, false]);
});

test('onBusyChange 없이 써도(생략) 에러 없이 동작한다', async () => {
  const q = new TranslationQueue(
    async (text) => text,
    () => {}
  );
  q.enqueue('f', 'a');
  await delay(20, null);
  // 에러 없이 여기까지 오면 통과
});

test('여러 세션 항목이 섞여도 각 결과에 자기 filePath가 그대로 붙어 FIFO로 나온다', async () => {
  const results: string[] = [];
  const q = new TranslationQueue(
    async (text) => {
      await delay(5, null);
      return `번역:${text}`;
    },
    (filePath, input, result) => results.push(`${filePath}|${input}|${result.ok ? result.text : ''}`)
  );
  q.enqueue('A', 'a1');
  q.enqueue('B', 'b1');
  q.enqueue('A', 'a2');
  await delay(60, null);
  assert.deepEqual(results, ['A|a1|번역:a1', 'B|b1|번역:b1', 'A|a2|번역:a2']);
});

// 2026-11-10: 모든 탭을 동시에 감시하게 되면서 백그라운드 탭 항목이 큐에 섞인다 —
// 지금 보고 있는 탭의 항목을 먼저 뽑되, 같은 파일끼리는 원래 순서를 지켜야 한다.
test('setActiveFile: 활성 파일 항목을 먼저 처리하고, 나머지는 원래 순서(FIFO)를 지킨다', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new TranslationQueue(
    async (text) => {
      if (text === 'first') await gate; // 첫 항목 처리 중에 나머지를 쌓는다
      order.push(text);
      return text;
    },
    () => {}
  );
  q.setActiveFile('B');
  q.enqueue('X', 'first');
  q.enqueue('A', 'a1');
  q.enqueue('A', 'a2');
  q.enqueue('B', 'b1');
  q.enqueue('B', 'b2');
  release();
  await delay(30, null);
  assert.deepEqual(order, ['first', 'b1', 'b2', 'a1', 'a2']);
});

test('setActiveFile(null)이면 순수 FIFO로 처리한다', async () => {
  const order: string[] = [];
  const q = new TranslationQueue(
    async (text) => {
      order.push(text);
      return text;
    },
    () => {}
  );
  q.setActiveFile('B');
  q.setActiveFile(null);
  q.enqueue('A', 'a1');
  q.enqueue('B', 'b1');
  q.enqueue('A', 'a2');
  await delay(30, null);
  assert.deepEqual(order, ['a1', 'b1', 'a2']);
});
