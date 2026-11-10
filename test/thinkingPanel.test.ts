// ThinkingPanel이 Claude 출력과 같은 방향(먼저 나온 게 위, 새로 나온 게 아래)으로 쌓고,
// 그걸 위해 자동 스크롤 스크립트를 내보내며, 과거 항목은 상한을 넘으면 버리는지 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingPanel } from '../src/panel/thinkingPanel';

function fakeStandalonePanel() {
  return {
    webview: { html: '' },
    onDidDispose: (_cb: () => void) => {
      // 테스트에서는 dispose를 직접 트리거하지 않는다
    }
  };
}

// 2026-11-10: "클로드 출력은 위→아래인데 번역이 반대라 헷갈린다"는 요청으로 순서를 바꿨다.
// webview.html 전체 재할당은 그 자체로 스크롤을 맨 위로 리셋하므로, 맨 아래로 쌓는 대신
// 매번 자동으로 맨 아래까지 스크롤하는 스크립트를 함께 내보낸다(enableScripts 필요).
test('새 항목이 먼저 나온 것 아래에 쌓인다(클로드 출력과 같은 방향)', () => {
  const panel = new ThinkingPanel();
  const view = fakeStandalonePanel();
  panel.attachStandalonePanel(view as any);
  panel.appendEntry('first original', 'first translated');
  panel.appendEntry('second original', 'second translated');
  const firstIndex = view.webview.html.indexOf('first translated');
  const secondIndex = view.webview.html.indexOf('second translated');
  assert.ok(firstIndex < secondIndex, '먼저 나온 항목이 더 앞(위)에 있어야 한다');
});

test('렌더된 HTML에 맨 아래로 자동 스크롤하는 스크립트가 포함된다', () => {
  const panel = new ThinkingPanel();
  const view = fakeStandalonePanel();
  panel.attachStandalonePanel(view as any);
  panel.appendEntry('original', 'translated');
  assert.match(view.webview.html, /<script>[\s\S]*scrollTo[\s\S]*<\/script>/);
});

test('항목이 너무 많이 쌓이면 오래된 것부터 버린다(앞쪽부터 삭제)', () => {
  const panel = new ThinkingPanel();
  const view = fakeStandalonePanel();
  panel.attachStandalonePanel(view as any);
  for (let i = 0; i < 250; i++) {
    panel.appendEntry(`orig-${i}`, `ko-${i}`);
  }
  assert.ok(!view.webview.html.includes('ko-0'), '오래된 항목은 잘려나가야 한다');
  assert.ok(view.webview.html.includes('ko-249'), '최신 항목은 남아있어야 한다');
});

test('번역 에러 기록 시 원문이 함께 주어지면 원문도 보존해 표시한다', () => {
  const panel = new ThinkingPanel();
  const view = fakeStandalonePanel();
  panel.attachStandalonePanel(view as any);
  panel.appendError('타임아웃 오류', 'original thinking text');
  assert.ok(view.webview.html.includes('original thinking text'));
  assert.ok(view.webview.html.includes('타임아웃 오류'));
});

test('clear()를 호출하면 쌓인 항목이 전부 지워지고 대기 중 문구로 돌아간다', () => {
  const panel = new ThinkingPanel();
  const view = fakeStandalonePanel();
  panel.attachStandalonePanel(view as any);
  panel.appendEntry('original', 'translated');
  panel.appendError('오류', '원문');
  panel.clear();
  assert.ok(!view.webview.html.includes('translated'));
  assert.ok(!view.webview.html.includes('오류'));
  assert.ok(view.webview.html.includes('대기 중'));
});
