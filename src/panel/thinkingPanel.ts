// 사고 블록을 영어 원문|한글 번역 2단으로 나란히 쌓아 보여주는 보조 사이드바 패널.
// 2026-11-10 재설계: 세션/탭마다 독립된 창을 따로 띄우는 방식은 탭 식별이 불안정해(Claude Code가
// 탭 제목·세션 파일을 대화 중 바꿈) 창이 중복되거나 엉뚱한 내용이 섞이는 사고가 반복됐다.
// 창 하나만 두고 "지금 보고 있는 Claude Code 탭"이 바뀔 때마다 그 창이 대상을 바꾸는 쪽이 훨씬
// 단순하고 안정적이다(extension.ts의 재대상 로직 참조). 이 클래스는 그 창 하나의 렌더링만 맡는다.
//
// 2026-11-11 재설계: 상태가 하나라도 바뀔 때마다(심지어 "지금 보는 중" 라벨이 3초 재탐색마다 그대로
// 갱신되기만 해도) webview.html을 통째로 재할당했었다 — VSCode 웹뷰는 html을 다시 쓰면 내부 iframe
// 문서를 통째로 새로 그려서, 사용자가 과거 내용을 보려고 위로 스크롤해 둔 상태에서도 매번 맨 아래로
// 끌려 내려가는 버그가 있었다(council argon 의견으로 확정). 이제 webview.html은 (재)resolveWebviewView
// 시점에 딱 한 번만 쓰고(사이드바를 접었다 펴서 웹뷰가 새로 만들어지는 경우를 대비해, 그 시점의
// 누적 상태 전부를 스켈레톤에 담는다), 그 이후의 모든 갱신은 postMessage로 웹뷰 쪽 스크립트에
// 전달해 DOM만 부분 수정한다. 자동 스크롤도 "이미 바닥 근처에 있을 때만" 내려가도록 바꿨다.
import type * as vscode from 'vscode';

const MAX_ENTRIES = 200;
const EMPTY_PLACEHOLDER_HTML =
  '<div class="empty">대기 중 — Claude Code의 새로운 영문 사고(thinking) 블록이 감지되면 자동으로 번역됩니다.</div>';
const TRANSLATING_BUSY_TEXT = '⏳ 번역 중입니다...';
const TRANSLATING_IDLE_TEXT = '입력을 대기 중입니다';
const FOLLOWING_NONE_TEXT = '(활성 Claude Code 탭 없음)';

// 웹뷰 쪽에서 돌아가는 스크립트 — host(extension)가 보내는 메시지만 받아 DOM을 부분 수정한다.
// vscode API를 다시 host로 호출할 일이 없어 acquireVsCodeApi()는 쓰지 않는다(단방향 갱신).
const CLIENT_SCRIPT = `
(function () {
  var entriesEl = document.getElementById('entries');
  var followingEl = document.getElementById('following');
  var statusEl = document.getElementById('status');
  var translatingEl = document.getElementById('translating');
  var SCROLL_THRESHOLD = 40;
  var pinnedToBottom = true;

  function isNearBottom() {
    return entriesEl.scrollHeight - entriesEl.scrollTop - entriesEl.clientHeight <= SCROLL_THRESHOLD;
  }
  entriesEl.addEventListener('scroll', function () {
    pinnedToBottom = isNearBottom();
  }, { passive: true });

  function scrollToBottom() {
    entriesEl.scrollTop = entriesEl.scrollHeight;
    pinnedToBottom = true;
  }
  scrollToBottom();

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'appendEntry') {
      // DOM에 넣기 전에 판정해야 방금 늘어난 scrollHeight 때문에 "바닥이 아니다"로 오판하지 않는다.
      var wasNearBottom = pinnedToBottom || isNearBottom();
      var empty = entriesEl.querySelector('.empty');
      if (empty) empty.remove();
      entriesEl.insertAdjacentHTML('beforeend', msg.html);
      while (entriesEl.children.length > msg.max) {
        entriesEl.removeChild(entriesEl.firstElementChild);
      }
      if (wasNearBottom) scrollToBottom();
    } else if (msg.type === 'replaceEntries') {
      entriesEl.innerHTML = msg.html || ${JSON.stringify(EMPTY_PLACEHOLDER_HTML)};
      scrollToBottom();
    } else if (msg.type === 'updateFollowing') {
      followingEl.textContent = msg.text;
    } else if (msg.type === 'updateStatus') {
      statusEl.textContent = msg.text;
      statusEl.classList.toggle('hidden', !msg.text);
    } else if (msg.type === 'updateTranslating') {
      translatingEl.textContent = msg.busy ? ${JSON.stringify(TRANSLATING_BUSY_TEXT)} : ${JSON.stringify(TRANSLATING_IDLE_TEXT)};
      translatingEl.classList.toggle('busy', msg.busy);
      translatingEl.classList.toggle('idle', !msg.busy);
    }
  });
})();
`;

