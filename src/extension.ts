// VSCode 확장 진입점 — Claude Code 탭(제목)마다 독립된 번역창을 자동으로 열고 감시한다.
// 2026-11-10 재설계: 처음엔 "세션 파일마다 창 하나"였는데, 실측해보니 같은 Claude Code 탭을
// 재시작·재개할 때마다 Claude Code가 새 세션 파일을 만들어서(같은 탭, 다른 파일 4개가 동시에
// 활성 상태였음) 창이 중복으로 쌓였다. 그래서 식별 기준을 파일이 아니라 "탭 제목"으로 바꿨다 —
// 같은 제목이면 새 창을 안 만들고 기존 창에 파일만 추가로 물린다(한 창이 여러 파일을 감시할 수 있음).
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

function safeFileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// 2026-11-10: 탭 진단 로그로 확인됨 — Claude Code 대화 탭은 이 viewType을 쓰고,
// label에 실제 대화 제목이 그대로 들어있다. 다만 "그 탭이 어느 세션 파일인지"는 이 API로 알 수 없다.
// 그래서 "새 세션을 막 발견한 순간 포커스돼 있던 Claude Code 탭" 제목을 가져다 쓴다(휴리스틱).
// 틀려도 제목만 어긋날 뿐 기능에는 영향 없다.
const CLAUDE_CODE_TAB_VIEWTYPE = 'mainThreadWebview-claudeVSCodePanel';
const OUR_PANEL_VIEWTYPE = 'mainThreadWebview-claudeThinkingKo.window';

// 확장이 활성화될 때마다(재시작·새로고침 시마다) 우리 확장이 만든 번역창을 전부 닫고
// 깨끗한 상태에서 다시 연다 — 이전 세대가 열어둔 창이 남아 있으면 중복의 원인이 된다.
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

// 사이드바는 세션별 번역 내용을 담지 않는다(그걸 담으면 다시 한 패널에 다 섞인다) — 상태 + 닫은 세션 다시 열기만 담당한다.
const REOPEN_COMMAND = 'claudeThinkingKo.reopenSession';

class StatusPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private count = 0;
  private closedTitles: string[] = [];

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false, enableCommandUris: [REOPEN_COMMAND] };
    this.render();
  }

  update(count: number, closedTitles: string[]): void {
    this.count = count;
    this.closedTitles = closedTitles;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const status =
      this.count > 0
        ? `<p>활성 세션 ${this.count}개를 감시 중입니다.</p><p>세션마다 별도 창이 자동으로 열립니다.</p>`
        : '<p>대기 중 — 이 워크스페이스에서 Claude Code 대화가 시작되면 번역창이 자동으로 열립니다.</p>';
    const closedSection =
      this.closedTitles.length > 0
        ? `<p>닫은 세션:</p><ul>${this.closedTitles
            .map((title) => {
              const args = encodeURIComponent(JSON.stringify([title]));
              return `<li><a href="command:${REOPEN_COMMAND}?${args}">${escapeHtml(title)} 다시 열기</a></li>`;
            })
            .join('')}</ul>`
        : '';
    this.view.webview.html = `<body style="font-family:var(--vscode-font-family);font-size:12px;padding:10px;color:var(--vscode-foreground)">${status}${closedSection}</body>`;
  }
}

interface WatchedFile {
  offset: number;
  watcher: fs.FSWatcher | undefined;
}

interface PanelGroup {
  title: string;
  panel: ThinkingPanel;
  webviewPanel: vscode.WebviewPanel;
  paused: boolean;
  /** 같은 탭이 재시작될 때마다 Claude Code가 새 세션 파일을 만들 수 있어, 한 창이 파일 여러 개를 동시에 감시할 수 있다. */
  files: Map<string, WatchedFile>;
}

