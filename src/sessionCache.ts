// 세션 파일별로 이미 번역해 보여준 내역(HTML 조각)을 보관해, 탭을 다시 돌아왔을 때 복원하게 하는 캐시
// 2026-11-10 council 결정: 상한 초과 시 가장 먼저 생긴 세션 1개만 삭제(LRU 불필요), 퇴출된 세션은
// 뒤늦게 끝난 번역으로 되살리지 않는다(appendIfPresent).
export class SessionCache {
  private readonly sessions = new Map<string, string[]>();

  constructor(
    private readonly maxSessions = 10,
    // 패널 MAX_ENTRIES와 같은 값 — 패널이 보여줄 수 있는 것보다 더 쌓을 이유가 없다
    private readonly maxEntriesPerSession = 200
  ) {}

  get(filePath: string): string[] | undefined {
    return this.sessions.get(filePath);
  }

  getOrCreate(filePath: string): string[] {
    let entries = this.sessions.get(filePath);
    if (!entries) {
      entries = [];
      this.sessions.set(filePath, entries);
      if (this.sessions.size > this.maxSessions) {
        this.sessions.delete(this.sessions.keys().next().value as string);
      }
    }
    return entries;
  }

  appendIfPresent(filePath: string, html: string): void {
    const entries = this.sessions.get(filePath);
    if (!entries) return;
    entries.push(html);
    if (entries.length > this.maxEntriesPerSession) {
      entries.splice(0, entries.length - this.maxEntriesPerSession);
    }
  }

  /** 사용자가 "전체 지우기"를 눌렀을 때 — 세션을 통째로 지워, 뒤늦게 끝난 번역이 되살리지 못하게 한다. */
  clear(filePath: string): void {
    this.sessions.delete(filePath);
  }
}
