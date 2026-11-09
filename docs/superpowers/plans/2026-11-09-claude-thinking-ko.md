# claude-thinking-ko Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VSCode 확장을 만들어, Claude Code 세션 로그에 새로 기록되는 사고(thinking) 블록을 agy(Gemini CLI)로 번역해 사이드바 패널에 실시간으로 보여준다.

**Architecture:** 활성 세션 `.jsonl` 파일을 Node 내장 `fs.watch`로 지켜보다가(별도 의존성 불필요 — 파일 하나만 보면 되므로 chokidar 불필요), 바이트 오프셋 기준으로 새로 추가된 완성 줄만 파싱한다. 한글 비율이 낮은 사고 블록만 FIFO 큐에 넣어 agy CLI를 한 번에 하나씩 호출하고, 결과를 WebviewView 패널에 쌓는다. 모든 단계가 순수 Node.js 코드이며 LLM 대화를 거치지 않는다.

**Tech Stack:** TypeScript, VSCode Extension API(WebviewViewProvider), Node 내장 `fs`/`child_process`/`crypto`, `node:test`(단위 테스트, 별도 테스트 프레임워크 불필요).

**Spec:** `C:\Users\user\claude-thinking-ko\docs\superpowers\specs\2026-11-09-claude-thinking-ko-design.md`

## Global Constraints

- 번역 백엔드는 v1에서 agy(Gemini CLI) 하나만 쓴다. Claude CLI로 번역하는 경로는 만들지 않는다.
- 원문 텍스트를 명령줄 인자로 직접 넘기지 않는다 — 임시 파일에 쓰고 `cmd /c type <파일> | agy ...` 패턴으로 표준입력으로 전달한다.
- 확장 활성화 시 과거에 쌓인 사고 블록은 번역하지 않는다 — 활성화 시점(파일 끝)부터만 감시한다.
- 번역 호출은 동시에 하나만 — FIFO 큐로 순차 처리한다.
- 대상은 "Claude Code" 확장 세션 로그로 한정한다 — Codex·Antigravity 자체 에이전트 로그는 다루지 않는다.
- 외부 번역 API 키는 쓰지 않는다.
- 구현 중 세션 jsonl의 thinking 실제 본문 텍스트를 터미널에 출력해 자신의 LLM 대화 맥락으로 되읽지 않는다 — 스키마는 키 이름만으로 확인했고(설계 문서 참조), 번역 동작은 확장을 직접 실행해 패널에 뜬 결과를 눈으로 확인한다.
- 저장소 위치: `C:\Users\user\claude-thinking-ko`.

## Review Focus

- 세션 jsonl의 마지막 줄이 아직 다 쓰이지 않은 채로 읽힐 때 — 크래시 없이 다음 변경 이벤트까지 보류하고 재시도해야 한다.
- 워크스페이스에 대응하는 Claude Code 세션이 아직 하나도 없을 때(`cwd` 일치 파일 없음) — 확장이 죽지 않고 조용히 대기해야 한다.
- 이미 한국어 위주이거나 코드 식별자만 영문으로 섞인 사고 텍스트 — 불필요하게 번역 큐에 들어가면 안 된다.
- agy 호출이 실패(미설치·타임아웃·쿼터 초과)할 때 — 패널에 에러만 뜨고 큐의 다음 항목 처리가 막히면 안 된다.
- 레코드가 `isApiErrorMessage`/`apiRefusalCategory`가 찍힌 거부·오류 레코드일 때 — 정상 사고 블록처럼 번역 큐에 들어가면 안 된다.

---

## Task 1: 프로젝트 뼈대 + 호스트 설치 가능 여부 검증

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `resources/icon.svg`
- Create: `src/extension.ts`

