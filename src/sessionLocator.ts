// 현재 VSCode 워크스페이스에 대응하는 Claude Code 활성 세션 jsonl 파일을 찾는다
import * as fs from 'node:fs';
import * as path from 'node:path';

function readFirstLine(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const chunk = buf.subarray(0, bytesRead);
    const nl = chunk.indexOf(0x0a);
    const line = nl === -1 ? chunk : chunk.subarray(0, nl);
    return line.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
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

      let record: unknown;
      try {
        record = JSON.parse(readFirstLine(filePath) ?? '');
      } catch {
        continue;
      }

      if (
        typeof record !== 'object' ||
        record === null ||
        (record as Record<string, unknown>).cwd !== workspaceCwd
      ) {
        continue;
      }

      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) {
        best = { file: filePath, mtimeMs };
      }
    }
  }

  return best ? best.file : null;
}
