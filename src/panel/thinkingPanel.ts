// 사고 블록을 영어 원문|한글 번역 2단으로 나란히 쌓아 보여주는 webview 패널
// (Ruling: 계획의 "위아래로 쌓기" 대신 사용자 요청으로 좌우 2단 배치. appendEntry/appendError 시그니처는 계획과 동일.)
import * as vscode from 'vscode';

// 리뷰 I5: webview.html을 통째로 재할당하면 스크롤이 맨 위로 리셋된다.
// 최신 항목을 맨 위에 두면 리셋돼도 방금 들어온 항목이 바로 보인다.
// entriesHtml을 무한히 이어붙이지 않도록 최근 MAX_ENTRIES개까지만 남긴다.
const MAX_ENTRIES = 200;

export class ThinkingPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private entries: string[] = [];

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    this.render();
  }

  appendEntry(original: string, translated: string): void {
    this.entries.unshift(
      `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko">${escapeHtml(translated)}</div></div>`
    );
    this.trim();
    this.render();
  }

  appendError(message: string): void {
    this.entries.unshift(`<div class="entry error">${escapeHtml(message)}</div>`);
    this.trim();
    this.render();
  }

  private trim(): void {
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
  }

  private render(): void {
    if (!this.view) return;
    const style = `
      <style>
        body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 0; }
        .entry { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
        .entry > div { flex: 1 1 50%; padding: 6px 8px; box-sizing: border-box; white-space: pre-wrap; word-break: break-word; }
        .en { color: var(--vscode-descriptionForeground); border-right: 1px solid var(--vscode-panel-border); }
        .entry.error { display: block; color: var(--vscode-errorForeground); padding: 6px 8px; }
        .empty { padding: 8px; color: var(--vscode-descriptionForeground); }
      </style>
    `;
    const body = this.entries.length > 0 ? this.entries.join('') : '<div class="empty">대기 중</div>';
    this.view.webview.html = `<body>${style}${body}</body>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
