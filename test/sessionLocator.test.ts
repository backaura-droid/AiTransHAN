// sessionLocator의 cwd 매칭·최신 mtime 선택·깨진 파일 무시·대용량 헤더·감시 전환 결정을 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findActiveSessionFile, decideNextWatch } from '../src/sessionLocator';

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-'));
  return root;
}

test('cwd가 일치하는 파일이 없으면 null', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ cwd: '/other/path' }) + '\n');
  assert.equal(findActiveSessionFile(root, '/my/workspace'), null);
});

test('여러 후보 중 cwd가 일치하면서 mtime이 가장 최근인 파일을 고른다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const older = path.join(dir, 'older.jsonl');
  const newer = path.join(dir, 'newer.jsonl');
  fs.writeFileSync(older, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  fs.writeFileSync(newer, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(newer, new Date(now), new Date(now));
  assert.equal(findActiveSessionFile(root, '/my/workspace'), newer);
});

test('첫 줄이 깨진 JSON인 파일은 무시하고 크래시하지 않는다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{not json');
  assert.equal(findActiveSessionFile(root, '/my/workspace'), null);
});

// 리뷰 C1: 실제 세션 파일 124개 중 0개가 cwd를 첫 줄에 두고 있었다
// (queue-operation·session-owner 등이 먼저 오고 cwd는 보통 3~4번째 줄).
test('cwd가 첫 줄이 아니라 뒤쪽 줄에 있어도 찾는다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const lines = [
    JSON.stringify({ type: 'queue-operation' }),
    JSON.stringify({ type: 'session-owner' }),
    JSON.stringify({ type: 'mode' }),
    JSON.stringify({ cwd: '/my/workspace', type: 'user' })
  ];
  const file = path.join(dir, 'real-shaped.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(findActiveSessionFile(root, '/my/workspace'), file);
});

// 교차검증 보강: 첫 줄(queue-operation)에 대용량 이미지(1.2MB)가 들어있어 cwd가 1MB 뒤에 나와도 찾는다
test('앞줄이 1MB를 초과해 cwd가 1MB 뒤에 있는 대용량 세션 파일도 찾는다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const hugePayload = 'A'.repeat(1200 * 1024);
  const lines = [
    JSON.stringify({ type: 'queue-operation', payload: hugePayload }),
    JSON.stringify({ cwd: '/my/workspace', type: 'user' })
  ];
  const file = path.join(dir, 'huge-head.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(findActiveSessionFile(root, '/my/workspace'), file);
});

test('드라이브 문자 대소문자가 달라도 같은 경로로 본다(윈도우)', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, JSON.stringify({ cwd: 'E:\\Hermes_Obsidian' }) + '\n');
  assert.equal(findActiveSessionFile(root, 'e:\\Hermes_Obsidian'), file);
});

// 리뷰 C3: 세션 파일을 한 번 찾으면 영구히 고정돼 새 대화(새 jsonl)를 못 따라갔다.
test('처음 찾았을 때는 끝부터 보라고 한다(과거분 스킵)', () => {
  assert.deepEqual(decideNextWatch('/a/file.jsonl', null), {
    file: '/a/file.jsonl',
    startFromBeginning: false
  });
});

test('이미 보고 있는 파일과 같으면 변경 없음', () => {
  assert.equal(decideNextWatch('/a/file.jsonl', '/a/file.jsonl'), null);
});

test('다른 파일로 바뀌면 새 대화로 보고 처음부터 본다', () => {
  assert.deepEqual(decideNextWatch('/a/new.jsonl', '/a/old.jsonl'), {
    file: '/a/new.jsonl',
    startFromBeginning: true
  });
});

test('감시 에러로 currentlyWatching이 null이 되었더라도 이미 초기화된 이후라면 새 파일을 처음부터 본다', () => {
  assert.deepEqual(decideNextWatch('/a/recovered.jsonl', null, true), {
    file: '/a/recovered.jsonl',
    startFromBeginning: true
  });
});

test('세션을 못 찾으면 null(기존 감시 유지)', () => {
  assert.equal(decideNextWatch(null, '/a/old.jsonl'), null);
});
