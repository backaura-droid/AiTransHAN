// VSCode 확장 진입점 — 보조 사이드바에 패널을 하나만 두고, 지금 보고 있는 Claude Code 탭이
// 바뀔 때마다 그 패널이 감시 대상(세션 파일)을 따라 바꾼다.
// 2026-11-10 재설계 경위: ①세션 파일마다 창 하나 → 같은 탭이 재개될 때마다 Claude Code가 새
// 세션 파일을 만들어 창이 중복됨. ②탭 제목으로 식별 → Claude Code가 대화 중 탭 제목을 바꿔서
// (첫 메시지 원문 → 짧은 AI 제목) 다시 연 창이 자기 자신을 닫아버리거나 엉뚱한 내용이 섞임.
// 결국 "창 여러 개를 식별자로 관리"하는 접근 자체가 불안정해서, 창을 하나만 두고 그때그때
// 다시 대상을 잡는 훨씬 단순한 방식으로 되돌렸다.
// 같은 날 추가 변경: 패널(표시 대상)은 하나지만 감시는 한 번이라도 활성화된 탭 전부에 계속 걸어 둔다
// (SessionWatcherPool) — 비활성 탭에서 생긴 사고도 백그라운드로 번역돼, 돌아오면 바로 보인다.
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
import { SessionWatcherPool } from './sessionWatcherPool';
import { pickProvider, probeAgyAvailable, type ProviderSetting } from './providerResolver';
import { translateViaOpenAiCompat } from './openAiCompatTranslator';
import { API_PROVIDER_PRESETS, detectProvider } from './apiProviderPresets';

const API_KEY_SECRET = 'claudeThinkingKo.apiKey';
// 'gemini' | 'groq' | 'openrouter' | 'custom' — API_PROVIDER_PRESETS의 id 중 하나, 또는 'custom'
const ACTIVE_PROVIDER_STATE = 'claudeThinkingKo.activeApiProvider';
const CUSTOM_BASE_URL_STATE = 'claudeThinkingKo.customBaseUrl';
const CUSTOM_MODEL_STATE = 'claudeThinkingKo.customModel';
const HAS_PROMPTED_KEY = 'claudeThinkingKo.hasPromptedApiKey';

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

