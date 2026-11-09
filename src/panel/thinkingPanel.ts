// 사고 블록을 영어 원문|한글 번역 2단으로 나란히 쌓아 보여주는 webview 패널
// 보조 사이드바(WebviewView)와 독립 번역창(WebviewPanel) 양쪽을 모두 실시간 동기화한다.
import type * as vscode from 'vscode';

// 리뷰 I5: webview.html을 통째로 재할당하면 스크롤이 맨 위로 리셋된다.
// 최신 항목을 맨 위에 두면 리셋돼도 방금 들어온 항목이 바로 보인다.
// entriesHtml을 무한히 이어붙이지 않도록 최근 MAX_ENTRIES개까지만 남긴다.
const MAX_ENTRIES = 200;

export class ThinkingPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private standalonePanel: vscode.WebviewPanel | undefined;
  private entries: string[] = [];

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    this.render();
  }

  attachStandalonePanel(panel: vscode.WebviewPanel): void {
    this.standalonePanel = panel;
    panel.onDidDispose(() => {
      if (this.standalonePanel === panel) {
        this.standalonePanel = undefined;
      }
    });
    this.render();
  }

  getStandalonePanel(): vscode.WebviewPanel | undefined {
    return this.standalonePanel;
  }

  appendEntry(original: string, translated: string): void {
    this.entries.unshift(
      `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko">${escapeHtml(translated.trim())}</div></div>`
    );
    this.trim();
    this.render();
  }

  appendError(message: string, original?: string): void {
    if (original) {
      this.entries.unshift(
        `<div class="entry"><div class="en">${escapeHtml(original)}</div><div class="ko error">${escapeHtml(message)}</div></div>`
      );
    } else {
      this.entries.unshift(`<div class="entry error">${escapeHtml(message)}</div>`);
    }
    this.trim();
    this.render();
  }

  private trim(): void {
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
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
      </style>
    `;
    const header = `<div class="header"><span>원문 (Thinking)</span><span>한글 번역</span></div>`;
    const body =
      this.entries.length > 0
        ? this.entries.join('')
        : '<div class="empty">대기 중 — Claude Code의 새로운 영문 사고(thinking) 블록이 감지되면 자동으로 번역됩니다.</div>';
    return `<body>${style}${header}${body}</body>`;
  }

  private render(): void {
    const html = this.buildHtml();
    if (this.view) {
      this.view.webview.html = html;
    }
    if (this.standalonePanel) {
      this.standalonePanel.webview.html = html;
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
