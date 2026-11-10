// sessionLocator의 cwd 매칭·최신 mtime 선택·깨진 파일 무시·대용량 헤더를 검증하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findActiveSessionFile } from '../src/sessionLocator';

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

// 2026-11-10: 같은 워크스페이스를 VSCode 창 두 개(또는 탭 두 개)로 열어두면 cwd만으로는 구분이
// 안 돼 서로 다른 창의 패널이 같은(최신 mtime) 파일을 가리키는 사고가 실사용에서 재현됐다.
// ai-title 레코드로 "지금 보고 있는 탭 라벨"과 맞는 파일을 고르게 한다.
function writeSession(file: string, cwd: string, aiTitles: string[]): void {
  const lines = [JSON.stringify({ cwd, type: 'user' })];
  for (const t of aiTitles) {
    lines.push(JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 'x' }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

test('cwd가 같은 파일이 여럿이어도 활성 탭 라벨과 ai-title이 일치하는 파일을 고른다(mtime 무시)', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const newer = path.join(dir, 'newer.jsonl'); // 최신 mtime이지만 다른 탭
  const older = path.join(dir, 'older.jsonl'); // 오래됐지만 지금 보는 탭
  writeSession(newer, '/my/workspace', ['다른 탭 제목']);
  writeSession(older, '/my/workspace', ['지금 보는 탭 제목']);
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(newer, new Date(now), new Date(now));
  assert.equal(findActiveSessionFile(root, '/my/workspace', '지금 보는 탭 제목'), older);
});

test('ai-title이 여러 번 바뀐 파일은 가장 최근(마지막) 제목으로 매칭한다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  writeSession(file, '/my/workspace', ['첫 메시지 원문 그대로', '짧은 제목']);
  assert.equal(findActiveSessionFile(root, '/my/workspace', '짧은 제목'), file);
  // 더는 안 쓰는 옛 제목으로는 매칭이 안 돼야 한다 — 다른 후보가 있을 때 구분해 확인
  const other = path.join(dir, 'other.jsonl');
  writeSession(other, '/my/workspace', ['옛 제목과 안 겹치는 다른 탭']);
  fs.utimesSync(file, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  // 2026-11-10 정정: 제목이 붙은 "다른" 세션(other)은 더 이상 폴백 후보가 아니다(아래 새 테스트 참조).
  // other는 제목이 있으니 제외되고, 제목 없는 파일도 없으므로 null이어야 한다.
  assert.equal(
    findActiveSessionFile(root, '/my/workspace', '첫 메시지 원문 그대로'),
    null,
    '제목이 붙은 다른 탭의 세션으로 잘못 폴백하면 안 된다'
  );
});

// 2026-11-10 실사용 버그: 빈 새 탭(아직 메시지 안 보냄 → 세션 파일 자체가 없음)을 열었는데, 그 순간
// 가장 바쁜(mtime 최신) "다른, 제목 있는" 세션이 엉뚱하게 잡혀 그 내용이 그대로 보이는 사고가 났다.
// council(argon) + Opus 교차검증 결론: "제목이 이미 있는 파일은 폴백 후보에서 아예 제외"하고,
// "제목이 아직 없는(진짜 새) 파일만, 그것도 최근(60초 이내) 생성/수정된 것만" 폴백으로 허용한다.
test('제목이 붙은 다른 탭의 세션은 아무리 최신이어도 폴백 후보가 되지 않는다(빈 새 탭 버그)', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const busyOtherTab = path.join(dir, 'busy.jsonl'); // 지금 활발히 쓰이는 "다른" 탭 — 제목 있음, mtime 최신
  writeSession(busyOtherTab, '/my/workspace', ['이 확장을 만들고 있는 바로 그 세션']);
  assert.equal(
    findActiveSessionFile(root, '/my/workspace', 'Claude Code'), // 방금 연 빈 탭의 기본 라벨
    null,
    '제목 있는 다른 세션을 빈 탭의 내용인 것처럼 보여주면 안 된다'
  );
});

test('제목이 아직 없는 "진짜 새" 세션은 최근(60초 이내)이면 폴백으로 허용한다(첫 턴 누락 방지)', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const brandNew = path.join(dir, 'brand-new.jsonl'); // 방금 첫 메시지를 보냈지만 아직 제목이 안 지어짐
  fs.writeFileSync(brandNew, JSON.stringify({ cwd: '/my/workspace', type: 'user' }) + '\n');
  assert.equal(findActiveSessionFile(root, '/my/workspace', 'Claude Code'), brandNew);
});

test('제목 없는 세션이라도 60초보다 오래됐으면(옛날에 중단된 파일) 폴백으로 쓰지 않는다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const stale = path.join(dir, 'stale.jsonl');
  fs.writeFileSync(stale, JSON.stringify({ cwd: '/my/workspace', type: 'user' }) + '\n');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  assert.equal(findActiveSessionFile(root, '/my/workspace', 'Claude Code'), null);
});

// 2026-11-10: 활성 Claude Code 탭이 아예 없을 때(코드 편집기 탭 등에 포커스)는 null을 명시적으로
// 넘긴다 — 이때도 엉뚱한 파일로 폴백하면 안 된다(undefined와 다르게 취급해야 함, 아래 테스트 참조).
test('activeTabLabel이 명시적으로 null이면(활성 Claude 탭 없음) 아무리 cwd가 맞아도 null을 돌려준다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  writeSession(file, '/my/workspace', ['제목']);
  assert.equal(findActiveSessionFile(root, '/my/workspace', null), null);
});

test('activeTabLabel을 안 넘기면(undefined) 기존 동작과 같다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  writeSession(file, '/my/workspace', ['제목']);
  assert.equal(findActiveSessionFile(root, '/my/workspace'), file);
});
