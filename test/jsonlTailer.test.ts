// jsonlTailer의 바이트 오프셋 증분 읽기 동작을 검증하는 테스트
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
