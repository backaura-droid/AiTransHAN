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

export function findActiveSessionFile(projectsRoot: string, workspaceCwd: string): string | null {
  if (!fs.existsSync(projectsRoot)) return null;

  const candidates: Array<{ file: string; mtimeMs: number }> = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
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

  // 교차검증 최적화: mtimeMs 최신순으로 먼저 정렬해 가장 최근 파일부터 cwd를 확인한다.
  // 첫 매칭을 찾으면 즉시 반환하므로 과거 세션 수백 개를 매번 읽지 않는다.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const cwd = findCwdInHead(candidate.file);
    if (cwd !== null && sameCwd(cwd, workspaceCwd)) {
      return candidate.file;
    }
  }

  return null;
}

export interface WatchDecision {
  file: string;
  /** true면 파일을 처음부터 본다(활성화 중 새로 생긴 대화) — false면 끝부터만 본다(과거분 스킵) */
  startFromBeginning: boolean;
}

// 리뷰 C3 + 교차검증 보강:
// 매 재탐색마다 이 함수로 "바뀌었는지, 바뀌었다면 어디서부터 볼지"를 판단한다.
// hasInitialized가 true면(감시 중 에러로 currentlyWatching이 잠시 null이 된 뒤 복구되는 경우 포함) 처음부터 읽는다.
export function decideNextWatch(
  foundFile: string | null,
  currentlyWatching: string | null,
  hasInitialized: boolean = currentlyWatching !== null
): WatchDecision | null {
  if (!foundFile) return null;
  if (foundFile === currentlyWatching) return null;
  return { file: foundFile, startFromBeginning: hasInitialized };
}
