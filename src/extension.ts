// VSCode 확장 진입점 — 사이드바 패널 등록과 명령 등록을 담당한다
import * as vscode from 'vscode';
import { ThinkingPanel } from './panel/thinkingPanel';

export function activate(context: vscode.ExtensionContext): void {
  const panel = new ThinkingPanel();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', panel)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      vscode.window.showInformationMessage('claude-thinking-ko: 아직 구현 전');
    })
  );
}

export function deactivate(): void {}
