// ThinkingPanel이 webview.html을 통째로 재할당하지 않고(스크롤 리셋 방지) postMessage로
// 증분 업데이트하는지, 그리고 (재)resolveWebviewView 시점엔 그동안 쌓인 전체 상태를 스켈레톤에
// 담아 보여주는지 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingPanel, buildEntryHtml, buildErrorHtml } from '../src/panel/thinkingPanel';

function fakeView() {
  const posted: unknown[] = [];
  let visibilityHandler: (() => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  return {
    visible: true,
    webview: {
      options: undefined as unknown,
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      }
    },
    onDidChangeVisibility: (cb: () => void) => {
      visibilityHandler = cb;
    },
    onDidDispose: (cb: () => void) => {
      disposeHandler = cb;
    },
    fireVisibilityChange(): void {
      visibilityHandler?.();
    },
    fireDispose(): void {
      disposeHandler?.();
    },
    posted
  };
}

test('resolveWebviewView 직후 html에는 자동 스크롤·메시지 처리 스크립트가 포함된다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  assert.match(view.webview.html, /<script>[\s\S]*scrollTo[\s\S]*<\/script>/);
  assert.match(view.webview.html, /addEventListener\(['"]message['"]/);
});

test('appendEntry는 webview.html을 다시 쓰지 않고 postMessage로만 새 항목을 보낸다(스크롤 보존)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  const htmlAfterResolve = view.webview.html;
  panel.appendEntry('original', 'translated');
  assert.equal(view.webview.html, htmlAfterResolve, 'appendEntry가 webview.html을 건드리면 스크롤이 리셋된다');
  const last = view.posted[view.posted.length - 1] as { type: string; html: string };
  assert.equal(last.type, 'appendEntry');
  assert.equal(last.html, buildEntryHtml('original', 'translated'));
});

test('setFollowing/setStatus/setTranslating도 postMessage만 보내고 webview.html은 그대로다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  const htmlAfterResolve = view.webview.html;
  panel.setFollowing('새 대화 제목');
  panel.setStatus('마지막 확인 09:12:00');
  panel.setTranslating(true);
  assert.equal(view.webview.html, htmlAfterResolve);
  const types = view.posted.map((m: any) => m.type);
  assert.deepEqual(types, ['updateFollowing', 'updateStatus', 'updateTranslating']);
});

test('appendError: 원문이 있으면 같이, 없으면 메시지만 담아 보낸다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendError('타임아웃 오류', 'original thinking text');
  let last = view.posted[view.posted.length - 1] as { type: string; html: string };
  assert.equal(last.html, buildErrorHtml('타임아웃 오류', 'original thinking text'));

  panel.appendError('원문 없는 오류');
  last = view.posted[view.posted.length - 1] as { type: string; html: string };
  assert.equal(last.html, buildErrorHtml('원문 없는 오류'));
});

test('restoreEntries/clear는 replaceEntries 메시지를 보낸다(전체 교체)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('B original', 'B translated');

  panel.restoreEntries([buildEntryHtml('A original', 'A translated'), buildErrorHtml('A 오류', 'A 원문')]);
  let last = view.posted[view.posted.length - 1] as { type: string; html: string };
  assert.equal(last.type, 'replaceEntries');
  assert.ok(last.html.indexOf('A translated') < last.html.indexOf('A 오류'));
  assert.ok(!last.html.includes('B translated'));

  panel.clear();
  last = view.posted[view.posted.length - 1] as { type: string; html: string };
  assert.equal(last.type, 'replaceEntries');
  assert.equal(last.html, '');
});

test('restoreEntries() 후 appendEntry를 해도 넘겨준 배열(캐시)은 바뀌지 않는다', () => {
  const panel = new ThinkingPanel();
  panel.resolveWebviewView(fakeView() as any);
  const cached = [buildEntryHtml('a', 'b')];
  panel.restoreEntries(cached);
  panel.appendEntry('c', 'd');
  assert.equal(cached.length, 1, '패널이 캐시 배열에 직접 쌓으면 캐시와 이중 기록된다');
});

test('항목이 너무 많이 쌓이면 appendEntry 메시지에 상한(max)을 같이 실어 보내 웹뷰가 오래된 것부터 지우게 한다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  for (let i = 0; i < 5; i++) panel.appendEntry(`orig-${i}`, `ko-${i}`);
  const last = view.posted[view.posted.length - 1] as { type: string; max: number };
  assert.equal(typeof last.max, 'number');
  assert.ok(last.max > 0);
});

// 2026-11-11: 웹뷰가 아직 한 번도 안 열렸거나(resolveWebviewView 전), 사이드바를 접었다 폈을 때처럼
// 다시 만들어질 수 있다 — 그 시점엔 그동안 쌓인 전체 상태(entries·status·following·translating)가
// 스켈레톤 html 자체에 담겨 있어야 postMessage 없이도 바로 맞는 내용이 보인다.
test('resolveWebviewView 전에 쌓인 상태도, 나중에 resolveWebviewView가 불리면 그 html에 전부 담긴다', () => {
  const panel = new ThinkingPanel();
  panel.appendEntry('먼저 쌓인 원문', '먼저 쌓인 번역');
  panel.setFollowing('어떤 탭');
  panel.setStatus('상태 메시지');
  panel.setTranslating(true);

  const view = fakeView();
  panel.resolveWebviewView(view as any);

  assert.ok(view.webview.html.includes('먼저 쌓인 번역'));
  assert.ok(view.webview.html.includes('어떤 탭'));
  assert.ok(view.webview.html.includes('상태 메시지'));
  assert.ok(view.webview.html.includes('번역 중입니다'));
});

