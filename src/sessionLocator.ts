// 현재 VSCode 워크스페이스에 대응하는 Claude Code 활성 세션 jsonl 파일을 찾고,
// 다음에 어떤 파일을 감시해야 할지 결정한다
import * as fs from 'node:fs';
import * as path from 'node:path';

// 리뷰 C1: 실제 세션 파일 124개 중 0개가 cwd를 첫 줄에 두고 있었다(line 3~4가 보통).
// 앞쪽 일부(최대 1MB)를 줄 단위로 훑어 cwd가 있는 첫 레코드를 찾는다.
const SCAN_BYTES = 1024 * 1024;

function findCwdInHead(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, SCAN_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof record === 'object' &&
        record !== null &&
        typeof (record as Record<string, unknown>).cwd === 'string'
      ) {
        return (record as Record<string, unknown>).cwd as string;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
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

  let best: { file: string; mtimeMs: number } | null = null;

  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsRoot, entry.name);
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, fileName);

      const cwd = findCwdInHead(filePath);
      if (cwd === null || !sameCwd(cwd, workspaceCwd)) continue;

      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) {
        best = { file: filePath, mtimeMs };
      }
    }
  }

  return best ? best.file : null;
}

export interface WatchDecision {
  file: string;
  /** true면 파일을 처음부터 본다(활성화 중 새로 생긴 대화) — false면 끝부터만 본다(과거분 스킵) */
  startFromBeginning: boolean;
}

// 리뷰 C3: 세션 파일을 한 번 찾으면 영구히 고정돼 새 대화를 못 따라갔다.
// 매 재탐색마다 이 함수로 "바뀌었는지, 바뀌었다면 어디서부터 볼지"를 판단한다.
export function decideNextWatch(
  foundFile: string | null,
  currentlyWatching: string | null
): WatchDecision | null {
  if (!foundFile) return null;
  if (foundFile === currentlyWatching) return null;
  return { file: foundFile, startFromBeginning: currentlyWatching !== null };
}
