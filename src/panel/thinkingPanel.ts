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

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.render();
  }

  /** "지금 보는 중" 표시만 갱신한다. 주의: 매 재탐색(초 단위)마다 불려도 되게 이 메서드 자체는
   *  entries를 지우지 않는다 — 대상이 실제로 바뀌었을 때 비우는 건 호출하는 쪽(extension.ts)이
   *  clear()를 따로 불러서 한다. 여기서 매번 지우면 탭이 안 바뀌어도 재탐색마다 비워진다. */
  setFollowing(label: string | null): void {
    this.following = label;
    this.render();
  }

  appendEntry(original: string, translated: string): void {
    this.entries.push(
      `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko">${escapeHtml(translated.trim())}</div></div>`
    );
    this.trim();
    this.render();
  }

  appendError(message: string, original?: string): void {
    if (original) {
      this.entries.push(
        `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko error">${escapeHtml(message)}</div></div>`
      );
    } else {
      this.entries.push(`<div class="entry error">${escapeHtml(message)}</div>`);
    }
    this.trim();
    this.render();
  }

  clear(): void {
    this.entries = [];
    this.render();
  }

  // 2026-11-10: 감시가 죽어서 아무것도 안 뜨는 건지, 정말 번역할 게 없어서 안 뜨는 건지
  // 구분할 수 있도록 — 항목 유무와 무관하게 항상 보이는 상태 줄.
  setStatus(text: string): void {
    this.status = text;
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
    const body =
      this.entries.length > 0
        ? this.entries.join('')
        : '<div class="empty">대기 중 — Claude Code의 새로운 영문 사고(thinking) 블록이 감지되면 자동으로 번역됩니다.</div>';
    const autoScroll = `<script>
      const el = document.getElementById('entries');
      if (el) { el.scrollTo(0, el.scrollHeight); }
    </script>`;
    return `<body>${style}<div class="fixed-top">${header}${followingLine}${statusLine}</div><div id="entries">${body}</div>${autoScroll}</body>`;
  }

  private render(): void {
    if (this.view) {
      this.view.webview.html = this.buildHtml();
    }
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
