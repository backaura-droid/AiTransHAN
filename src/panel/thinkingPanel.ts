// 사고 블록을 영어 원문|한글 번역 2단으로 나란히 쌓아 보여주는 보조 사이드바 패널.
// 2026-11-10 재설계: 세션/탭마다 독립된 창을 따로 띄우는 방식은 탭 식별이 불안정해(Claude Code가
// 탭 제목·세션 파일을 대화 중 바꿈) 창이 중복되거나 엉뚱한 내용이 섞이는 사고가 반복됐다.
// 창 하나만 두고 "지금 보고 있는 Claude Code 탭"이 바뀔 때마다 그 창이 대상을 바꾸는 쪽이 훨씬
// 단순하고 안정적이다(extension.ts의 재대상 로직 참조). 이 클래스는 그 창 하나의 렌더링만 맡는다.
import type * as vscode from 'vscode';

// 리뷰 I5 + 2026-11-10 요청: Claude 출력은 위→아래로 내려오므로 번역도 같은 방향(새 항목이 아래)으로
// 쌓고, webview.html 전체 재할당이 스크롤을 맨 위로 리셋시키는 문제는 매번 맨 아래로 자동 스크롤하는
// 스크립트로 해결한다(enableScripts: true 필요 — extension.ts에서 설정).
// entriesHtml을 무한히 이어붙이지 않도록 최근 MAX_ENTRIES개까지만 남긴다.
const MAX_ENTRIES = 200;

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
    this.render();
  }

  /** "지금 보는 중" 표시만 갱신한다. 주의: 매 재탐색(초 단위)마다 불려도 되게 이 메서드 자체는
   *  entries를 지우지 않는다 — 대상이 실제로 바뀌었을 때 교체하는 건 호출하는 쪽(extension.ts)이
   *  restoreEntries()/clear()를 따로 불러서 한다. 여기서 매번 지우면 탭이 안 바뀌어도 재탐색마다 비워진다. */
  setFollowing(label: string | null): void {
    this.following = label;
    this.render();
  }

  appendEntry(original: string, translated: string): void {
    this.entries.push(buildEntryHtml(original, translated));
    this.trim();
    this.render();
  }

  appendError(message: string, original?: string): void {
    this.entries.push(buildErrorHtml(message, original));
    this.trim();
    this.render();
  }

  clear(): void {
    this.entries = [];
    this.render();
  }

  /** 탭 복귀 시 그 세션에서 보여줬던 내역으로 통째로 교체한다. 복사해서 쓴다 — 캐시 배열을 그대로
   *  잡으면 이후 appendEntry가 캐시에도 push돼 extension.ts의 캐시 기록과 이중으로 쌓인다. */
  restoreEntries(entries: string[]): void {
    this.entries = [...entries];
    this.trim();
    this.render();
  }

  // 2026-11-10: 감시가 죽어서 아무것도 안 뜨는 건지, 정말 번역할 게 없어서 안 뜨는 건지
  // 구분할 수 있도록 — 항목 유무와 무관하게 항상 보이는 상태 줄.
  setStatus(text: string): void {
    this.status = text;
    this.render();
  }

  /** 번역 큐가 돌고 있는 동안 true — 호출 왕복 시간만큼 화면이 안 바뀌어도 "멈춘 게 아니라
   *  번역 중"임을 또렷이 보여준다. extension.ts의 TranslationQueue onBusyChange가 호출한다. */
  setTranslating(busy: boolean): void {
    this.translating = busy;
    this.render();
  }

  private trim(): void {
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  private buildHtml(): string {
    // 2026-11-10: 헤더·"지금 보는 중"·상태 줄은 스크롤에도 위에 고정되게, body를 세로
    // flex로 나눠 고정 영역과 스크롤 영역(#entries)을 분리한다. 자동 스크롤은 document가
    // 아니라 #entries 요소 자체를 내려야 한다.
    const style = `
      <style>
        html, body { height: 100%; }
        body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 0; color: var(--vscode-foreground); display: flex; flex-direction: column; overflow: hidden; }
        .fixed-top { flex: 0 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; font-size: 11px; }
        .header span { flex: 1 1 50%; }
        .following { padding: 4px 8px; font-size: 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .status { padding: 2px 8px; color: var(--vscode-descriptionForeground); font-size: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
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
    const followingLine = `<div class="following">지금 보는 중: ${this.following ? escapeHtml(this.following) : '(활성 Claude Code 탭 없음)'}</div>`;
    const statusLine = this.status ? `<div class="status">${escapeHtml(this.status)}</div>` : '';
    const translatingLine = this.translating
      ? `<div class="translating-indicator busy">⏳ 번역 중입니다...</div>`
      : `<div class="translating-indicator idle">입력을 대기 중입니다</div>`;
    const body =
      this.entries.length > 0
        ? this.entries.join('')
        : '<div class="empty">대기 중 — Claude Code의 새로운 영문 사고(thinking) 블록이 감지되면 자동으로 번역됩니다.</div>';
    const autoScroll = `<script>
      const el = document.getElementById('entries');
      if (el) { el.scrollTo(0, el.scrollHeight); }
    </script>`;
    return `<body>${style}<div class="fixed-top">${header}${followingLine}${translatingLine}${statusLine}</div><div id="entries">${body}</div>${autoScroll}</body>`;
  }

  private render(): void {
    if (this.view) {
      this.view.webview.html = this.buildHtml();
    }
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
