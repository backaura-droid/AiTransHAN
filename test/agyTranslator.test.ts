// agyTranslator가 전용 에이전트 프로필을 만들고, 본문을 stdin으로 넘기고,
// 타임아웃 시 실제로 종료하는지 검증하는 테스트 (실제 agy 바이너리 없이도 돈다 —
// spawnImpl을 node 자체로 치환해서 stdin/stdout/종료 메커니즘만 실제로 검증한다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  writeAndRunAgy,
  ensureTranslatorAgent,
  extractResultResponse,
  type SpawnFn
} from '../src/agyTranslator';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-agy-'));
}

const ECHO_SCRIPT = `
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const parsed = JSON.parse(data.trim());
  const content = parsed.message.content;
  process.stdout.write(JSON.stringify({ event: 'noise' }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { response: 'ECHO:' + content } }) + '\\n');
});
`;

function echoSpawn(capturedArgs: string[][]): SpawnFn {
  return (_command, args, options) => {
    capturedArgs.push(args);
    return spawn(process.execPath, ['-e', ECHO_SCRIPT], options);
  };
}

test('에이전트 프로필 파일을 만들고, 프롬프트를 바꾸면 항상 최신으로 덮어쓴다', () => {
  // 2026-11-10: "한 번만 쓰기"였다가 바꿨다 — 전에 떠 있던 확장이 이미 구버전 프로필 파일을
  // 만들어뒀으면, 소스에서 프롬프트(말투 지침 등)를 고쳐도 영원히 옛날 파일이 남아 반영이 안 됐다.
  const dir = tmpDir();
  const agentPath = path.join(dir, '.agents', 'agents', 'translator.md');
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.writeFileSync(agentPath, 'OLD-STALE-CONTENT', 'utf8');

  ensureTranslatorAgent(dir);

  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(!content.includes('OLD-STALE-CONTENT'), '옛 파일을 항상 최신 내용으로 덮어써야 한다');
  assert.ok(content.includes('tools: []'));
  assert.ok(content.includes('inheritMcp: false'));
  assert.ok(content.includes('excludeDefaultComponents: true'));
});

// 2026-11-10: 애교체가 핵심 파악을 방해한다는 피드백으로 "정중·간결·핵심 누락 없이"로 교체했다.
test('번역 프롬프트에 존댓말·간결 지침이 포함되고 애교체 지침은 없다', () => {
  const dir = tmpDir();
  ensureTranslatorAgent(dir);
  const content = fs.readFileSync(path.join(dir, '.agents', 'agents', 'translator.md'), 'utf8');
  assert.ok(content.includes('존댓말'));
  assert.ok(content.includes('간결'));
  assert.ok(!content.includes('애교체를'), '애교체를 쓰라는 지침이 남아있으면 안 된다');
  assert.ok(!content.includes('윤주'));
});

test('본문은 stdin으로 전달되고, agy 호출 인자에는 원문이 직접 노출되지 않는다', async () => {
  const dir = tmpDir();
  const text = '이것은 한글과 English가 섞인 텍스트입니다';
  const capturedArgs: string[][] = [];
  const result = await writeAndRunAgy(text, { tempDir: dir, spawnImpl: echoSpawn(capturedArgs) });
  assert.ok(result.includes(text), 'stdin으로 넘긴 본문이 결과에 반영돼야 한다');
  assert.equal(capturedArgs.length, 1);
  assert.ok(
    !capturedArgs[0].some((a) => a.includes(text)),
    '호출 인자 배열에 원문이 그대로 들어가면 안 된다'
  );
});

test('타임아웃되면 거부되고, 설정한 시간 안에 끝난다', async () => {
  const dir = tmpDir();
  const hangingSpawn: SpawnFn = (_command, _args, options) =>
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], options);

  const start = Date.now();
  await assert.rejects(
    writeAndRunAgy('아무 텍스트', { tempDir: dir, spawnImpl: hangingSpawn, timeoutMs: 300 })
  );
  assert.ok(Date.now() - start < 5000, '타임아웃 설정값 근처에서 끝나야 한다(10초를 다 기다리면 안 됨)');
});

test('extractResultResponse: 다른 이벤트 사이에서 result.response를 찾는다', () => {
  const stdout = [
    JSON.stringify({ event: 'init' }),
    JSON.stringify({ event: 'step_update' }),
    JSON.stringify({ event: 'result', result: { response: '번역 결과' } })
  ].join('\n');
  assert.equal(extractResultResponse(stdout), '번역 결과');
});

test('extractResultResponse: result 이벤트가 없으면 에러를 던진다', () => {
  assert.throws(() => extractResultResponse(JSON.stringify({ event: 'init' })));
});
