// agyTranslator가 원문을 임시 파일로 써서 외부 명령에 넘기고, 끝나면 정리하는지 검증하는 테스트
// (실제 agy 바이너리 없이도 돈다 — commandBuilder를 교체해서 파일 경유 경로만 검증)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeAndRunAgy } from '../src/agyTranslator';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-agy-'));
}

test('원문을 임시 파일에 써서 전달하고, 명령 문자열에는 원문이 직접 노출되지 않는다', async () => {
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