export function activate(context: vscode.ExtensionContext): void {
  closeAllOurPanels();

  const status = new StatusPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', status));

  const groups = new Map<string, PanelGroup>();
  // 사용자가 직접 닫은 제목은 다시 자동으로 창을 열지 않는다 — 그 제목으로 들어오는 새 파일은
  // 조용히 이 기록에만 추가해뒀다가, 사용자가 "다시 열기"를 누르면 한꺼번에 복원한다.
  const closedByUser = new Map<string, { files: string[] }>();

  function updateStatus(): void {
    status.update(groups.size, [...closedByUser.keys()]);
  }

  function isFileHandled(file: string): boolean {
    for (const group of groups.values()) {
      if (group.files.has(file)) return true;
    }
    for (const closed of closedByUser.values()) {
      if (closed.files.includes(file)) return true;
    }
    return false;
  }

  const workspaceCwdMaybe = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceCwdMaybe) {
    return;
  }
  const workspaceCwd: string = workspaceCwdMaybe;

  const projectsRoot = resolveProjectsRoot();
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  const translate = (text: string) => writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath });

  function addFileToGroup(group: PanelGroup, file: string, startFromBeginning: boolean): void {
    if (group.files.has(file)) return;

    const queue = new TranslationQueue(translate, (original, result) => {
      if (result.ok) {
        group.panel.appendEntry(original, result.text);
      } else {
        group.panel.appendError(result.error, original);
      }
    });

    const watchedFile: WatchedFile = {
      offset: startFromBeginning ? 0 : safeFileSize(file),
      watcher: undefined
    };

    function handleChange(): void {
      if (group.paused) return;
      const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
      try {
        const { records, nextOffset } = tailOnce(file, watchedFile.offset);
        watchedFile.offset = nextOffset;
        const translatable = pickTranslatable(records);
        for (const text of translatable) {
          queue.enqueue(text);
        }
        // 2026-11-10: "활성 탭인데 아무것도 안 뜬다"를 구분하려고 — 감시가 죽은 건지,
        // 정말 번역할 레코드가 없었던 건지 상태 줄로 보여준다.
        group.panel.setStatus(`마지막 확인 ${now} (레코드 ${records.length}개, 번역 대상 ${translatable.length}개)`);
      } catch (e) {
        group.panel.setStatus(`${now} 처리 중 오류: ${String(e)}`);
      }
    }

    try {
      watchedFile.watcher = fs.watch(file, handleChange);
      watchedFile.watcher.on('error', () => {
        // 이 파일만 감시를 멈춘다 — 창/그룹의 다른 파일은 그대로 유지
        group.files.delete(file);
      });
    } catch {
      // 감시 등록 실패해도 창 자체는 유지
    }

    group.files.set(file, watchedFile);
  }

  function ensureGroup(title: string): PanelGroup {
    const existing = groups.get(title);
    if (existing) return existing;

    const panel = new ThinkingPanel();
    const webviewPanel = vscode.window.createWebviewPanel(
      'claudeThinkingKo.window',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // 2026-11-10: 새 항목이 아래로 쌓이는 순서라 맨 아래로 자동 스크롤하는 스크립트가 필요하다.
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.attachStandalonePanel(webviewPanel);

    const group: PanelGroup = { title, panel, webviewPanel, paused: false, files: new Map() };

    webviewPanel.onDidDispose(() => {
      for (const wf of group.files.values()) {
        wf.watcher?.close();
      }
      groups.delete(title);
      closedByUser.set(title, { files: [...group.files.keys()] });
      updateStatus();
    });

    groups.set(title, group);
    return group;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(REOPEN_COMMAND, (title: string) => {
      const closed = closedByUser.get(title);
      if (!closed || groups.has(title)) return;
      closedByUser.delete(title);
      const group = ensureGroup(title);
      for (const file of closed.files) {
        addFileToGroup(group, file, false); // 다시 열 때도 지금부터만(그사이 쌓인 분은 건너뜀)
      }
      updateStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.clear', () => {
      for (const group of groups.values()) group.panel.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      // v1: 세션별 개별 일시정지가 아니라 전체를 한 번에 토글한다(단순함 우선).
      for (const group of groups.values()) {
        group.paused = !group.paused;
        if (!group.paused) {
          // 리뷰 I3: 재개 시 일시정지 동안 쌓인 분을 한꺼번에 번역 큐에 넣지 않는다 —
          // 각 파일의 현재 크기로 건너뛰어 "지금부터"만 본다.
          for (const [file, wf] of group.files) {
            wf.offset = safeFileSize(file);
          }
        }
      }
      vscode.window.showInformationMessage('claude-thinking-ko: 전체 세션 일시정지/재개 전환됨');
    })
  );

  function reconcileSessions(): void {
    try {
      const active = findAllActiveSessionFiles(projectsRoot, workspaceCwd);
      for (const info of active) {
        if (isFileHandled(info.file)) continue;

        const activeLabel = findActiveClaudeCodeTabLabel();
        const title = activeLabel ? `사고 번역 — ${activeLabel}` : fallbackSessionTitle(info.file);

        // 사용자가 이미 닫은 제목이면 창은 안 띄우고 기록에만 파일을 추가해둔다(다시 열기 때 복원됨).
        const closed = closedByUser.get(title);
        if (closed) {
          closed.files.push(info.file);
          continue;
        }

        const group = ensureGroup(title);
        addFileToGroup(group, info.file, false);
      }
    } catch {
      // 디렉터리 접근 일시 오류는 다음 재탐색에서 이어간다
    }
  }

  // 2026-11-10 Ruling: "클로드 탭이 꺼지면 번역창도 지워달라"는 요청으로 탭 라벨 기준 자동 닫기를
  // 넣었다가 뺐다 — Claude Code는 대화 중 탭 라벨을 바꾼다(첫 메시지 원문 → 나중에 짧은 AI 제목).
  // 라벨을 안정적인 식별자로 쓸 수 없어서, 다시 연 창이 "방금 그 라벨이 안 보인다"며 곧바로
  // 스스로 닫혀버리는(켜지다 꺼짐) 사고가 났다. 안정적인 식별자가 생기기 전까지는 수동으로만
  // 닫고(사이드바 "다시 열기"로 복원) 자동으로는 닫지 않는다.
  function tick(): void {
    reconcileSessions();
  }

  tick();
  const rescanTimer = setInterval(tick, RESCAN_INTERVAL_MS);
  // 탭이 바뀌는 즉시 반응해 타이머(최대 RESCAN_INTERVAL_MS 지연)보다 빠르게 새 세션을 띄운다.
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(tick));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(tick));

  context.subscriptions.push({
    dispose: () => {
      clearInterval(rescanTimer);
      for (const group of groups.values()) {
        for (const wf of group.files.values()) {
          wf.watcher?.close();
        }
      }
    }
  });
}

export function deactivate(): void {}
