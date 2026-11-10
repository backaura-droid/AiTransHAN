// 사고 블록을 영어 원문|한글 번역 2단으로 나란히 쌓아 보여주는 webview 패널.
// 세션(대화)마다 독립된 창을 자동으로 여는 구조라, 인스턴스 하나당 독립 창(WebviewPanel) 하나에 묶인다
// ("창마다 다른 번역창" 요청, 2026-11-10 — 여러 Claude Code 탭의 사고가 패널 하나에 섞이던 문제의 해결책).
import type * as vscode from 'vscode';

// 2026-11-10: Claude 출력은 위→아래로 내려오는데 번역이 반대 순서면 헷갈린다는 요청으로,
// 먼저 나온 게 위·새 항목이 아래에 쌓이도록 바꿨다(리뷰 I5가 "맨 위에 쌓기"를 택했던 것과 반대 방향).
// 대신 webview.html 전체 재할당이 스크롤을 맨 위로 리셋시키는 문제를, 매번 맨 아래로 자동 스크롤하는
// 스크립트로 해결한다(createWebviewPanel 쪽 enableScripts: true 필요).
// entriesHtml을 무한히 이어붙이지 않도록 최근 MAX_ENTRIES개까지만 남긴다.
const MAX_ENTRIES = 200;

export class ThinkingPanel {
  private standalonePanel: vscode.WebviewPanel | undefined;
  private entries: string[] = [];
  private status = '';

  attachStandalonePanel(panel: vscode.WebviewPanel): void {
    this.standalonePanel = panel;
    panel.onDidDispose(() => {
      if (this.standalonePanel === panel) {
        this.standalonePanel = undefined;
      }
    });
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
    const style = `
      <style>
        body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 0; color: var(--vscode-foreground); }
        .header { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; font-size: 11px; }
        .header span { flex: 1 1 50%; }
        .entry { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
        .entry > div { flex: 1 1 50%; padding: 8px 10px; box-sizing: border-box; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
        .en { color: var(--vscode-descriptionForeground); border-right: 1px solid var(--vscode-panel-border); }
        .ko.error, .entry.error { color: var(--vscode-errorForeground); }
        .entry.error { display: block; padding: 8px 10px; }
        .empty { padding: 12px 10px; color: var(--vscode-descriptionForeground); }
        .status { padding: 2px 8px; color: var(--vscode-descriptionForeground); font-size: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
      </style>
    `;
    const header = `<div class="header"><span>원문 (Thinking)</span><span>한글 번역</span></div>`;
    const statusLine = this.status ? `<div class="status">${escapeHtml(this.status)}</div>` : '';
    const body =
      this.entries.length > 0
        ? this.entries.join('')
        : '<div class="empty">대기 중 — Claude Code의 새로운 영문 사고(thinking) 블록이 감지되면 자동으로 번역됩니다.</div>';
    const autoScroll = `<script>window.scrollTo(0, document.body.scrollHeight);</script>`;
    return `<body>${style}${header}${statusLine}${body}${autoScroll}</body>`;
  }

  private render(): void {
    if (this.standalonePanel) {
      this.standalonePanel.webview.html = this.buildHtml();
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
