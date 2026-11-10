// SessionWatcherPool이 파일별 감시자를 중복 없이 열고, 상한 초과 시 비활성 파일 중 가장 오래된 것만 끊는지 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionWatcherPool } from '../src/sessionWatcherPool';

function fakeWatch() {
  const opened: string[] = [];
  const closed: string[] = [];
  const listeners = new Map<string, () => void>();
  const watchImpl = (filePath: string, listener: () => void) => {
    opened.push(filePath);
    listeners.set(filePath, listener);
    return { close: () => closed.push(filePath) };
  };
  return { opened, closed, listeners, watchImpl };
}

test('같은 파일을 여러 번 ensureWatching해도 감시자는 하나만 연다', () => {
  const w = fakeWatch();
  const pool = new SessionWatcherPool({ onChange: () => {}, watchImpl: w.watchImpl });
  pool.ensureWatching('A');
  pool.ensureWatching('A');
  assert.deepEqual(w.opened, ['A']);
  assert.equal(pool.isWatching('A'), true);
  assert.equal(pool.isWatching('B'), false);
});

test('감시자 콜백이 오면 onChange에 파일 경로를 넘긴다', () => {
  const w = fakeWatch();
  const changed: string[] = [];
  const pool = new SessionWatcherPool({ onChange: (f) => changed.push(f), watchImpl: w.watchImpl });
  pool.ensureWatching('A');
  w.listeners.get('A')!();
  assert.deepEqual(changed, ['A']);
});

test('상한 초과 시 비활성 파일 중 가장 오래전에 markActive된 것부터 끊는다', () => {
  const w = fakeWatch();
  const pool = new SessionWatcherPool({ maxSessions: 3, onChange: () => {}, watchImpl: w.watchImpl });
  pool.ensureWatching('A'); pool.markActive('A');
  pool.ensureWatching('B'); pool.markActive('B');
  pool.ensureWatching('C'); pool.markActive('C');
  pool.markActive('A'); // A가 다시 활성 → 가장 오래된 것은 B
  pool.ensureWatching('D'); pool.markActive('D');
  assert.deepEqual(w.closed, ['B']);
  assert.equal(pool.isWatching('B'), false);
  assert.equal(pool.isWatching('A'), true);
});

test('활성 파일은 상한을 넘겨도 끊지 않는다(가장 오래됐어도)', () => {
  const w = fakeWatch();
  const pool = new SessionWatcherPool({ maxSessions: 2, onChange: () => {}, watchImpl: w.watchImpl });
  pool.ensureWatching('A'); pool.markActive('A');
  pool.ensureWatching('B'); pool.markActive('B');
  // A는 가장 먼저 열렸지만 방금 다시 활성화됐다 → 퇴출 대상이 아니다
  pool.markActive('A');
  pool.ensureWatching('C'); // C 신규 → 활성화 순서상 가장 오래된 B를 끊는다
  assert.deepEqual(w.closed, ['B']);
  assert.equal(pool.isWatching('A'), true);
  assert.equal(pool.isWatching('C'), true);
});

test('끊겼던 파일을 다시 ensureWatching하면 새로 연다', () => {
  const w = fakeWatch();
  const pool = new SessionWatcherPool({ maxSessions: 1, onChange: () => {}, watchImpl: w.watchImpl });
  pool.ensureWatching('A'); pool.markActive('A');
  pool.ensureWatching('B'); pool.markActive('B'); // A 퇴출
  pool.ensureWatching('A'); pool.markActive('A'); // B 퇴출, A 다시 열림
  assert.deepEqual(w.opened, ['A', 'B', 'A']);
  assert.deepEqual(w.closed, ['A', 'B']);
});

test('dispose는 모든 감시자를 닫는다', () => {
  const w = fakeWatch();
  const pool = new SessionWatcherPool({ onChange: () => {}, watchImpl: w.watchImpl });
  pool.ensureWatching('A');
  pool.ensureWatching('B');
  pool.dispose();
  assert.deepEqual(w.closed.sort(), ['A', 'B']);
  assert.equal(pool.isWatching('A'), false);
});
