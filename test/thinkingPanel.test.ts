// ThinkingPanel이 최신 항목을 위로 쌓고(스크롤 리셋 대응), 과거 항목은 상한을 넘으면 버리는지 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingPanel } from '../src/panel/thinkingPanel';

function fakeView() {
  return { webview: { options: undefined as unknown, html: '' } };
}

// 리뷰 I5: webview.html을 통째로 재할당하면 스크롤이 맨 위로 리셋된다.
// 최신 항목을 맨 위에 두면 스크롤이 리셋돼도 방금 들어온 항목이 바로 보인다.
test('새 항목이 맨 위에 쌓인다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('first original', 'first translated');
  panel.appendEntry('second original', 'second translated');
  const firstIndex = view.webview.html.indexOf('first translated');
  const secondIndex = view.webview.html.indexOf('second translated');
  assert.ok(secondIndex < firstIndex, '최신 항목이 더 앞에 나와야 한다');
});

test('항목이 너무 많이 쌓이면 오래된 것부터 버린다', () => {
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
