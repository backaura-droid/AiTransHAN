// VSCode 확장 진입점 — 보조 사이드바에 패널을 하나만 두고, 지금 보고 있는 Claude Code 탭이
// 바뀔 때마다 그 패널이 감시 대상(세션 파일)을 따라 바꾼다.
// 2026-11-10 재설계 경위: ①세션 파일마다 창 하나 → 같은 탭이 재개될 때마다 Claude Code가 새
// 세션 파일을 만들어 창이 중복됨. ②탭 제목으로 식별 → Claude Code가 대화 중 탭 제목을 바꿔서
// (첫 메시지 원문 → 짧은 AI 제목) 다시 연 창이 자기 자신을 닫아버리거나 엉뚱한 내용이 섞임.
// 결국 "창 여러 개를 식별자로 관리"하는 접근 자체가 불안정해서, 창을 하나만 두고 그때그때
// 다시 대상을 잡는 훨씬 단순한 방식으로 되돌렸다.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThinkingPanel, buildEntryHtml, buildErrorHtml } from './panel/thinkingPanel';
import { SessionCache } from './sessionCache';
import { findActiveSessionFile } from './sessionLocator';
import { tailOnce } from './jsonlTailer';
import { pickTranslatable } from './thinkingFilter';
import { TranslationQueue } from './translationQueue';
import { writeAndRunAgy } from './agyTranslator';

// 세션 파일 유무를 훑는 것뿐이라(번역 CLI 호출이 아님) 짧게 잡아도 "초마다 번역 호출 금지"
// 제약과는 무관하다. 탭 전환 이벤트로도 즉시 반응하니 이건 보조적인 안전망이다.
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

const CLAUDE_CODE_TAB_VIEWTYPE = 'mainThreadWebview-claudeVSCodePanel';

// 지금 포커스된(현재 창에서 실제로 보고 있는) Claude Code 탭의 라벨을 찾는다.
// 이 값은 오직 패널 표시용("지금 보는 중: ...")일 뿐, 세션 파일을 고르는 데는 안 쓴다 —
// 세션 파일 선택은 cwd 일치 + 최신 mtime(findActiveSessionFile)만으로 결정한다.
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

export function activate(context: vscode.ExtensionContext): void {
  const panel = new ThinkingPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', panel));

  const workspaceCwdMaybe = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceCwdMaybe) {
    return;
  }
  const workspaceCwd: string = workspaceCwdMaybe;

  const projectsRoot = resolveProjectsRoot();
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  const translate = (text: string) => writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath });

  let paused = false;
  let currentFile: string | null = null;
  let currentOffset = 0;
  let watcher: fs.FSWatcher | undefined;

  // 2026-11-10: 탭 A→B→A로 돌아왔을 때 A에서 보여줬던 내역을 되살리기 위한 세션별 캐시.
  // 번역 결과는 그 항목이 나온 세션(filePath)에만 기록하고, 패널에는 지금 보는 세션일 때만 그린다.
  const sessionCache = new SessionCache(10);

  const queue = new TranslationQueue(translate, (filePath, original, result) => {
    sessionCache.appendIfPresent(
      filePath,
      result.ok ? buildEntryHtml(original, result.text) : buildErrorHtml(result.error, original)
    );
    if (filePath !== currentFile) return;
    if (result.ok) {
      panel.appendEntry(original, result.text);
    } else {
      panel.appendError(result.error, original);
    }
  });

  function handleChange(file: string): void {
    if (paused) return;
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    try {
      const { records, nextOffset } = tailOnce(file, currentOffset);
      currentOffset = nextOffset;
      const translatable = pickTranslatable(records);
      for (const text of translatable) {
        queue.enqueue(file, text);
      }
      // "활성 탭인데 아무것도 안 뜬다"를 구분하려고 — 감시가 죽은 건지,
      // 정말 번역할 레코드가 없었던 건지 상태 줄로 보여준다.
      panel.setStatus(`마지막 확인 ${now} (레코드 ${records.length}개, 번역 대상 ${translatable.length}개)`);
    } catch (e) {
      panel.setStatus(`${now} 처리 중 오류: ${String(e)}`);
    }
  }

  function stopWatching(): void {
    watcher?.close();
    watcher = undefined;
    currentFile = null;
  }

  function startWatching(file: string): void {
    stopWatching();
    currentFile = file;
    currentOffset = (() => {
      try {
        return fs.statSync(file).size; // 과거분 스킵 — 지금부터만 본다
      } catch {
        return 0;
      }
    })();
    try {
      watcher = fs.watch(file, () => handleChange(file));
      watcher.on('error', () => {
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  }

  // 지금 봐야 할 세션 파일을 다시 확인하고, 바뀌었으면 패널 대상을 교체한다.
  // 2026-11-10: 같은 워크스페이스를 창 여러 개(또는 탭 여러 개)로 열어두면 cwd+mtime만으로는
  // 창마다 다른 탭을 구분하지 못해 서로 다른 창의 패널이 같은 파일을 가리키는 사고가 났다.
  // 활성 탭 라벨을 findActiveSessionFile에 함께 넘겨, Claude Code가 세션에 남기는 ai-title과
  // 대조해 "지금 이 창이 보고 있는 바로 그 탭"의 파일을 고르게 한다(없으면 최신 mtime으로 폴백).
  function retarget(): void {
    const label = findActiveClaudeCodeTabLabel();
    const found = findActiveSessionFile(projectsRoot, workspaceCwd, label);

    if (found !== currentFile) {
      // 대상이 바뀌면 이전 대화 내용과 안 섞이게 교체한다 — 전에 보던 세션이면 그때 내역을 복원.
      // 감시는 여전히 "지금부터"만(startWatching) — 자리 비운 동안 쌓인 분은 소급 번역하지 않는다.
      if (found === null) {
        stopWatching();
        panel.clear();
      } else {
        startWatching(found);
        panel.restoreEntries(sessionCache.getOrCreate(found));
      }
    }
    panel.setFollowing(label);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.clear', () => {
      panel.clear();
      // 캐시까지 지워야 한다 — 안 지우면 다른 탭에 갔다가 돌아올 때 지운 내역이 되살아난다.
      if (currentFile) {
        sessionCache.clear(currentFile);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      paused = !paused;
      if (!paused && currentFile) {
        // 리뷰 I3: 재개 시 일시정지 동안 쌓인 분을 한꺼번에 번역 큐에 넣지 않는다 —
        // 파일의 현재 크기로 건너뛰어 "지금부터"만 본다.
        try {
          currentOffset = fs.statSync(currentFile).size;
        } catch {
          // 파일이 사라졌으면 다음 재탐색이 알아서 정리한다
        }
      }
      vscode.window.showInformationMessage(paused ? 'claude-thinking-ko: 일시정지됨' : 'claude-thinking-ko: 재개됨');
    })
  );

  retarget();
  const rescanTimer = setInterval(retarget, RESCAN_INTERVAL_MS);
  // 탭이 바뀌는 즉시 반응해 타이머보다 빠르게 대상을 바꾼다.
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(retarget));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(retarget));

  context.subscriptions.push({
    dispose: () => {
      clearInterval(rescanTimer);
      watcher?.close();
    }
  });
}

export function deactivate(): void {}
