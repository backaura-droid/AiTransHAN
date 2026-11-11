// 한 번이라도 활성 탭이었던 세션 파일들을 동시에 감시하는 감시자 묶음 — 감시자 수명만 책임지고,
// 오프셋·읽기(tailOnce)는 호출하는 쪽(extension.ts)이 맡는다. vscode에 의존하지 않아 단위 테스트가 된다.
// 2026-11-10: 비활성 탭에서도 번역이 계속 쌓이게 하려고 "지금 탭 1개만 감시"에서 전환했다.
import * as fs from 'node:fs';

export interface SessionWatcherPoolOptions {
  maxSessions?: number; // 기본 10 (SessionCache 상한과 맞춤)
  onChange: (filePath: string) => void;
  /** 상한 초과로 감시자를 끊을 때(퇴출) 호출된다 — 호출하는 쪽이 같은 파일의 다른 캐시도 같이
   *  정리할 수 있게(예: SessionCache) 한다. 퇴출 기준(최근 활성 순서)이 이 클래스의 정본이다. */
  onEvicted?: (filePath: string) => void;
  watchImpl?: (filePath: string, listener: () => void) => { close(): void };
}

function defaultWatch(filePath: string, listener: () => void): { close(): void } {
  const w = fs.watch(filePath, listener);
  // 파일이 지워지면 조용히 닫는다(풀 항목은 남지만 지워진 세션이라 더 읽을 것도 없다) — 이전 단일 감시자 때와 같은 처리
  w.on('error', () => w.close());
  return w;
}

export class SessionWatcherPool {
  // 값 = 마지막으로 활성화된 순번(단조 증가 카운터 — 같은 밀리초 동률을 피하려고 시각 대신 씀)
  private readonly entries = new Map<string, { watcher: { close(): void }; lastActive: number }>();
  private tick = 0;
  private readonly maxSessions: number;
  private readonly watchImpl: NonNullable<SessionWatcherPoolOptions['watchImpl']>;

  constructor(private readonly options: SessionWatcherPoolOptions) {
    this.maxSessions = options.maxSessions ?? 10;
    this.watchImpl = options.watchImpl ?? defaultWatch;
  }

  /**
   * 처음 보는 파일이면 감시자를 열고, 이미 감시 중이면 활성 순번만 갱신한다.
   * 상한 초과 시 방금 연 파일을 뺀 나머지 중 가장 오래전에 활성화된 것 하나를 끊는다.
   * 호출하는 쪽은 지금 활성 탭의 파일에 대해서만 부르므로, 직전 활성 파일은 항상 순번이
   * 가장 높아 퇴출되지 않는다(상한 1일 때만 예외 — 그땐 새 파일이 곧 활성 파일이다).
   */
  ensureWatching(filePath: string): void {
    const existing = this.entries.get(filePath);
    if (existing) {
      existing.lastActive = ++this.tick;
      return;
    }
    let watcher: { close(): void };
    try {
      watcher = this.watchImpl(filePath, () => this.options.onChange(filePath));
    } catch {
      return; // 파일이 사라진 경우 — 다음 재탐색이 다시 시도한다
    }
    this.entries.set(filePath, { watcher, lastActive: ++this.tick });
    if (this.entries.size > this.maxSessions) {
      let oldest: string | undefined;
      let oldestTick = Infinity;
      for (const [file, entry] of this.entries) {
        if (file !== filePath && entry.lastActive < oldestTick) {
          oldest = file;
          oldestTick = entry.lastActive;
        }
      }
      if (oldest !== undefined) {
        this.entries.get(oldest)!.watcher.close();
        this.entries.delete(oldest);
        this.options.onEvicted?.(oldest);
      }
    }
  }

  markActive(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry) entry.lastActive = ++this.tick;
  }

  isWatching(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.watcher.close();
    this.entries.clear();
  }
}
