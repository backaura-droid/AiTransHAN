// VSCode 확장 진입점 — 세션 감시부터 번역, 패널 표시까지 전체를 배선한다
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThinkingPanel } from './panel/thinkingPanel';
import { findActiveSessionFile } from './sessionLocator';
import { tailOnce } from './jsonlTailer';
import { extractThinkingText, needsTranslation } from './thinkingFilter';
import { TranslationQueue } from './translationQueue';
import { writeAndRunAgy } from './agyTranslator';

const RESCAN_INTERVAL_MS = 10000;

export function activate(context: vscode.ExtensionContext): void {
  const panel = new ThinkingPanel();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', panel)
  );

  const workspaceCwdMaybe = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceCwdMaybe) {
    return;
  }
  const workspaceCwd: string = workspaceCwdMaybe;

  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  let paused = false;
  let currentOffset = 0;
  let watcher: fs.FSWatcher | undefined;
  let rescanTimer: NodeJS.Timeout | undefined;

  const translate = (text: string) =>
    writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath });

  const queue = new TranslationQueue(translate, (original, result) => {
    if (result.ok) {
      panel.appendEntry(original, result.text);
    } else {
      panel.appendError(result.error);
    }
  });

  function handleFileChange(file: string): void {
    if (paused) return;
    const { records, nextOffset } = tailOnce(file, currentOffset);
    currentOffset = nextOffset;
    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue;
      const text = extractThinkingText(record as Record<string, unknown>);
      if (text && needsTranslation(text)) {
        queue.enqueue(text);
      }
    }
  }

  function startWatching(file: string): void {
    currentOffset = fs.statSync(file).size; // 활성화 시점부터만 — 과거분 건너뜀
    watcher = fs.watch(file, () => handleFileChange(file));
  }

  function tryStart(): void {
    if (watcher) return;
    const file = findActiveSessionFile(projectsRoot, workspaceCwd);
    if (file) {
      if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = undefined;
      }
      startWatching(file);
    }
  }

  tryStart();
  if (!watcher) {
    rescanTimer = setInterval(tryStart, RESCAN_INTERVAL_MS);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      paused = !paused;
      vscode.window.showInformationMessage(
        paused ? 'claude-thinking-ko: 일시정지됨' : 'claude-thinking-ko: 재개됨'
      );
    })
  );

  context.subscriptions.push({
    dispose: () => {
      watcher?.close();
      if (rescanTimer) clearInterval(rescanTimer);
    }
  });
}

export function deactivate(): void {}
