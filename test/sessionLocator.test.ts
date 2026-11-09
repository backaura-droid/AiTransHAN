// sessionLocator의 cwd 매칭·최신 mtime 선택·깨진 파일 무시·대용량 헤더·다중 활성 세션 수집을 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findActiveSessionFile, findAllActiveSessionFiles } from '../src/sessionLocator';

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

// 다중 세션: "창마다 다른 번역 프로그램" 요청의 기반이 되는 함수.
test('cwd가 일치하는 활성 세션을 전부, 최신순으로 반환한다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  const other = path.join(dir, 'other.jsonl');
  fs.writeFileSync(a, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  fs.writeFileSync(b, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  fs.writeFileSync(other, JSON.stringify({ cwd: '/다른/워크스페이스' }) + '\n');
  const now = Date.now();
  fs.utimesSync(a, new Date(now - 5000), new Date(now - 5000));
  fs.utimesSync(b, new Date(now), new Date(now));
  const result = findAllActiveSessionFiles(root, '/my/workspace', { now });
  assert.deepEqual(result.map((r) => r.file), [b, a]);
});

test('너무 오래 전에 쓰인 세션은 제외한다(기본 30분)', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const fresh = path.join(dir, 'fresh.jsonl');
  const stale = path.join(dir, 'stale.jsonl');
  fs.writeFileSync(fresh, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  fs.writeFileSync(stale, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  const now = Date.now();
  fs.utimesSync(fresh, new Date(now - 60 * 1000), new Date(now - 60 * 1000));
  fs.utimesSync(stale, new Date(now - 40 * 60 * 1000), new Date(now - 40 * 60 * 1000));
  const result = findAllActiveSessionFiles(root, '/my/workspace', { now });
  assert.deepEqual(result.map((r) => r.file), [fresh]);
});

test('maxAgeMs를 직접 지정할 수 있다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  const now = Date.now();
  fs.utimesSync(file, new Date(now - 120 * 1000), new Date(now - 120 * 1000));
  assert.deepEqual(findAllActiveSessionFiles(root, '/my/workspace', { now, maxAgeMs: 60 * 1000 }), []);
  assert.equal(findAllActiveSessionFiles(root, '/my/workspace', { now, maxAgeMs: 300 * 1000 }).length, 1);
});