// 배포 후 agy(개발자 본인의 구독 CLI)가 없는 사용자를 위한 대체 경로 — API 키 입력을 받는다.
// Gemini·Groq·OpenRouter는 키 접두사로 자동 인식하고, 그 외(OpenCode·LLM7·자체 게이트웨이 등
// OpenAI 호환 엔드포인트라면 뭐든)는 "직접 입력"으로 base URL·모델을 받는다. 키는 VSCode
// SecretStorage(설정 파일 평문 노출 없음)에 저장한다. 패널 상단 열쇠 아이콘과 명령 팔레트
// 양쪽에서 같은 명령을 쓴다.
async function promptAndStoreApiKey(context: vscode.ExtensionContext): Promise<void> {
  const input = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    title: 'API 키 설정',
    prompt: 'Gemini·Groq·OpenRouter 키를 붙여넣으면 자동으로 인식합니다. 다른 서비스는 다음 화면에서 "직접 입력"을 고르세요.',
    placeHolder: 'AIzaSy... / gsk_... / sk-or-v1-...'
  });
  if (!input) return;

  const detected = detectProvider(input);
  const CUSTOM_ID = 'custom';
  const items: Array<vscode.QuickPickItem & { id: string }> = [
    ...API_PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.id === detected?.id ? `$(check) ${preset.label} (자동 인식됨)` : preset.label
    })),
    { id: CUSTOM_ID, label: '직접 입력(커스텀)', description: 'OpenAI 호환 엔드포인트 — OpenCode, LLM7, 자체 게이트웨이 등' }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: '어느 서비스의 키인가요?',
    ignoreFocusOut: true
  });
  if (!picked) return;

  if (picked.id === CUSTOM_ID) {
    const baseUrl = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: '엔드포인트 base URL',
      prompt: 'OpenAI 호환 /chat/completions를 제공하는 base URL',
      placeHolder: 'https://api.example.com/v1'
    });
    if (!baseUrl) return;
    const model = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: '모델 이름',
      prompt: '그 엔드포인트에서 쓸 모델 id',
      placeHolder: 'model-id'
    });
    if (!model) return;
    await context.globalState.update(CUSTOM_BASE_URL_STATE, baseUrl);
    await context.globalState.update(CUSTOM_MODEL_STATE, model);
  }

  await context.secrets.store(API_KEY_SECRET, input);
  await context.globalState.update(ACTIVE_PROVIDER_STATE, picked.id);
  const label = picked.id === CUSTOM_ID ? '커스텀' : API_PROVIDER_PRESETS.find((p) => p.id === picked.id)?.label;
  vscode.window.showInformationMessage(`Claude 사고 번역: ${label} API 키를 저장했습니다.`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const panel = new ThinkingPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeThinkingKo.panel', panel));

  // 워크스페이스 유무와 무관하게 항상 등록 — 아래 early return보다 먼저 와야 한다.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.setApiKey', () => promptAndStoreApiKey(context))
  );

  const workspaceCwdMaybe = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceCwdMaybe) {
    return;
  }
  const workspaceCwd: string = workspaceCwdMaybe;

  const projectsRoot = resolveProjectsRoot();
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  // agy 설치 여부는 세션 중 바뀌지 않는다고 보고 한 번만 확인(프로세스 스폰 비용 — 매 호출마다 하지 않음).
  // 설정(provider)과 저장된 키는 번역할 때마다 다시 읽어, 사용자가 활동 중에 설정을 바꾸거나
  // 열쇠 아이콘으로 키를 새로 넣어도 재시작 없이 바로 다음 번역부터 반영된다.
  let cachedAgyAvailable: boolean | undefined;
  const translate = async (text: string): Promise<string> => {
    const setting = vscode.workspace
      .getConfiguration('claudeThinkingKo')
      .get<ProviderSetting>('provider', 'auto');
    if (setting !== 'apiKey') {
      if (cachedAgyAvailable === undefined) {
        cachedAgyAvailable = setting === 'agy' ? true : await probeAgyAvailable();
      }
      if (pickProvider(setting, cachedAgyAvailable) === 'agy') {
        return writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath });
      }
    }
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    const providerId = context.globalState.get<string>(ACTIVE_PROVIDER_STATE);
    if (!apiKey || !providerId) {
      throw new Error('API 키가 설정되지 않음 — 패널 상단 열쇠 아이콘에서 설정하세요');
    }
    let baseUrl: string;
    let model: string;
    if (providerId === 'custom') {
      baseUrl = context.globalState.get<string>(CUSTOM_BASE_URL_STATE) ?? '';
      model = context.globalState.get<string>(CUSTOM_MODEL_STATE) ?? '';
      if (!baseUrl || !model) {
        throw new Error('커스텀 엔드포인트 설정이 올바르지 않음 — 열쇠 아이콘에서 다시 설정하세요');
      }
    } else {
      const preset = API_PROVIDER_PRESETS.find((p) => p.id === providerId);
      if (!preset) {
        throw new Error('알 수 없는 제공자 설정 — 열쇠 아이콘에서 다시 설정하세요');
      }
      baseUrl = preset.baseUrl;
      model = preset.defaultModel;
    }
    return translateViaOpenAiCompat(text, { baseUrl, model, apiKey });
  };

  // 설치 후 agy도 없고 키도 없는 사용자에게 딱 한 번만 안내한다(매번 다시 물어보지 않음 — 나중에
  // 생각나면 열쇠 아이콘/명령 팔레트로 언제든 직접 설정 가능).
  void (async () => {
    const setting = vscode.workspace.getConfiguration('claudeThinkingKo').get<ProviderSetting>('provider', 'auto');
    if (setting === 'agy') return;
    if (setting === 'auto' && (await probeAgyAvailable())) return;
    if (await context.secrets.get(API_KEY_SECRET)) return;
    if (context.globalState.get(HAS_PROMPTED_KEY)) return;
    await context.globalState.update(HAS_PROMPTED_KEY, true);
    const choice = await vscode.window.showInformationMessage(
      'Claude 사고 번역: 번역에 쓸 API 키가 필요해요(Gemini·Groq·OpenRouter 중 하나, 전부 무료 발급).',
      'API 키 입력',
      '나중에'
    );
    if (choice === 'API 키 입력') {
      await promptAndStoreApiKey(context);
    }
  })();

  let paused = false;
  // 패널에 보여주는 세션(지금 보는 탭). 감시는 이 파일 하나가 아니라 pool의 모든 파일에 걸려 있다.
  let activeFile: string | null = null;
  // 파일마다 마지막으로 읽은 바이트 위치 — pool이 상한 때문에 감시를 끊었다 다시 열어도 보존돼,
  // 끊긴 동안 쌓인 분까지 다음 tailOnce에서 따라잡는다.
  const offsets = new Map<string, number>();

  // 2026-11-10: 탭 A→B→A로 돌아왔을 때 A에서 보여줬던 내역을 되살리기 위한 세션별 캐시.
  // 번역 결과는 그 항목이 나온 세션(filePath)에만 기록하고, 패널에는 지금 보는 세션일 때만 그린다.
  // 비활성 탭에서 백그라운드로 번역된 결과도 여기 쌓였다가 그 탭으로 돌아오면 restoreEntries로 보인다.
  const sessionCache = new SessionCache(10);

  const queue = new TranslationQueue(
    translate,
    (filePath, original, result) => {
      sessionCache.appendIfPresent(
        filePath,
        result.ok ? buildEntryHtml(original, result.text) : buildErrorHtml(result.error, original)
      );
      if (filePath !== activeFile) return;
      if (result.ok) {
        panel.appendEntry(original, result.text);
      } else {
        panel.appendError(result.error, original);
      }
    },
    // agy 호출 왕복(12~14초)이 걸리는 동안 멈춘 것처럼 보인다는 피드백 — 번역 중/대기 중을 또렷이 보여준다.
    (busy) => panel.setTranslating(busy)
  );

  function handleChange(file: string): void {
    if (paused) return;
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    try {
      const { records, nextOffset } = tailOnce(file, offsets.get(file) ?? 0);
      offsets.set(file, nextOffset);
      const translatable = pickTranslatable(records);
      for (const text of translatable) {
        queue.enqueue(file, text);
      }
      // "활성 탭인데 아무것도 안 뜬다"를 구분하려고 — 감시가 죽은 건지,
      // 정말 번역할 레코드가 없었던 건지 상태 줄로 보여준다. 백그라운드 탭 소식으로 덮어쓰지 않는다.
      if (file === activeFile) {
        panel.setStatus(`마지막 확인 ${now} (레코드 ${records.length}개, 번역 대상 ${translatable.length}개)`);
      }
    } catch (e) {
      if (file === activeFile) {
        panel.setStatus(`${now} 처리 중 오류: ${String(e)}`);
      }
    }
  }

  const pool = new SessionWatcherPool({ maxSessions: 10, onChange: handleChange });

  // 지금 봐야 할 세션 파일을 다시 확인하고, 바뀌었으면 패널 대상을 교체한다.
  // 2026-11-10: 같은 워크스페이스를 창 여러 개(또는 탭 여러 개)로 열어두면 cwd+mtime만으로는
  // 창마다 다른 탭을 구분하지 못해 서로 다른 창의 패널이 같은 파일을 가리키는 사고가 났다.
  // 활성 탭 라벨을 findActiveSessionFile에 함께 넘겨, Claude Code가 세션에 남기는 ai-title과
  // 대조해 "지금 이 창이 보고 있는 바로 그 탭"의 파일을 고르게 한다(없으면 최신 mtime으로 폴백).
  function retarget(): void {
    const label = findActiveClaudeCodeTabLabel();
    const found = findActiveSessionFile(projectsRoot, workspaceCwd, label);

    if (found !== null) {
      if (!offsets.has(found)) {
        // 처음 보는 세션은 과거분을 건너뛴다 — 연 적도 없는 몇 달 전 대화를 통째로 번역하는 사고 방지.
        try {
          offsets.set(found, fs.statSync(found).size);
        } catch {
          offsets.set(found, 0);
        }
        // 화면에 띄우기 전이라도 캐시 슬롯이 있어야 백그라운드 번역 결과가 버려지지 않는다.
        sessionCache.getOrCreate(found);
      }
      // 2026-11-10: 다른 탭으로 옮겨가도 감시를 끊지 않는다 — 한 번 활성화된 탭은 백그라운드에서도
      // 계속 번역되고, 돌아오면 그 사이 쌓인 것까지 바로 보인다(이전 "지금부터만" 정책을 대체).
      pool.ensureWatching(found);
    }

    if (found !== activeFile) {
      // 보여줄 대상이 바뀌면 이전 대화와 안 섞이게 교체하고, 그 세션에 쌓인 내역 전체를 복원한다.
      activeFile = found;
      queue.setActiveFile(found);
      if (found === null) {
        panel.clear();
      } else {
        // get이 아닌 getOrCreate — 캐시 상한으로 퇴출됐던 세션이면 슬롯을 다시 만들어 이후 결과를 받는다.
        panel.restoreEntries(sessionCache.getOrCreate(found));
      }
    }
    panel.setFollowing(label);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.clear', () => {
      panel.clear();
      // 캐시까지 지워야 한다 — 안 지우면 다른 탭에 갔다가 돌아올 때 지운 내역이 되살아난다.
      if (activeFile) {
        sessionCache.clear(activeFile);
        sessionCache.getOrCreate(activeFile); // 지운 뒤에도 이후 번역 결과는 계속 받아야 한다
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeThinkingKo.togglePause', () => {
      paused = !paused;
      if (!paused && activeFile) {
        // 리뷰 I3: 재개 시 일시정지 동안 쌓인 분을 한꺼번에 번역 큐에 넣지 않는다 —
        // 파일의 현재 크기로 건너뛰어 "지금부터"만 본다. 사용자가 명시적으로 멈춘 것이라
        // 비활성 탭 백그라운드 감시와는 다른 정책이며, 기존처럼 지금 보는 세션 하나에만 적용한다.
        try {
          offsets.set(activeFile, fs.statSync(activeFile).size);
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
      pool.dispose();
    }
  });
}

export function deactivate(): void {}