**Interfaces:**
- Produces: `activate(context: vscode.ExtensionContext): void`, `deactivate(): void` — 이후 모든 태스크가 이 두 함수를 확장해간다.
- Produces: 뷰 컨테이너 id `claudeThinkingKo`, 뷰 id `claudeThinkingKo.panel`, 커맨드 id `claudeThinkingKo.togglePause` — 이후 태스크가 그대로 참조한다.

- [ ] **Step 1: `package.json` 작성**

```json
{
  "name": "claude-thinking-ko",
  "displayName": "Claude 사고 한글 보기",
  "description": "Claude Code 세션의 사고(thinking) 블록을 한국어로 번역해 보여주는 패널",
  "version": "0.0.1",
  "private": true,
  "engines": { "vscode": "^1.85.0" },
  "main": "./out/src/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "claudeThinkingKo", "title": "Claude 사고 번역", "icon": "resources/icon.svg" }
      ]
    },
    "views": {
      "claudeThinkingKo": [
        { "id": "claudeThinkingKo.panel", "name": "사고 번역", "type": "webview" }
      ]
    },
    "commands": [
      { "command": "claudeThinkingKo.togglePause", "title": "Claude 사고 번역: 일시정지/재개" }
    ]
  },
  "scripts": {
    "compile": "tsc -p .",
    "test": "tsc -p . && node --test out/test",
    "package": "vsce package"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "@vscode/vsce": "^3.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json` 작성**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": ".",
    "strict": true,
    "sourceMap": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 3: `resources/icon.svg` 작성 (사이드바 아이콘, 단순 도형이면 충분)**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
  <path d="M8 1a5 5 0 0 0-5 5c0 2 1 3 2 4v2h6v-2c1-1 2-2 2-4a5 5 0 0 0-5-5z"/>
  <rect x="6" y="13" width="4" height="2"/>
</svg>
```

- [ ] **Step 4: `src/extension.ts` 작성 — 최소 동작(패널 자리만, 번역 로직 없음)**

```typescript
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
```

- [ ] **Step 5: 컴파일 확인**

Run: `cd C:\Users\user\claude-thinking-ko && npm install && npm run compile`
Expected: 에러 없이 `out/src/extension.js` 생성됨.

- [ ] **Step 6: (수동) Extension Development Host에서 로드 확인**

VSCode에서 이 폴더를 열고 F5(Run Extension). 새 창에서 활동 표시줄에 아이콘이 뜨고 클릭하면 "대기 중" 텍스트가 보여야 한다.
Expected: 패널이 뜬다.

- [ ] **Step 7: (수동) 실제 대상 호스트(Antigravity)에 설치 가능 여부 확인 — 이 계획에서 가장 중요한 검증**

`npx vsce package`로 `.vsix`를 만든 뒤, 사용자가 실제 쓰는 IDE 호스트(스크린샷의 Antigravity)에서 "VSIX에서 설치"로 설치해본다. 안 되면(서명 안 된 로컬 확장 차단 등) 설계 문서의 "빌드 순서상 먼저 확인할 것" 절대로 범위를 "표준 VSCode만 지원, Antigravity는 추후"로 좁히고 이후 태스크를 계속 진행한다 — 전체 설계를 다시 짤 필요는 없다.
Expected: 설치되어 패널이 뜨거나(성공), 설치가 막혀서 범위를 좁히기로 기록함(실패해도 다음 태스크 진행 가능).

- [ ] **Step 8: 커밋**

```bash
git add package.json tsconfig.json resources/icon.svg src/extension.ts
git commit -m "chore: 확장 뼈대와 빈 패널 추가"
```

---

## Task 2: sessionLocator — 활성 세션 파일 찾기

**Files:**
- Create: `src/sessionLocator.ts`
- Test: `test/sessionLocator.test.ts`

**Interfaces:**
- Consumes: 없음(독립 모듈).
- Produces: `findActiveSessionFile(projectsRoot: string, workspaceCwd: string): string | null` — Task 8에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findActiveSessionFile } from '../src/sessionLocator';

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-'));
  return root;
}

test('cwd가 일치하는 파일이 없으면 null', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ cwd: '/other/path' }) + '\n');
  assert.equal(findActiveSessionFile(root, '/my/workspace'), null);
});

test('여러 후보 중 cwd가 일치하면서 mtime이 가장 최근인 파일을 고른다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  const older = path.join(dir, 'older.jsonl');
  const newer = path.join(dir, 'newer.jsonl');
  fs.writeFileSync(older, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  fs.writeFileSync(newer, JSON.stringify({ cwd: '/my/workspace' }) + '\n');
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(newer, new Date(now), new Date(now));
  assert.equal(findActiveSessionFile(root, '/my/workspace'), newer);
});

test('첫 줄이 깨진 JSON인 파일은 무시하고 크래시하지 않는다', () => {
  const root = makeFixture();
  const dir = path.join(root, 'ws1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{not json');
  assert.equal(findActiveSessionFile(root, '/my/workspace'), null);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:\Users\user\claude-thinking-ko && npx tsc -p . && node --test out/test/sessionLocator.test.js`
