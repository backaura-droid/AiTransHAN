// VSCode 확장 진입점 — 세션 감시부터 번역, 패널 표시까지 전체를 배선한다
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThinkingPanel } from './panel/thinkingPanel';
import { findActiveSessionFile, decideNextWatch } from './sessionLocator';
import { tailOnce } from './jsonlTailer';
import { pickTranslatable } from './thinkingFilter';
import { TranslationQueue } from './translationQueue';
import { writeAndRunAgy } from './agyTranslator';

const RESCAN_INTERVAL_MS = 10000;

function resolveProjectsRoot(): string {
  const envVars = vscode.workspace
    .getConfiguration('claudeCode')
    .get<Array<{ name?: string; value?: string }>>('environmentVariables');
  if (Array.isArray(envVars)) {
    const found = envVars.find((item) => item?.name === 'CLAUDE_CONFIG_DIR' && item?.value);
    if (found?.value) {
      return path.join(found.value, 'projects');
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

export function activate(context: vscode.ExtensionContext): void {
  const panel = new ThinkingPanel();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', panel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  let paused = false;
  let currentOffset = 0;
  let watchedFile: string | null = null;
  let hasInitializedWatch = false;
  let watcher: fs.FSWatcher | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.openWindow', () => {
      const existing = panel.getStandalonePanel();
      if (existing) {
        existing.reveal(vscode.ViewColumn.Beside);
        return;
      }
      const webviewPanel = vscode.window.createWebviewPanel(
        'claudeThinkingKo.window',
        'Claude 사고 번역창',
        vscode.ViewColumn.Beside,
        { enableScripts: false, retainContextWhenHidden: true }
      );
      panel.attachStandalonePanel(webviewPanel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.clear', () => {
      panel.clear();
    })
  );

  // 리뷰 I3: togglePause는 워크스페이스가 없어도(아래 가드 이전에) 항상 등록해야
  // "명령을 찾을 수 없음" 오류 없이 동작한다.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      paused = !paused;
      if (!paused && watchedFile) {
        try {
          // 리뷰 I3: 재개 시 일시정지 동안 쌓인 분을 한꺼번에 번역 큐에 넣지 않는다 —
          // 파일의 현재 크기로 건너뛰어 "지금부터"만 본다(과거분 건너뜀 원칙을 재개에도 적용).
          currentOffset = fs.statSync(watchedFile).size;
        } catch {
          // 파일이 사라졌으면 다음 재탐색이 새로 찾는다
        }
      }
      vscode.window.showInformationMessage(
        paused ? 'claude-thinking-ko: 일시정지됨' : 'claude-thinking-ko: 재개됨'
      );
    })
  );

  const workspaceCwdMaybe = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceCwdMaybe) {
    return;
  }
  const workspaceCwd: string = workspaceCwdMaybe;

  const projectsRoot = resolveProjectsRoot();
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  const translate = (text: string) =>
    writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath });

  const queue = new TranslationQueue(translate, (original, result) => {
    if (result.ok) {
      panel.appendEntry(original, result.text);
    } else {
      panel.appendError(result.error, original);
    }
  });

  function handleFileChange(file: string): void {
    if (paused) return;
    try {
      const { records, nextOffset } = tailOnce(file, currentOffset);
      currentOffset = nextOffset;
      for (const text of pickTranslatable(records)) {
        queue.enqueue(text);
      }
    } catch {
      // 일시적인 파일 잠금이나 회전 중 에러는 무시하고 다음 이벤트/재탐색에서 이어간다
    }
  }

  function watch(file: string, startFromBeginning: boolean): void {
    // 교차검증 보강: 다른 파일로 전환하기 직전 기존 감시 파일의 잔여 데이터를 마지막으로 읽는다
    if (watchedFile && watchedFile !== file) {
      handleFileChange(watchedFile);
    }
    watcher?.close();
    try {
      currentOffset = startFromBeginning ? 0 : fs.statSync(file).size;
      watchedFile = file;
      hasInitializedWatch = true;
      watcher = fs.watch(file, () => handleFileChange(file));
      watcher.on('error', () => {
        // 리뷰 C3 연계: 감시 중이던 파일이 사라지거나 이름이 바뀌어도 확장이 죽지 않게 한다.
        // hasInitializedWatch는 true로 유지되므로 다음 재탐색(reconcileWatch)에서 복구 시 처음부터 읽는다.
        watcher = undefined;
        watchedFile = null;
      });
      // 교차검증 Critical 수정: 새 세션(startFromBeginning === true) 전환 시
      // 감시 등록 이전에 이미 파일에 쓰인 초기 사고 블록들을 즉시 1회 읽어 처리한다.
      if (startFromBeginning) {
        handleFileChange(file);
      }
    } catch {
      watcher = undefined;
      watchedFile = null;
    }
  }

  // 리뷰 C3: 세션 파일을 한 번 찾으면 영구히 고정돼 새 대화를 못 따라갔다.
  // 감시 중에도 멈추지 않고 계속 재탐색해서, 더 최근 파일이 나타나면 거기로 옮겨간다.
  function reconcileWatch(): void {
    try {
      const found = findActiveSessionFile(projectsRoot, workspaceCwd);
      const decision = decideNextWatch(found, watchedFile, hasInitializedWatch);
      if (decision) {
        watch(decision.file, decision.startFromBeginning);
      }
    } catch {
      // 디렉터리 접근 일시 오류 무시
    }
  }

  reconcileWatch();
  const rescanTimer = setInterval(reconcileWatch, RESCAN_INTERVAL_MS);

  context.subscriptions.push({
    dispose: () => {
      watcher?.close();
      clearInterval(rescanTimer);
    }
  });
}

export function deactivate(): void {}
