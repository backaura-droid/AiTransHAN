// VSCode 확장 진입점 — 이 워크스페이스의 활성 Claude Code 세션마다 독립된 번역창을 자동으로 열고 감시한다.
// ("창마다 다른 번역창" 요청, 2026-11-10 — 세션 하나만 보던 구조에서는 여러 탭의 사고가
//  패널 하나에 섞여 구별이 안 됐다. 이제 세션 파일마다 자기만의 SessionController를 둔다.)
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThinkingPanel, escapeHtml } from './panel/thinkingPanel';
import { findAllActiveSessionFiles } from './sessionLocator';
import { tailOnce } from './jsonlTailer';
import { pickTranslatable } from './thinkingFilter';
import { TranslationQueue } from './translationQueue';
import { writeAndRunAgy } from './agyTranslator';

// 2026-11-10: "1~5초 간격으로 체크해달라"는 요청으로 줄임 — 이건 세션 파일 유무를 훑는 것뿐이라
// (번역 CLI 호출이 아님) 짧게 잡아도 "초마다 번역 호출 금지" 제약과는 무관하다.
const RESCAN_INTERVAL_MS = 3000;

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

function fallbackSessionTitle(file: string): string {
  return `사고 번역 — ${path.basename(file, '.jsonl').slice(0, 8)}`;
}

// 2026-11-10: 탭 진단 로그로 확인됨 — Claude Code 대화 탭은 이 viewType을 쓰고,
// label에 실제 대화 제목이 그대로 들어있다. 다만 "그 탭이 어느 세션 파일인지"는 이 API로 알 수 없다.
// 그래서 "새 세션을 막 발견한 순간 포커스돼 있던 Claude Code 탭" 제목을 가져다 쓴다(휴리스틱).
// 틀려도 제목만 어긋날 뿐 기능에는 영향 없다.
const CLAUDE_CODE_TAB_VIEWTYPE = 'mainThreadWebview-claudeVSCodePanel';
const OUR_PANEL_VIEWTYPE = 'mainThreadWebview-claudeThinkingKo.window';

// 2026-11-10: 같은 세션의 번역창이 중복으로 쌓이는 버그 — 재설치·재시작을 반복하는 동안 이전
// 세대가 열어둔 창이 정리되지 않고 새 세대가 또 창을 띄운 것으로 보인다. VSCode 자체 기능이
// 아니라 확장이 정리를 안 한 탓이라, 활성화할 때마다 우리 창을 전부 닫고 깨끗하게 다시 연다.
function closeAllOurPanels(): void {
  const ours = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => (tab.input as { viewType?: string } | undefined)?.viewType === OUR_PANEL_VIEWTYPE)
  );
  if (ours.length > 0) {
    void vscode.window.tabGroups.close(ours);
  }
}

function findActiveClaudeCodeTabLabel(): string | null {
  for (const group of vscode.window.tabGroups.all) {
    if (!group.isActive) continue;
    for (const tab of group.tabs) {
      if (!tab.isActive) continue;
      const input = tab.input as { viewType?: string } | undefined;
      if (input?.viewType === CLAUDE_CODE_TAB_VIEWTYPE) {
        return tab.label;
      }
    }
  }
  return null;
}

// "클로드 탭이 꺼지면 번역창도 지워달라" 요청용 — 포커스 여부와 무관하게 열려 있는 모든
// Claude Code 탭의 제목을 모은다(닫혔는지 판정은 이 집합에 더 이상 없는지로 본다).
function openClaudeCodeTabLabels(): Set<string> {
  const labels = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { viewType?: string } | undefined;
      if (input?.viewType === CLAUDE_CODE_TAB_VIEWTYPE) {
        labels.add(tab.label);
      }
    }
  }
  return labels;
}

// 사이드바는 세션별 번역 내용을 담지 않는다(그걸 담으면 다시 한 패널에 다 섞인다) — 상태 + 닫은 세션 다시 열기만 담당한다.
// 닫은 창을 다시 열 방법이 없었던 문제(2026-11-10)의 해결책 — enableCommandUris로 enableScripts 없이 명령 링크를 낸다.
const REOPEN_COMMAND = 'claudeThinkingKo.reopenSession';

class StatusPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private count = 0;
  private closed: Array<{ file: string; title: string }> = [];

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false, enableCommandUris: [REOPEN_COMMAND] };
    this.render();
  }

  update(count: number, closed: Array<{ file: string; title: string }>): void {
    this.count = count;
    this.closed = closed;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const status =
      this.count > 0
        ? `<p>활성 세션 ${this.count}개를 감시 중입니다.</p><p>세션마다 별도 창이 자동으로 열립니다.</p>`
        : '<p>대기 중 — 이 워크스페이스에서 Claude Code 대화가 시작되면 번역창이 자동으로 열립니다.</p>';
    const closedSection =
      this.closed.length > 0
        ? `<p>닫은 세션:</p><ul>${this.closed
            .map((s) => {
              const args = encodeURIComponent(JSON.stringify([s.file]));
              return `<li><a href="command:${REOPEN_COMMAND}?${args}">${escapeHtml(s.title)} 다시 열기</a></li>`;
            })
            .join('')}</ul>`
        : '';
    this.view.webview.html = `<body style="font-family:var(--vscode-font-family);font-size:12px;padding:10px;color:var(--vscode-foreground)">${status}${closedSection}</body>`;
  }
}