Expected: FAIL (`findActiveSessionFile` not defined / 모듈 없음)

- [ ] **Step 3: `findActiveSessionFile` 구현**

`projectsRoot` 바로 아래 모든 하위 폴더를 뒤져 `*.jsonl` 파일을 모은다. 각 파일은 첫 줄만 읽어(전체를 읽지 않음 — 세션 파일이 수십 MB까지 자람) `JSON.parse`를 시도하고, 성공하고 `cwd`가 `workspaceCwd`와 정확히 같은 파일만 후보로 남긴다. 후보 중 `fs.statSync(file).mtimeMs`가 가장 큰 파일 경로를 반환, 후보가 없으면 `null`. 첫 줄 파싱 실패는 그냥 그 파일을 건너뛴다(throw 금지).

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test out/test/sessionLocator.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/sessionLocator.ts test/sessionLocator.test.ts
git commit -m "feat: 워크스페이스에 맞는 활성 세션 파일 찾기"
```

---

## Task 3: jsonlTailer — 바이트 오프셋 기반 증분 읽기

**Files:**
- Create: `src/jsonlTailer.ts`
- Test: `test/jsonlTailer.test.ts`

**Interfaces:**
- Consumes: 없음(독립 모듈).
- Produces: `tailOnce(filePath: string, fromOffset: number): { records: unknown[]; nextOffset: number }` — Task 8에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { tailOnce } from '../src/jsonlTailer';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-tail-'));
  return path.join(dir, 'session.jsonl');
}

test('완성된 줄 2개를 한 번에 읽고 offset이 그만큼 전진한다', () => {
  const file = tmpFile();
  const line1 = JSON.stringify({ n: 1, ko: '한글테스트' }) + '\n';
  const line2 = JSON.stringify({ n: 2 }) + '\n';
  fs.writeFileSync(file, line1 + line2);
  const result = tailOnce(file, 0);
  assert.deepEqual(result.records, [{ n: 1, ko: '한글테스트' }, { n: 2 }]);
  assert.equal(result.nextOffset, Buffer.byteLength(line1 + line2));
});

test('마지막 줄이 미완성이면 레코드로 넘기지 않고 offset도 전진하지 않는다', () => {
  const file = tmpFile();
  const complete = JSON.stringify({ n: 1 }) + '\n';
  const partial = '{"n": 2, "text": "아직 안 끝난';
  fs.writeFileSync(file, complete + partial);
  const result = tailOnce(file, 0);
  assert.deepEqual(result.records, [{ n: 1 }]);
  assert.equal(result.nextOffset, Buffer.byteLength(complete));
});

test('이전 호출의 nextOffset부터 이어 읽으면 미완성 줄이 완성된 뒤 파싱된다', () => {
  const file = tmpFile();
  const complete = JSON.stringify({ n: 1 }) + '\n';
  fs.writeFileSync(file, complete + '{"n": 2');
  const first = tailOnce(file, 0);
  fs.appendFileSync(file, ', "ko": "완성됨"}\n');
  const second = tailOnce(file, first.nextOffset);
  assert.deepEqual(second.records, [{ n: 2, ko: '완성됨' }]);
});

test('파일이 이전 offset보다 작아지면(교체됨) 0부터 다시 읽는다', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ n: 'old-long-record' }) + '\n');
  const stale = Buffer.byteLength(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ n: 1 }) + '\n');
  const result = tailOnce(file, stale);
  assert.deepEqual(result.records, [{ n: 1 }]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsc -p . && node --test out/test/jsonlTailer.test.js`
