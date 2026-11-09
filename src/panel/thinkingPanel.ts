// 사고 블록을 영어 원문|한글 번역 2단으로 나란히 쌓아 보여주는 webview 패널
// (Ruling: 계획의 "위아래로 쌓기" 대신 사용자 요청으로 좌우 2단 배치. appendEntry/appendError 시그니처는 계획과 동일.)
import * as vscode from 'vscode';

export class ThinkingPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private entriesHtml = '';

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    this.render();
  }

  appendEntry(original: string, translated: string): void {
    this.entriesHtml += `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko">${escapeHtml(translated)}</div></div>`;
    this.render();
  }

  appendError(message: string): void {
    this.entriesHtml += `<div class="entry error">${escapeHtml(message)}</div>`;
    this.render();
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
    const body = this.entriesHtml || '<div class="empty">대기 중</div>';
    this.view.webview.html = `<body>${style}${body}</body>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
