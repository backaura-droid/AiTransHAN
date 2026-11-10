// 설정값(auto/agy/geminiApiKey)과 "agy가 PATH에 있는가"로부터 실제 쓸 번역 공급자를 고른다.
// agy는 이 확장 개발자의 로컬 구독 CLI 전제라, 배포 후 다른 사용자 환경에는 없을 수 있다.
import { spawn } from 'node:child_process';
import type { SpawnFn } from './agyTranslator';

export type ProviderSetting = 'auto' | 'agy' | 'apiKey';
export type Provider = 'agy' | 'apiKey';

export function pickProvider(setting: ProviderSetting, agyAvailable: boolean): Provider {
  if (setting === 'agy') return 'agy';
  if (setting === 'apiKey') return 'apiKey';
  return agyAvailable ? 'agy' : 'apiKey';
}

const PROBE_TIMEOUT_MS = 5000;

export function probeAgyAvailable(spawnImpl: SpawnFn = (c, a, o) => spawn(c, a, o)): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl('agy', ['--version'], {});
    } catch {
      finish(false);
      return;
    }
    child.on('error', () => finish(false)); // ENOENT 등 — agy 미설치
    child.on('exit', (code) => finish(code === 0));
    setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
  });
}