Expected: FAIL

- [ ] **Step 3: `tailOnce` 구현**

바이트 단위로만 다룬다(한글이 섞인 UTF-8 텍스트는 문자 길이와 바이트 길이가 다르므로 문자열 길이로 오프셋을 계산하면 깨진다). `fs.statSync(filePath).size`가 `fromOffset`보다 작으면 `fromOffset = 0`으로 되돌린다. `fs.openSync` + `fs.readSync`로 `[fromOffset, size)` 구간을 `Buffer`로 읽는다. 그 Buffer에서 마지막 `0x0A`(`\n`) 바이트의 인덱스를 `Buffer.prototype.indexOf(10)`로 뒤에서부터 찾는다(없으면 레코드 없이 `nextOffset: fromOffset` 반환). 그 인덱스까지(포함)를 `toString('utf8')`로 디코드해 `\n` 기준으로 나누고 빈 줄을 걸러 각각 `JSON.parse` — 성공한 것만 `records`에 담고 실패한 개별 줄은 건너뛴다(크래시 금지). `nextOffset = fromOffset + (마지막 \n 인덱스 + 1)`.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test out/test/jsonlTailer.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/jsonlTailer.ts test/jsonlTailer.test.ts
git commit -m "feat: 세션 jsonl 바이트 오프셋 증분 읽기"
```

---

## Task 4: thinkingFilter — 번역 대상 추출 및 판별

**Files:**
- Create: `src/thinkingFilter.ts`
- Test: `test/thinkingFilter.test.ts`

**Interfaces:**
- Consumes: `tailOnce`의 `records: unknown[]` 원소 하나하나(타입은 `Record<string, unknown>`로 취급).
- Produces: `isSkippableRecord(record): boolean`, `extractThinkingText(record): string | null`, `needsTranslation(text: string): boolean` — Task 8에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSkippableRecord, extractThinkingText, needsTranslation } from '../src/thinkingFilter';

test('거부/오류 레코드는 건너뛴다', () => {
  assert.equal(isSkippableRecord({ isApiErrorMessage: true }), true);
  assert.equal(isSkippableRecord({ apiRefusalCategory: 'safety' }), true);
  assert.equal(isSkippableRecord({ refusedMessageId: 'abc' }), true);
  assert.equal(isSkippableRecord({}), false);
});

test('thinkingDisplay가 있으면 그 텍스트를 쓴다', () => {
  const record = { thinkingDisplay: 'Planning the approach' };
  assert.equal(extractThinkingText(record), 'Planning the approach');
});

test('thinkingDisplay가 없으면 content[].type==="thinking"에서 찾는다', () => {
  const record = {
    message: { content: [{ type: 'text', text: '본문' }, { type: 'thinking', thinking: 'reasoning text here' }] }
  };
  assert.equal(extractThinkingText(record), 'reasoning text here');
});

test('사고 블록이 전혀 없으면 null', () => {
  assert.equal(extractThinkingText({ message: { content: [{ type: 'text', text: '본문' }] } }), null);
});

test('거부 레코드는 사고 블록이 있어도 null', () => {
  const record = { isApiErrorMessage: true, thinkingDisplay: 'ignored' };
  assert.equal(extractThinkingText(record), null);
});

test('순수 한국어 문장은 번역 불필요', () => {
  assert.equal(needsTranslation('이것은 완전한 한국어 문장입니다 설계를 검토하겠습니다'), false);
});

test('영문 식별자 하나 섞인 한국어 문장은 번역 불필요', () => {
  assert.equal(needsTranslation('useEffect 의존성 배열에 누락된 값이 있다 그래서 고쳐야 한다'), false);
});

test('영어 위주 문단은 번역 필요', () => {
  assert.equal(needsTranslation('I am planning the approach for this component and will write the tests first before implementation'), true);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsc -p . && node --test out/test/thinkingFilter.test.js`