export class ThinkingPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private entries: string[] = [];
  private status = '';
  /** 지금 이 패널이 따라가고 있는 Claude Code 탭 이름 — null이면 대상 없음(대기 중) */
  private following: string | null = null;
  /** agy 호출 왕복(12~14초) 동안 멈춘 것처럼 보이지 않도록 — 항상 번역 중/대기 중 둘 중 하나를 보여준다 */
  private translating = false;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildSkeletonHtml();
    // 2026-11-11 (Opus 검증으로 발견): 사이드바를 접었다 펴도 resolveWebviewView는 다시 안 불린다
    // (onDidChangeVisibility만 발생). retainContextWhenHidden 없이는 숨겨진 동안 iframe이 파괴될 수
    // 있고, 그 사이 보낸 postMessage는 전달되지 않고 사라진다(VSCode API 명세). 다시 보일 때마다
    // 그 시점까지 쌓인 전체 상태로 스켈레톤을 다시 써서 복구한다.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        webviewView.webview.html = this.buildSkeletonHtml();
      }
    });
    // dispose된 뒤에도 this.view가 남아있으면 postMessage가 예외를 던지고, 그 예외가
    // TranslationQueue의 drain() 안에서 다시 onResult(실패 경로)를 부르다 두 번째로 또 던져
    // drain()이 영구히 끝나지 않는 채로 죽는다(processing=true가 안 풀려 큐 전체가 멈춤).
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  /** "지금 보는 중" 표시만 갱신한다. 주의: 매 재탐색(초 단위)마다 불려도 되게 이 메서드 자체는
   *  entries를 지우지 않는다 — 대상이 실제로 바뀌었을 때 교체하는 건 호출하는 쪽(extension.ts)이
   *  restoreEntries()/clear()를 따로 불러서 한다. 여기서 매번 지우면 탭이 안 바뀌어도 재탐색마다 비워진다.
   *  text는 이스케이프하지 않은 원문 그대로 보낸다 — 클라이언트가 textContent로 넣어 자체적으로
   *  안전하게 표시한다(여기서 escapeHtml까지 하면 &amp; 같은 글자가 화면에 그대로 보이는 이중 이스케이프가 된다). */
  setFollowing(label: string | null): void {
    this.following = label;
    this.post({ type: 'updateFollowing', text: label ?? FOLLOWING_NONE_TEXT });
  }

  appendEntry(original: string, translated: string): void {
    const html = buildEntryHtml(original, translated);
    this.entries.push(html);
    this.trim();
    this.post({ type: 'appendEntry', html, max: MAX_ENTRIES });
  }

  appendError(message: string, original?: string): void {
    const html = buildErrorHtml(message, original);
    this.entries.push(html);
    this.trim();
    this.post({ type: 'appendEntry', html, max: MAX_ENTRIES });
  }

  clear(): void {
    this.entries = [];
    this.post({ type: 'replaceEntries', html: '' });
  }

  /** 탭 복귀 시 그 세션에서 보여줬던 내역으로 통째로 교체한다. 복사해서 쓴다 — 캐시 배열을 그대로
   *  잡으면 이후 appendEntry가 캐시에도 push돼 extension.ts의 캐시 기록과 이중으로 쌓인다. */
  restoreEntries(entries: string[]): void {
    this.entries = [...entries];
    this.trim();
    this.post({ type: 'replaceEntries', html: this.entries.join('') });
  }

  // 2026-11-10: 감시가 죽어서 아무것도 안 뜨는 건지, 정말 번역할 게 없어서 안 뜨는 건지
  // 구분할 수 있도록 — 항목 유무와 무관하게 항상 보이는 상태 줄.
  // setFollowing과 같은 이유로 이스케이프하지 않은 원문을 보낸다(클라이언트가 textContent로 표시).
  setStatus(text: string): void {
    this.status = text;
    this.post({ type: 'updateStatus', text });
  }

  /** 번역 큐가 돌고 있는 동안 true — 호출 왕복 시간만큼 화면이 안 바뀌어도 "멈춘 게 아니라
   *  번역 중"임을 또렷이 보여준다. extension.ts의 TranslationQueue onBusyChange가 호출한다. */
  setTranslating(busy: boolean): void {
    this.translating = busy;
    this.post({ type: 'updateTranslating', busy });
  }

  private trim(): void {
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  private post(message: unknown): void {
    if (!this.view) return;
    // onDidDispose가 아직 안 불린 순간의 경쟁 상태 등으로 postMessage가 동기 예외를 던지거나
    // 반환된 Promise가 reject될 수 있다 — 다음 재표시/재탐색 때 스켈레톤으로 복구되므로, 여기서
    // 둘 다 삼켜서 호출자(TranslationQueue 등)를 영원히 멈추지 않게 한다.
    try {
      void Promise.resolve(this.view.webview.postMessage(message)).catch(() => {
        this.view = undefined;
      });
    } catch {
      this.view = undefined;
    }
  }

  private buildSkeletonHtml(): string {
    // 2026-11-10: 헤더·"지금 보는 중"·상태 줄은 스크롤에도 위에 고정되게, body를 세로
    // flex로 나눠 고정 영역과 스크롤 영역(#entries)을 분리한다.
    const style = `
      <style>
        html, body { height: 100%; }
        body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 0; color: var(--vscode-foreground); display: flex; flex-direction: column; overflow: hidden; }
        .fixed-top { flex: 0 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; font-size: 11px; }
        .header span { flex: 1 1 50%; }
        .following { padding: 4px 8px; font-size: 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .status { padding: 2px 8px; color: var(--vscode-descriptionForeground); font-size: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .status.hidden { display: none; }
        .translating-indicator { padding: 3px 8px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border); }
        .translating-indicator.busy { color: var(--vscode-charts-yellow, var(--vscode-notificationsWarningIcon-foreground, #cca700)); animation: blink 1.1s ease-in-out infinite; }
        .translating-indicator.idle { color: var(--vscode-descriptionForeground); }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        #entries { flex: 1 1 auto; overflow-y: auto; }
        .entry { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
        .entry > div { flex: 1 1 50%; padding: 8px 10px; box-sizing: border-box; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
        .en { color: var(--vscode-descriptionForeground); border-right: 1px solid var(--vscode-panel-border); }
        .ko.error, .entry.error { color: var(--vscode-errorForeground); }
        .entry.error { display: block; padding: 8px 10px; }
        .empty { padding: 12px 10px; color: var(--vscode-descriptionForeground); }
      </style>
    `;
    const header = `<div class="header"><span>원문 (Thinking)</span><span>한글 번역</span></div>`;
    const followingText = this.following ? escapeHtml(this.following) : FOLLOWING_NONE_TEXT;
    const followingLine = `<div id="following" class="following">${followingText}</div>`;
    const translatingClass = this.translating ? 'busy' : 'idle';
    const translatingText = this.translating ? TRANSLATING_BUSY_TEXT : TRANSLATING_IDLE_TEXT;
    const translatingLine = `<div id="translating" class="translating-indicator ${translatingClass}">${translatingText}</div>`;
    const statusLine = `<div id="status" class="status${this.status ? '' : ' hidden'}">${escapeHtml(this.status)}</div>`;
    const body = this.entries.length > 0 ? this.entries.join('') : EMPTY_PLACEHOLDER_HTML;
    return `<body>${style}<div class="fixed-top">${header}${followingLine}${translatingLine}${statusLine}</div><div id="entries">${body}</div><script>${CLIENT_SCRIPT}</script></body>`;
  }
}

// extension.ts가 세션 캐시에 넣을 HTML도 패널과 똑같은 모양이어야 해서 모듈 함수로 뺐다.
export function buildEntryHtml(original: string, translated: string): string {
  return `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko">${escapeHtml(translated.trim())}</div></div>`;
}

export function buildErrorHtml(message: string, original?: string): string {
  return original
    ? `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko error">${escapeHtml(message)}</div></div>`
    : `<div class="entry error">${escapeHtml(message)}</div>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
