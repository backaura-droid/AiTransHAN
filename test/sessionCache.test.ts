// SessionCache가 세션별 번역 내역을 보관하고, 상한 초과 시 오래된 세션을 버리며, 퇴출된 세션을 되살리지 않는지 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCache } from '../src/sessionCache';

test('처음 보는 파일은 빈 배열로 시작하고, 다시 부르면 같은 배열을 돌려준다', () => {
  const cache = new SessionCache();
  const a = cache.getOrCreate('a.jsonl');
  assert.deepEqual(a, []);
  cache.appendIfPresent('a.jsonl', '<div>1</div>');
  assert.deepEqual(cache.getOrCreate('a.jsonl'), ['<div>1</div>']);
});

test('상한을 넘으면 가장 먼저 생긴 세션 하나만 삭제된다', () => {
  const cache = new SessionCache(2);
  cache.getOrCreate('a');
  cache.getOrCreate('b');
  cache.getOrCreate('c');
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(cache.get('b'), []);
  assert.deepEqual(cache.get('c'), []);
});

test('기존 세션을 다시 조회하는 것만으로는 아무것도 삭제되지 않는다', () => {
  const cache = new SessionCache(2);
  cache.getOrCreate('a');
  cache.getOrCreate('b');
  cache.getOrCreate('a');
  assert.deepEqual(cache.get('a'), []);
  assert.deepEqual(cache.get('b'), []);
});

test('appendIfPresent는 캐시에 없는 키(퇴출됐거나 만든 적 없음)를 조용히 무시한다', () => {
  const cache = new SessionCache(1);
  cache.appendIfPresent('never', '<div>x</div>');
  assert.equal(cache.get('never'), undefined);

  cache.getOrCreate('old');
  cache.getOrCreate('new'); // old 퇴출
  cache.appendIfPresent('old', '<div>늦게 끝난 번역</div>');
  assert.equal(cache.get('old'), undefined, '퇴출된 세션이 되살아나면 안 된다');
});

test('세션당 내역도 상한까지만 남긴다(앞쪽부터 삭제)', () => {
  const cache = new SessionCache(10, 3);
  cache.getOrCreate('a');
  for (let i = 0; i < 5; i++) cache.appendIfPresent('a', `e${i}`);
  assert.deepEqual(cache.get('a'), ['e2', 'e3', 'e4']);
});

// 2026-11-10: "전체 지우기" 명령이 패널만 비우고 캐시는 그대로 두면, 지운 뒤 다른 탭에
// 갔다가 돌아왔을 때 지운 내역이 캐시에서 되살아난다. clear()로 그 세션의 캐시도 비워야 한다.
test('clear()로 특정 세션의 캐시를 비우면, 그 뒤 appendIfPresent는 조용히 무시된다(되살아나지 않음)', () => {
  const cache = new SessionCache();
  cache.appendIfPresent('a', '<div>1</div>'); // 아직 세션 없음 — 무시되어야 정상(선행 동작 확인)
  cache.getOrCreate('a');
  cache.appendIfPresent('a', '<div>1</div>');
  cache.clear('a');
  assert.equal(cache.get('a'), undefined);
  cache.appendIfPresent('a', '<div>늦게 끝난 번역</div>');
  assert.equal(cache.get('a'), undefined, 'clear 이후 되살아나면 안 된다');
});

test('clear()는 없는 키를 넘겨도 에러 없이 무시한다', () => {
  const cache = new SessionCache();
  assert.doesNotThrow(() => cache.clear('없는-키'));
});