Expected: FAIL

- [ ] **Step 3: 구현**

`isSkippableRecord(record)`: `record.isApiErrorMessage === true || !!record.apiRefusalCategory || !!record.refusedMessageId` 중 하나라도 참이면 `true`.

`extractThinkingText(record)`: `isSkippableRecord(record)`면 `null`. 아니면 `record.thinkingDisplay`가 비어있지 않은 문자열이면 그 값을 반환. 없으면 `record.message?.content`(배열)에서 `type === 'thinking'`인 첫 원소를 찾아 그 `thinking` 필드(문자열)를 반환, 없으면 `null`.
> 주의: `content[].type==='thinking'` 블록의 실제 텍스트 필드 이름(`thinking`으로 가정)은 설계 문서에서 실측 확인을 보류한 값이다. 구현 중 확장을 직접 실행해 패널에 뜨는 내용이 화면 미리보기와 맞는지 눈으로 확인하고, 다르면 이 필드 이름만 고친다(테스트는 그대로 통과함 — 테스트는 이 함수가 "지정한 필드를 뽑아온다"는 동작을 고정값 fixture로 검증하는 것이지, 실제 필드 이름이 맞다는 것까지 보장하지 않는다).

`needsTranslation(text)`:
```typescript
export function needsTranslation(text: string): boolean {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (latin < 20) return false;
  return hangul / (hangul + latin) < 0.3;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test out/test/thinkingFilter.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/thinkingFilter.ts test/thinkingFilter.test.ts
git commit -m "feat: 사고 블록 추출과 번역 필요 여부 판별"
```

---

## Task 5: translationQueue — 순차 처리 FIFO 큐

**Files:**
- Create: `src/translationQueue.ts`
- Test: `test/translationQueue.test.ts`

**Interfaces:**
- Consumes: 없음(독립 모듈, `translate` 함수를 주입받음).
- Produces: `class TranslationQueue { constructor(translate: (text: string) => Promise<string>, onResult: (input: string, result: { ok: true; text: string } | { ok: false; error: string }) => void); enqueue(text: string): void }` — Task 8에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationQueue } from '../src/translationQueue';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('동시에 두 건이 겹치지 않고 순서대로 처리된다', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const order: string[] = [];
  const q = new TranslationQueue(
    async (text) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(20, null);
      running--;
      order.push(text);
      return `번역:${text}`;
    },
    () => {}
  );
  q.enqueue('a');
  q.enqueue('b');
  q.enqueue('c');
  await delay(100, null);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxConcurrent, 1);
});