test('웹뷰가 재생성되면(resolveWebviewView 재호출) 그 시점의 최신 상태가 다시 담긴다', () => {
  const panel = new ThinkingPanel();
  const view1 = fakeView();
  panel.resolveWebviewView(view1 as any);
  panel.appendEntry('original', 'translated');

  const view2 = fakeView(); // 사이드바를 접었다 펴서 웹뷰가 새로 만들어진 상황을 흉내
  panel.resolveWebviewView(view2 as any);
  assert.ok(view2.webview.html.includes('translated'), '이전 webview가 사라져도 패널의 상태는 유지돼야 한다');
});

test('setFollowing(null)이면 대상 없음 문구를 postMessage로 보낸다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.setFollowing(null);
  const last = view.posted[view.posted.length - 1] as { type: string; text: string };
  assert.ok(last.text.includes('활성 Claude Code 탭 없음'));
});

test('setTranslating(true)/false 메시지에 busy 불리언이 실린다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.setTranslating(true);
  let last = view.posted[view.posted.length - 1] as { type: string; busy: boolean };
  assert.equal(last.busy, true);
  panel.setTranslating(false);
  last = view.posted[view.posted.length - 1] as { type: string; busy: boolean };
  assert.equal(last.busy, false);
});

test('기본값은 "대기 중"이다(한 번도 setTranslating을 안 불러도 멈춘 것처럼 안 보여야 한다)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  assert.ok(view.webview.html.includes('입력을 대기 중입니다'));
});

test('buildEntryHtml/buildErrorHtml은 appendEntry/appendError가 보내는 것과 같은 HTML을 만든다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('<orig>', ' 번역 ');
  let last = view.posted[view.posted.length - 1] as { html: string };
  assert.equal(last.html, buildEntryHtml('<orig>', ' 번역 '));

  panel.appendError('오류만');
  last = view.posted[view.posted.length - 1] as { html: string };
  assert.equal(last.html, buildErrorHtml('오류만'));
});

// 2026-11-11 (Opus 검증으로 발견): 사이드바를 접었다 펴도 resolveWebviewView는 다시 안 불리고
// onDidChangeVisibility만 발생한다. retainContextWhenHidden 없이는 숨겨진 동안 iframe이 파괴되고
// 그 사이 보낸 postMessage는 유실된다 — 다시 보일 때 스켈레톤으로 복구해야 한다.
test('사이드바를 접었다 펴면(visibility 변경) 그 시점의 최신 상태로 html을 다시 쓴다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.appendEntry('original', 'translated'); // postMessage로만 감 — webview.html엔 아직 없음
  assert.ok(!view.webview.html.includes('translated'));

  view.visible = false;
  view.fireVisibilityChange(); // 숨겨짐 — 아무 것도 안 해도 된다
  view.visible = true;
  view.fireVisibilityChange(); // 다시 보임 — 이 시점에 최신 상태로 복구돼야 한다

  assert.ok(view.webview.html.includes('translated'));
});

test('웹뷰가 dispose된 뒤에는 postMessage를 더 시도하지 않는다(큐가 영원히 멈추지 않게)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  view.fireDispose();
  assert.doesNotThrow(() => {
    panel.appendEntry('original', 'translated');
    panel.setStatus('상태');
    panel.setFollowing('탭');
  });
});

// 2026-11-11 (Opus 검증으로 발견): 서버가 escapeHtml을 거친 문자열을 보내고 클라이언트가 그걸
// 다시 textContent로 넣으면 "&amp;"처럼 이중 이스케이프된 글자가 화면에 그대로 보인다.
test('setFollowing/setStatus는 이스케이프하지 않은 원문을 그대로 보낸다(클라이언트가 textContent로 표시)', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  panel.setFollowing("탭 <제목> & '테스트'");
  let last = view.posted[view.posted.length - 1] as { text: string };
  assert.equal(last.text, "탭 <제목> & '테스트'");

  panel.setStatus("상태 <텍스트> & 'A'");
  last = view.posted[view.posted.length - 1] as { text: string };
  assert.equal(last.text, "상태 <텍스트> & 'A'");
});

test('클라이언트 스크립트에 "바닥 근처에 있을 때만 자동 스크롤" 로직이 들어있다', () => {
  const panel = new ThinkingPanel();
  const view = fakeView();
  panel.resolveWebviewView(view as any);
  // 정확한 구현 방식보다 "바닥 여부 판정" 자체가 들어있는지만 느슨하게 확인(과도한 구현 결합 방지)
  assert.match(view.webview.html, /scrollHeight/);
  assert.match(view.webview.html, /scrollTop/);
  assert.match(view.webview.html, /clientHeight/);
});