interface SessionController {
  file: string;
  title: string;
  /** true면 title이 실제 열린 Claude Code 탭에서 가져온 것 — 이때만 탭이 닫혔는지 확인해 자동으로 닫는다.
   *  false(대체 제목)면 어떤 탭과도 매칭할 근거가 없으므로 자동으로 닫지 않는다. */
  titleFromTab: boolean;
  panel: ThinkingPanel;
  webviewPanel: vscode.WebviewPanel;
  watcher: fs.FSWatcher;
  offset: number;
  paused: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  closeAllOurPanels();

  const status = new StatusPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', status));

  const sessions = new Map<string, SessionController>();
  // 사용자가 직접 닫은 세션 창은 다시 자동으로 열지 않는다(제목은 사이드바 "다시 열기" 목록에 씀).
  const closedByUser = new Map<string, { title: string; titleFromTab: boolean }>();

  function updateStatus(): void {
    status.update(
      sessions.size,
      [...closedByUser.entries()].map(([file, info]) => ({ file, title: info.title }))
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(REOPEN_COMMAND, (file: string) => {
      if (!closedByUser.has(file) || sessions.has(file)) return;
      // 재오픈 시점의 활성 탭은 그 세션과 무관할 수 있으니, 닫히기 전 제목을 그대로 쓴다.
      const previous = closedByUser.get(file);
      closedByUser.delete(file);
      createSession(file, previous);
    })
  );

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

  function createSession(file: string, preferred?: { title: string; titleFromTab: boolean }): void {
    let title: string;
    let titleFromTab: boolean;
    if (preferred) {
      ({ title, titleFromTab } = preferred);
    } else {
      const activeLabel = findActiveClaudeCodeTabLabel();
      titleFromTab = activeLabel !== null;
      title = activeLabel ? `사고 번역 — ${activeLabel}` : fallbackSessionTitle(file);
    }

    const panel = new ThinkingPanel();
    const webviewPanel = vscode.window.createWebviewPanel(
      'claudeThinkingKo.window',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // 2026-11-10: 새 항목이 아래로 쌓이는 순서로 바꾸면서, 맨 아래로 자동 스크롤하는 스크립트가
      // 필요해졌다(ThinkingPanel.buildHtml 참조) — 그래서 이 창만 enableScripts를 켠다.
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.attachStandalonePanel(webviewPanel);

    const controller: SessionController = {
      file,
      title,
      titleFromTab,
      panel,
      webviewPanel,
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
      const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
      try {
        const { records, nextOffset } = tailOnce(file, controller.offset);
        controller.offset = nextOffset;
        const translatable = pickTranslatable(records);
        for (const text of translatable) {
          queue.enqueue(text);
        }
        // 2026-11-10: "활성 탭인데 아무것도 안 뜬다"를 구분하려고 — 감시가 죽은 건지,
        // 정말 번역할 레코드가 없었던 건지 상태 줄로 보여준다.
        controller.panel.setStatus(
          `마지막 확인 ${now} (레코드 ${records.length}개, 번역 대상 ${translatable.length}개)`
        );
      } catch (e) {
        // 일시적인 파일 잠금 같은 흔한 에러도 일단 보이게 한다 — 조용히 삼키면
        // 진짜 버그인지 "할 게 없어서 조용한 것"인지 구분이 안 된다.
        controller.panel.setStatus(`${now} 처리 중 오류: ${String(e)}`);
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
      closedByUser.set(file, { title: controller.title, titleFromTab: controller.titleFromTab });
      updateStatus();
    });

    sessions.set(file, controller);
    updateStatus();
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

  // "클로드 탭이 꺼지면 번역창도 지워달라" 요청 — 제목에서 뽑은 탭 라벨이 더 이상 열린 Claude Code
  // 탭 목록에 없으면 그 번역창을 닫는다(onDidDispose가 알아서 뒷정리를 한다).
  function closeSessionsForClosedClaudeTabs(): void {
    const openLabels = openClaudeCodeTabLabels();
    for (const controller of sessions.values()) {
      // 대체 제목(titleFromTab === false)은 어떤 탭과도 매칭할 근거가 없다 — 건드리지 않는다.
      if (!controller.titleFromTab) continue;
      const match = /^사고 번역 — (.+)$/.exec(controller.title);
      const label = match?.[1];
      if (label && !openLabels.has(label)) {
        controller.webviewPanel.dispose();
      }
    }
  }

  function tick(): void {
    reconcileSessions();
    closeSessionsForClosedClaudeTabs();
  }

  tick();
  const rescanTimer = setInterval(tick, RESCAN_INTERVAL_MS);
  // 탭이 바뀌는 즉시 반응해 타이머(최대 RESCAN_INTERVAL_MS 지연)보다 빠르게 새 세션을 띄운다.
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(tick));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(tick));

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
