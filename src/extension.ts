// VSCode 확장 진입점 — 이 워크스페이스의 활성 Claude Code 세션마다 독립된 번역창을 자동으로 열고 감시한다.
// ("창마다 다른 번역창" 요청, 2026-11-10 — 세션 하나만 보던 구조에서는 여러 탭의 사고가
//  패널 하나에 섞여 구별이 안 됐다. 이제 세션 파일마다 자기만의 SessionController를 둔다.)
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThinkingPanel } from './panel/thinkingPanel';
import { findAllActiveSessionFiles } from './sessionLocator';
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

function sessionTitle(file: string): string {
  return `사고 번역 — ${path.basename(file, '.jsonl').slice(0, 8)}`;
}

// 사이드바는 세션별 번역 내용을 담지 않는다(그걸 담으면 다시 한 패널에 다 섞인다) — 상태만 보여준다.
class StatusPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private count = 0;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    this.render();
  }

  setCount(count: number): void {
    this.count = count;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const body =
      this.count > 0
        ? `<p>활성 세션 ${this.count}개를 감시 중입니다.</p><p>세션마다 별도 창이 자동으로 열립니다.</p>`
        : '<p>대기 중 — 이 워크스페이스에서 Claude Code 대화가 시작되면 번역창이 자동으로 열립니다.</p>';
    this.view.webview.html = `<body style="font-family:var(--vscode-font-family);font-size:12px;padding:10px;color:var(--vscode-foreground)">${body}</body>`;
  }
}

interface SessionController {
  file: string;
  panel: ThinkingPanel;
  watcher: fs.FSWatcher;
  offset: number;
  paused: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  const status = new StatusPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', status));

  const sessions = new Map<string, SessionController>();
  // 사용자가 직접 닫은 세션 창은 다시 자동으로 열지 않는다.
  const closedByUser = new Set<string>();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.clear', () => {
      for (const session of sessions.values()) session.panel.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      // v1: 세션별 개별 일시정지가 아니라 전체를 한 번에 토글한다(단순함 우선).
      for (const session of sessions.values()) {
        session.paused = !session.paused;
        if (!session.paused) {
          // 리뷰 I3: 재개 시 일시정지 동안 쌓인 분을 한꺼번에 번역 큐에 넣지 않는다 —
          // 파일의 현재 크기로 건너뛰어 "지금부터"만 본다.
          try {
            session.offset = fs.statSync(session.file).size;
          } catch {
            // 파일이 사라졌으면 다음 재탐색이 세션을 정리한다
          }
        }
      }
      vscode.window.showInformationMessage('claude-thinking-ko: 전체 세션 일시정지/재개 전환됨');
    })
  );

  const workspaceCwdMaybe = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceCwdMaybe) {
    return;
  }
  const workspaceCwd: string = workspaceCwdMaybe;

  const projectsRoot = resolveProjectsRoot();
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  const translate = (text: string) => writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath });

  function createSession(file: string): void {
    const panel = new ThinkingPanel();
    const webviewPanel = vscode.window.createWebviewPanel(
      'claudeThinkingKo.window',
      sessionTitle(file),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.attachStandalonePanel(webviewPanel);

    const controller: SessionController = {
      file,
      panel,
      // 새로 발견된 세션은 지금부터만 본다(과거분 스킵 — 전역 제약과 동일 원칙).
      offset: (() => {
        try {
          return fs.statSync(file).size;
        } catch {
          return 0;
        }
      })(),
      paused: false,
      watcher: undefined as unknown as fs.FSWatcher
    };

    const queue = new TranslationQueue(translate, (original, result) => {
      if (result.ok) {
        controller.panel.appendEntry(original, result.text);
      } else {
        controller.panel.appendError(result.error, original);
      }
    });

    function handleChange(): void {
      if (controller.paused) return;
      try {
        const { records, nextOffset } = tailOnce(file, controller.offset);
        controller.offset = nextOffset;
        for (const text of pickTranslatable(records)) {
          queue.enqueue(text);
        }
      } catch {
        // 일시적인 파일 잠금이나 회전 중 에러는 무시하고 다음 이벤트에서 이어간다
      }
    }

    try {
      controller.watcher = fs.watch(file, handleChange);
      controller.watcher.on('error', () => {
        // 감시 중이던 파일이 사라져도 창은 유지하고 감시만 멈춘다(재탐색이 새 세션으로 대체해줌)
      });
    } catch {
      // 감시 등록 실패해도 창 자체는 열어둔다
    }

    webviewPanel.onDidDispose(() => {
      controller.watcher?.close();
      sessions.delete(file);
      closedByUser.add(file);
      status.setCount(sessions.size);
    });

    sessions.set(file, controller);
    status.setCount(sessions.size);
  }

  function reconcileSessions(): void {
    try {
      const active = findAllActiveSessionFiles(projectsRoot, workspaceCwd);
      for (const info of active) {
        if (sessions.has(info.file) || closedByUser.has(info.file)) continue;
        createSession(info.file);
      }
    } catch {
      // 디렉터리 접근 일시 오류는 다음 재탐색에서 이어간다
    }
  }

  reconcileSessions();
  const rescanTimer = setInterval(reconcileSessions, RESCAN_INTERVAL_MS);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(rescanTimer);
      for (const session of sessions.values()) {
        session.watcher?.close();
      }
    }
  });
}

export function deactivate(): void {}