test('번역 실패해도 큐가 멈추지 않고 다음 항목을 처리한다', async () => {
  const results: Array<{ input: string; ok: boolean }> = [];
  const q = new TranslationQueue(
    async (text) => {
      if (text === 'fail') throw new Error('agy 실패');
      return `번역:${text}`;
    },
    (input, result) => results.push({ input, ok: result.ok })
  );
  q.enqueue('fail');
  q.enqueue('ok-after');
  await delay(50, null);
  assert.deepEqual(results, [
    { input: 'fail', ok: false },
    { input: 'ok-after', ok: true }
  ]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsc -p . && node --test out/test/translationQueue.test.js`
Expected: FAIL

- [ ] **Step 3: `TranslationQueue` 구현**

내부에 배열 큐와 `processing` 불리언 플래그를 둔다. `enqueue(text)`는 배열에 넣고 `processing`이 `false`면 드레인 루프를 시작한다. 드레인 루프: `processing = true`로 설정, 큐에서 하나씩 꺼내 `await translate(text)` — 성공하면 `onResult(text, { ok: true, text: result })`, 실패(reject)하면 `onResult(text, { ok: false, error: String(e) })`하고 계속 다음 항목으로 진행. 큐가 비면 `processing = false`.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test out/test/translationQueue.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/translationQueue.ts test/translationQueue.test.ts
git commit -m "feat: 번역 요청 순차 처리 큐"
```

---

## Task 6: agyTranslator — agy CLI 호출 (명령 생성과 실행 분리)

**Files:**
- Create: `src/agyTranslator.ts`
- Test: `test/agyTranslator.test.ts`

**Interfaces:**
- Consumes: 없음(독립 모듈).
- Produces: `writeAndRunAgy(text: string, options: { tempDir: string; commandBuilder?: (tempFilePath: string) => string }): Promise<string>` — Task 8에서 `TranslationQueue`의 `translate` 함수로 소비.

- [ ] **Step 1: `agy --help`로 실제 비대화형 호출 문법 확인 (코드 작성 전 필수)**

Run: `agy --help`
확인할 것: 한 줄 지시를 비대화형으로 실행하는 플래그(예: `-p`), 모델 지정 플래그, 승인 프롬프트를 건너뛰는 플래그(예: `--dangerously-skip-permissions`), 표준입력을 프롬프트에 포함시키는 방법. 확인한 정확한 플래그로 Step 3의 기본 명령 템플릿을 채운다(추측 금지 — 이 설계 문서 자체가 추측 금지를 원칙으로 한다).

- [ ] **Step 2: 실패하는 테스트 작성 (실제 agy 바이너리 없이도 돈다 — commandBuilder를 교체해서 파이프 경로만 검증)**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeAndRunAgy } from '../src/agyTranslator';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-agy-'));
}

test('원문을 임시 파일에 써서 표준입력으로 흘려보내고, 명령 문자열에는 원문이 직접 노출되지 않는다', async () => {
  const dir = tmpDir();
  const text = '이것은 한글과 English가 섞인 텍스트입니다';
  let capturedCommand = '';
  const echoBuilder = (tempFilePath: string) => {
    const cmd = `cmd /c type "${tempFilePath}"`;
    capturedCommand = cmd;
    return cmd; // 실제 agy 대신 파일 내용을 그대로 돌려주는 echo 역할
  };
  const result = await writeAndRunAgy(text, { tempDir: dir, commandBuilder: echoBuilder });
  assert.equal(result.trim(), text);
  assert.ok(!capturedCommand.includes(text), '명령 문자열에 원문이 그대로 박히면 안 된다');
});

test('실행 후 임시 파일을 정리한다', async () => {
  const dir = tmpDir();
  const echoBuilder = (tempFilePath: string) => `cmd /c type "${tempFilePath}"`;
  await writeAndRunAgy('임시 파일 정리 확인', { tempDir: dir, commandBuilder: echoBuilder });
  assert.deepEqual(fs.readdirSync(dir), []);
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx tsc -p . && node --test out/test/agyTranslator.test.js`
Expected: FAIL

- [ ] **Step 4: 구현**

`writeAndRunAgy(text, options)`: `crypto.randomUUID()`(내장 `node:crypto`)로 임시 파일명을 만들어 `options.tempDir`에 UTF-8로 `text`를 쓴다. `options.commandBuilder`가 있으면 그걸로, 없으면 기본 템플릿(Step 1에서 확인한 실제 `agy` 플래그로 채운 `cmd /c type "<임시파일>" | agy -p "다음 텍스트를 자연스러운 한국어로 번역해줘. 번역문만 출력하고 다른 말은 덧붙이지 마." <확인한 플래그들>`)으로 명령 문자열을 만든다. `child_process.exec`(Node 내장, Promise화해서 사용)로 실행하고 stdout을 받는다. `finally` 블록에서 임시 파일을 `fs.unlinkSync`로 지운다(실행이 실패해도 정리됨). stdout을 반환(앞뒤 공백 trim은 호출부가 아니라 여기서 해도 되고 테스트는 `result.trim()`으로 비교하므로 둘 다 통과 — trim 위치는 구현자 재량).

- [ ] **Step 5: 테스트 통과 확인**

Run: `node --test out/test/agyTranslator.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/agyTranslator.ts test/agyTranslator.test.ts
git commit -m "feat: agy CLI 호출 (임시 파일 경유 표준입력)"
```

---

## Task 7: thinkingPanel — Webview 로그 패널

**Files:**
- Create: `src/panel/thinkingPanel.ts`
- Modify: `src/extension.ts` (Task 1의 `PlaceholderPanel`을 `ThinkingPanel`로 교체)

**Interfaces:**
- Consumes: 없음(독립 클래스, 외부에서 `appendEntry`를 호출).
- Produces: `class ThinkingPanel implements vscode.WebviewViewProvider { appendEntry(original: string, translated: string): void; appendError(message: string): void }` — Task 8에서 `TranslationQueue`의 `onResult` 콜백 안에서 소비.

- [ ] **Step 1: `src/panel/thinkingPanel.ts` 작성**

```typescript
import * as vscode from 'vscode';

export class ThinkingPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private entriesHtml = '';

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    this.render();
  }

  appendEntry(original: string, translated: string): void {
    this.entriesHtml += `<div class="entry"><div class="ko">${escapeHtml(translated)}</div><div class="en">${escapeHtml(original)}</div></div>`;
    this.render();
  }

  appendError(message: string): void {
    this.entriesHtml += `<div class="entry error">${escapeHtml(message)}</div>`;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = `<body>${this.entriesHtml || '대기 중'}</body>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

본문 내용은 설계 문서대로 "원문 영어 일부 + 번역된 한국어"를 로그처럼 아래로 쌓는다. 새 항목은 `entriesHtml` 뒤에 이어붙인다(= 아래로 흐름). 패딩·색 등 세부 스타일은 구현자 재량.

- [ ] **Step 2: `src/extension.ts`에서 `PlaceholderPanel`을 `ThinkingPanel`로 교체**

`registerWebviewViewProvider('claudeThinkingKo.panel', new PlaceholderPanel())`를 `new ThinkingPanel()` 인스턴스로 바꾼다. 이 인스턴스는 Task 8에서 큐의 콜백에 연결해야 하므로 `activate()` 함수 스코프의 지역 변수로 보관해둔다(아직 연결은 안 함, Task 8에서 연결).

- [ ] **Step 3: 컴파일 확인**

Run: `npx tsc -p .`
Expected: 에러 없음.

- [ ] **Step 4: (수동) Extension Development Host에서 패널에 "대기 중" 문구 그대로 뜨는지 확인**

F5로 실행, 사이드바 아이콘 클릭.
Expected: "대기 중" 표시(아직 번역 데이터 연결 전이므로 Task 1과 동일하게 보여야 정상).

- [ ] **Step 5: 커밋**

```bash
git add src/panel/thinkingPanel.ts src/extension.ts
git commit -m "feat: 번역 로그를 쌓아 보여주는 webview 패널"
```

---

## Task 8: 전체 배선 — extension.ts에서 모든 모듈 연결

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: Task 2~7의 모든 produces (`findActiveSessionFile`, `tailOnce`, `isSkippableRecord`/`extractThinkingText`/`needsTranslation`, `TranslationQueue`, `writeAndRunAgy`, `ThinkingPanel`).
- Produces: 없음(최상위 조립 지점, 더 이상 소비하는 태스크 없음).

- [ ] **Step 1: 배선 작성**

`activate(context)` 안에서:
1. `ThinkingPanel` 인스턴스를 만들어 `registerWebviewViewProvider`에 등록(Task 7에서 이미 함).
2. `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`로 현재 워크스페이스 경로를 얻는다. 없으면 아무것도 하지 않고 리턴.
3. `path.join(os.homedir(), '.claude', 'projects')`를 `projectsRoot`로 `findActiveSessionFile(projectsRoot, workspaceCwd)` 호출. `null`이면(아직 세션 없음) 1회성 `fs.watch`로 `projectsRoot` 자체를 지켜보다가 새 매칭 파일이 생기면 그때 시작 — 단, 이 폴백은 비목표 수준으로 단순하게: v1은 주기적으로(예: 10초마다 `setInterval`) 재탐색만 해도 충분하다(초마다 agy를 부르는 게 금지 대상이지, 세션 파일 유무를 몇 초마다 `stat`하는 건 금지 대상이 아니다 — 설계 문서의 "초 단위 폴링 금지"는 번역 CLI 호출에 대한 제약이다).
4. 세션 파일을 찾으면, `fs.statSync(file).size`를 "활성화 시점 오프셋"으로 삼아 `tailOnce`를 그 오프셋부터 시작한다(과거분 건너뜀 — Global Constraints 참조).
5. `fs.watch(file, ...)` 콜백에서 `tailOnce(file, currentOffset)` 호출, 반환된 `records` 각각에 대해 `extractThinkingText` → `null`이면 무시, 아니면 `needsTranslation`으로 걸러 `true`일 때만 `TranslationQueue.enqueue(text)`. `nextOffset`을 `currentOffset`에 반영.
6. `writeAndRunAgy`는 `(text, options)` 두 인자를 받지만 `TranslationQueue`가 주입받는 `translate`는 `(text: string) => Promise<string>` 한 인자이므로, 그대로 넘기지 말고 `const translate = (text: string) => writeAndRunAgy(text, { tempDir: context.globalStorageUri.fsPath })` 같은 클로저로 감싸서 `TranslationQueue` 생성자에 넘긴다. `onResult` 콜백에서 성공이면 `panel.appendEntry(original, result.text)`, 실패면 `panel.appendError(result.error)`.
7. `claudeThinkingKo.togglePause` 커맨드(Task 1의 스텁을 교체): `fs.watch` 리스너를 떼거나 다시 붙이는 불리언 플래그로 일시정지/재개 구현.

- [ ] **Step 2: 컴파일 확인**

Run: `npx tsc -p .`
Expected: 에러 없음.

- [ ] **Step 3: (수동) 전체 동작 확인 — 설계 문서의 "읽기 주의"에 따라 이 확인은 사람이 직접 눈으로 한다**

이 저장소(`E:\Hermes_Obsidian`)를 워크스페이스로 열고(이미 진행 중인 Claude Code 세션이 있는 폴더) F5로 확장 실행. 새 창에서 Claude Code에게 영어가 섞인 사고를 유도할 만한 질문을 하나 던져보고, 패널에 번역된 한국어 항목이 쌓이는지 확인. `claudeThinkingKo.togglePause` 명령으로 멈췄다 다시 켜지는지도 확인.
Expected: 패널에 "한국어 번역 / 원문 일부" 쌍이 쌓인다. 일시정지 중에는 새 항목이 안 쌓인다.

- [ ] **Step 4: 전체 테스트 스위트 재확인**

Run: `npm test`
Expected: Task 2~6의 모든 단위 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/extension.ts
git commit -m "feat: 세션 감시부터 패널 표시까지 전체 배선 연결"
```
