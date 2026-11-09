// jsonl 파일을 바이트 오프셋부터 증분으로 읽어 완성된 줄만 파싱한다 (문자 길이가 아닌 바이트 길이로 오프셋을 다룸)
import * as fs from 'node:fs';

export interface TailResult {
  records: unknown[];
  nextOffset: number;
}

export function tailOnce(filePath: string, fromOffset: number): TailResult {
  const size = fs.statSync(filePath).size;
  const startOffset = size < fromOffset ? 0 : fromOffset;

  if (size <= startOffset) {
    return { records: [], nextOffset: startOffset };
  }

  const length = size - startOffset;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, startOffset);
  } finally {
    fs.closeSync(fd);
  }

  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) {
    return { records: [], nextOffset: startOffset };
  }

  const completeText = buf.subarray(0, lastNl + 1).toString('utf8');
  const records: unknown[] = [];
  for (const line of completeText.split('\n')) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 개별 줄 파싱 실패는 건너뛴다(크래시 금지)
    }
  }

  return { records, nextOffset: startOffset + lastNl + 1 };
}
