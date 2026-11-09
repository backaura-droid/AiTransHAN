// VSCode 확장 진입점 — 사이드바 패널 등록과 명령 등록을 담당한다
import * as vscode from 'vscode';

class PlaceholderPanel implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = '<body>Claude 사고 번역 패널 (대기 중)</body>';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', new PlaceholderPanel())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      vscode.window.showInformationMessage('claude-thinking-ko: 아직 구현 전');
    })
  );
}

export function deactivate(): void {}
