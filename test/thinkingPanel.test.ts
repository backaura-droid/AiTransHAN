// ThinkingPanel이 Claude 출력과 같은 방향으로 쌓고, 상태 줄과 "지금 보는 탭" 표시를 유지하며,
// 대상 탭이 바뀌면 이전 항목을 비우는지(다른 대화 내용과 안 섞이게) 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingPanel } from '../src/panel/thinkingPanel';

function fakeView() {
  return { webview: { options: undefined as unknown, html: '' } };
}

// 2026-11-10: "클로드 출력은 위→아래인데 번역이 반대라 헷갈린다"는 요청으로 순서를 바꿨다.
// webview.html 전체 재할당은 그 자체로 스크롤을 맨 위로 리셋하므로, 맨 아래로 쌓는 대신
// 매번 자동으로 맨 아래까지 스크롤하는 스크립트를 함께 내보낸다(enableScripts 필요).
test('새 항목이 먼저 나온 것 아래에 쌓인다(클로드 출력과 같은 방향)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('first original', 'first translated');
  panel.appendEntry('second original', 'second translated');
  const firstIndex = view.webview.html.indexOf('first translated');
  const secondIndex = view.webview.html.indexOf('second translated');
  assert.ok(firstIndex < secondIndex, '먼저 나온 항목이 더 앞(위)에 있어야 한다');
});

test('렌더된 HTML에 맨 아래로 자동 스크롤하는 스크립트가 포함된다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('original', 'translated');
  assert.match(view.webview.html, /<script>[\s\S]*scrollTo[\s\S]*<\/script>/);
});

test('항목이 너무 많이 쌓이면 오래된 것부터 버린다(앞쪽부터 삭제)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  for (let i = 0; i < 250; i++) {
    panel.appendEntry(`orig-${i}`, `ko-${i}`);
  }
  assert.ok(!view.webview.html.includes('ko-0'), '오래된 항목은 잘려나가야 한다');
  assert.ok(view.webview.html.includes('ko-249'), '최신 항목은 남아있어야 한다');
});

test('번역 에러 기록 시 원문이 함께 주어지면 원문도 보존해 표시한다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendError('타임아웃 오류', 'original thinking text');
  assert.ok(view.webview.html.includes('original thinking text'));
  assert.ok(view.webview.html.includes('타임아웃 오류'));
});

test('clear()를 호출하면 쌓인 항목이 전부 지워지고 대기 중 문구로 돌아간다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('original', 'translated');
  panel.appendError('오류', '원문');
  panel.clear();
  assert.ok(!view.webview.html.includes('translated'));
  assert.ok(!view.webview.html.includes('오류'));
  assert.ok(view.webview.html.includes('대기 중'));
});

test('setStatus()로 남긴 상태 줄이 항목 유무와 무관하게 계속 보인다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.setStatus('마지막 확인 09:12:00 (레코드 3개, 번역 대상 0개)');
  assert.ok(view.webview.html.includes('마지막 확인 09:12:00'));
  panel.appendEntry('original', 'translated');
  assert.ok(view.webview.html.includes('마지막 확인 09:12:00'), '항목이 생겨도 상태 줄은 남아있어야 한다');
});

test('setFollowing()은 "지금 보는 중" 표시를 갱신한다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.setFollowing('새 대화 제목');
  assert.ok(view.webview.html.includes('새 대화 제목'));
});

// 2026-11-10: setFollowing()은 재탐색마다(초 단위) 불릴 수 있다 — 대상이 안 바뀌었는데도
// 부를 때마다 비우면 몇 초마다 번역 내역이 사라지는 버그가 생긴다. 대상이 바뀌었을 때 비우는 건
// extension.ts가 따로 clear()를 불러서 한다(이 메서드 자체는 표시만 갱신, 비우지 않는다).
test('setFollowing()을 반복 호출해도 쌓인 항목은 지워지지 않는다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('original', 'translated');
  panel.setFollowing('같은 탭');
  panel.setFollowing('같은 탭');
  assert.ok(view.webview.html.includes('translated'), 'setFollowing 반복 호출로 항목이 지워지면 안 된다');
});

test('setFollowing(null)이면 대상 없음 문구를 보여준다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.setFollowing(null);
  assert.ok(view.webview.html.includes('활성 Claude Code 탭 없음'));
});
