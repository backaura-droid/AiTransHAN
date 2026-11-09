// TranslationQueue가 동시 실행 없이 순서대로 처리하고, 실패해도 멈추지 않는지 검증하는 테스트
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
  q.enqueue('a');
  q.enqueue('b');
  q.enqueue('c');
  await delay(100, null);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxConcurrent, 1);
});

test('번역 실패해도 큐가 멈추지 않고 다음 항목을 처리한다', async () => {
  const results: Array<{ input: string; ok: boolean }> = [];
  const q = new TranslationQueue(
    async (text) => {
      if (text === 'fail') throw new Error('agy 실패');
      return `번역:${text}`;
    },
    (input, result) => results.push({ input, ok: result.ok })
  );
  q.enqueue('fail');
  q.enqueue('ok-after');
  await delay(50, null);
  assert.deepEqual(results, [
    { input: 'fail', ok: false },
    { input: 'ok-after', ok: true }
  ]);
});
