// 현재 VSCode 워크스페이스에 대응하는 Claude Code 활성 세션 jsonl 파일을 찾고,
// 다음에 어떤 파일을 감시해야 할지 결정한다
import * as fs from 'node:fs';
import * as path from 'node:path';

// 리뷰 C1 + 교차검증 보강:
// 실제 세션 파일은 첫 줄(queue-operation)이 아닌 3~4번째 줄에 cwd를 두며,
// 첫 메시지에 이미지(base64)가 첨부되면 앞부분 줄이 1MB를 넘을 수 있다.
// 1MB 단위로 최대 8MB까지 스캔하되, 잘린 줄에서도 정규식 폴백으로 cwd를 추출한다.
const CHUNK_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const CWD_REGEX = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function extractCwdFromChunk(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (
        typeof record === 'object' &&
        record !== null &&
        typeof (record as Record<string, unknown>).cwd === 'string'
      ) {
        return (record as Record<string, unknown>).cwd as string;
      }
    } catch {
      // 청크 경계에서 잘린 대용량 줄이라도 "cwd":"..." 필드가 온전히 들어있으면 추출한다
      const match = CWD_REGEX.exec(line);
      if (match) {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          // 이스케이프 파싱 실패 시 무시
        }
      }
    }
  }
  return null;
}

function findCwdInHead(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const maxBytes = Math.min(size, MAX_SCAN_BYTES);
    let offset = 0;

    while (offset < maxBytes) {
      const length = Math.min(CHUNK_BYTES, maxBytes - offset);
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      if (bytesRead <= 0) break;

      const text = buf.subarray(0, bytesRead).toString('utf8');
      const cwd = extractCwdFromChunk(text);
      if (cwd !== null) {
        return cwd;
      }
      // 청크 경계에 "cwd" 문자열이 걸치는 경우를 방지하기 위해 256바이트 겹쳐서 다음 청크를 읽는다
      if (offset + bytesRead >= maxBytes) break;
      offset += Math.max(1, bytesRead - 256);
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 닫기 실패 무시
    }
  }
}

function sameCwd(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === 'win32') {
    return ra.toLowerCase() === rb.toLowerCase();
  }
  return ra === rb;
}

interface SessionFileInfo {
  file: string;
  mtimeMs: number;
}

function listJsonlCandidates(projectsRoot: string): SessionFileInfo[] {
  if (!fs.existsSync(projectsRoot)) return [];

  const candidates: SessionFileInfo[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsRoot, entry.name);
    let fileNames: string[];
    try {
      fileNames = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, fileName);
      try {
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        candidates.push({ file: filePath, mtimeMs });
      } catch {
        // 스캔 도중 삭제되거나 접근 불가한 파일은 건너뛴다
      }
    }
  }

  // mtimeMs 최신순으로 정렬해 가장 최근 파일부터 다룬다.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

// 2026-11-10: 같은 워크스페이스 폴더를 VSCode 창 여러 개로 열어두면(또는 한 창에 Claude 탭을
// 여러 개 열어두면) cwd+mtime만으로는 "지금 이 창에서 보고 있는 탭"을 구분할 수 없어, 서로 다른
// 창의 번역 패널이 똑같은 파일을 가리키는 사고가 났다. Claude Code는 대화 제목을 지어서 세션
// jsonl에 {"type":"ai-title","aiTitle":"..."} 레코드로 남기는데, 이 값이 VSCode 탭의 label과
// 그대로 같다(실측 확인). activeTabLabel을 넘기면 cwd가 일치하는 후보들 중 "최신 ai-title이
// 그 라벨과 같은 파일"을 우선 선택해, 창/탭마다 정확히 자기 세션을 찾게 한다.
const TAIL_FIRST_CHUNK_BYTES = 256 * 1024;
const TAIL_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const AI_TITLE_REGEX = /"type"\s*:\s*"ai-title"[^}]*"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function extractLastAiTitleFromChunk(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (
        typeof record === 'object' &&
        record !== null &&
        (record as Record<string, unknown>).type === 'ai-title' &&
        typeof (record as Record<string, unknown>).aiTitle === 'string'
      ) {
        found = (record as Record<string, unknown>).aiTitle as string;
      }
    } catch {
      // 청크 맨 앞에서 잘린 줄일 수 있다 — 같은 줄 안에 ai-title이 온전히 있으면 정규식으로 구제
      const match = AI_TITLE_REGEX.exec(line);
      if (match) {
        try {
          found = JSON.parse(`"${match[1]}"`) as string;
        } catch {
          // 이스케이프 파싱 실패 시 무시
        }
      }
    }
  }
  return found;
}

function findLatestAiTitle(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const maxBytes = Math.min(size, TAIL_MAX_SCAN_BYTES);
    let readBytes = Math.min(TAIL_FIRST_CHUNK_BYTES, maxBytes);

    while (readBytes <= maxBytes) {
      const start = size - readBytes;
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, start);
      const title = extractLastAiTitleFromChunk(buf.toString('utf8'));
      if (title !== null) return title;
      if (readBytes >= maxBytes) break;
      readBytes = Math.min(readBytes * 4, maxBytes);
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 닫기 실패 무시
    }
  }
}

// 2026-11-10 실사용 버그 수정(council argon + Opus 교차검증): "빈 새 탭을 열었더니 지금 가장 바쁜
// (mtime 최신) 다른 탭의 내용이 그대로 보인다"는 사고가 났다. 원인은 ai-title 매칭에 실패하면
// 무조건 mtime 최신 파일로 폴백했던 것 — 그 파일이 이미 다른 탭의 ai-title을 갖고 있어도 상관없이
// 집어왔다. 고친 규칙: ①이미 다른 ai-title이 박힌 파일은 폴백 후보에서 원천 제외(그 파일은 이미
// 주인이 있다) ②아직 ai-title이 없는(진짜 새 대화일 수 있는) 파일만, 그것도 최근에 생성/수정된
// 것만 폴백으로 허용(옛날에 중단된 제목 없는 파일이 잘못 잡히는 것도 방지).
const UNTITLED_FALLBACK_MAX_AGE_MS = 60_000;

export function findActiveSessionFile(
  projectsRoot: string,
  workspaceCwd: string,
  activeTabLabel?: string | null
): string | null {
  const matches: SessionFileInfo[] = [];
  for (const candidate of listJsonlCandidates(projectsRoot)) {
    const cwd = findCwdInHead(candidate.file);
    if (cwd !== null && sameCwd(cwd, workspaceCwd)) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) return null;

  // 호출자가 "지금 활성 Claude Code 탭이 없다"고 명시적으로 확인한 경우(null) — 엉뚱한 파일을
  // 보여주지 않는다. undefined(탭 라벨 정보 자체가 없는 호출)와는 다르게 취급한다.
  if (activeTabLabel === null) return null;
  if (activeTabLabel === undefined) {
    // 레거시 호출(라벨을 아예 안 넘김) — 기존처럼 최신 mtime으로 폴백.
    return matches[0].file;
  }

  let untitledFallback: string | null = null;
  for (const candidate of matches) {
    const title = findLatestAiTitle(candidate.file);
    if (title !== null) {
      if (title === activeTabLabel) return candidate.file;
      continue; // 이미 다른 탭의 제목이 박힌 파일 — 폴백 후보에서 제외
    }
    // matches는 mtime 내림차순이므로 여기서 처음 만나는 "제목 없음" 파일이 가장 최근 것이다.
    if (untitledFallback === null && Date.now() - candidate.mtimeMs < UNTITLED_FALLBACK_MAX_AGE_MS) {
      untitledFallback = candidate.file;
    }
  }
  return untitledFallback;
}

