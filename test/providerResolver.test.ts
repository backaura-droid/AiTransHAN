// 설정값(auto/agy/apiKey)과 agy 설치 여부로부터 실제 쓸 번역 공급자를 고르는 순수 로직,
// 그리고 "agy가 PATH에 있는지"를 실제 agy 없이 가짜 프로세스로 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pickProvider, probeAgyAvailable } from '../src/providerResolver';
import type { SpawnFn } from '../src/agyTranslator';

test('설정이 agy면 agy available 값과 무관하게 항상 agy를 쓴다', () => {
  assert.equal(pickProvider('agy', true), 'agy');
  assert.equal(pickProvider('agy', false), 'agy');
});

test('설정이 apiKey면 agy available 값과 무관하게 항상 API 키 방식을 쓴다', () => {
  assert.equal(pickProvider('apiKey', true), 'apiKey');
  assert.equal(pickProvider('apiKey', false), 'apiKey');
});

test('설정이 auto면 agy 설치 여부를 따른다', () => {
  assert.equal(pickProvider('auto', true), 'agy');
  assert.equal(pickProvider('auto', false), 'apiKey');
});

test('probeAgyAvailable: 정상 종료(exit 0)면 true', async () => {
  const fakeSpawn: SpawnFn = (_cmd, _args, options) =>
    spawn(process.execPath, ['-e', 'process.exit(0)'], options);
  assert.equal(await probeAgyAvailable(fakeSpawn), true);
});

test('probeAgyAvailable: 실행 자체가 실패(ENOENT 등 error 이벤트)하면 false', async () => {
  const fakeSpawn: SpawnFn = () => {
    const { EventEmitter } = require('node:events');
    const fake = new EventEmitter() as any;
    setImmediate(() => fake.emit('error', new Error('ENOENT')));
    return fake;
  };
  assert.equal(await probeAgyAvailable(fakeSpawn), false);
});

test('probeAgyAvailable: 비정상 종료(exit 1)면 false', async () => {
  const fakeSpawn: SpawnFn = (_cmd, _args, options) =>
    spawn(process.execPath, ['-e', 'process.exit(1)'], options);
  assert.equal(await probeAgyAvailable(fakeSpawn), false);
});
