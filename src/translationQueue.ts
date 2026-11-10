// 번역 요청을 한 번에 하나씩 순서대로 처리하는 FIFO 큐(활성 탭 항목은 앞당겨 처리)
// 2026-11-10: 항목마다 세션 파일 경로를 함께 실어, 번역이 끝났을 때 이미 탭이 바뀌었어도
// 결과가 원래 세션으로 돌아가게 한다(탭 간 오염 방지).
export type TranslateFn = (text: string) => Promise<string>;
export type TranslationResult = { ok: true; text: string } | { ok: false; error: string };
export type OnResultFn = (filePath: string, input: string, result: TranslationResult) => void;
/** 큐가 비어있다가 처리를 시작하면 true, 끝까지 비워지면 false — 한 번씩만 알림(항목마다 X) */
export type OnBusyChangeFn = (busy: boolean) => void;

export class TranslationQueue {
  private queue: Array<{ filePath: string; text: string }> = [];
  private processing = false;
  private activeFilePath: string | null = null;

  constructor(
    private readonly translate: TranslateFn,
    private readonly onResult: OnResultFn,
    private readonly onBusyChange?: OnBusyChangeFn
  ) {}

  enqueue(filePath: string, text: string): void {
    this.queue.push({ filePath, text });
    if (!this.processing) {
      void this.drain();
    }
  }

  /**
   * 지금 보고 있는 탭의 세션 파일 — 큐에 그 파일 항목이 있으면 먼저 처리한다(같은 파일끼리는 FIFO).
   * 진행 중인 번역은 끊지 않고, 다음 항목을 고를 때부터 반영된다. null이면 순수 FIFO.
   */
  setActiveFile(filePath: string | null): void {
    this.activeFilePath = filePath;
  }

  private async drain(): Promise<void> {
    this.processing = true;
    this.onBusyChange?.(true);
    while (this.queue.length > 0) {
      const activeIdx = this.queue.findIndex((item) => item.filePath === this.activeFilePath);
      const { filePath, text } = this.queue.splice(activeIdx === -1 ? 0 : activeIdx, 1)[0];
      try {
        const translated = await this.translate(text);
        this.onResult(filePath, text, { ok: true, text: translated });
      } catch (e) {
        this.onResult(filePath, text, { ok: false, error: String(e) });
      }
    }
    this.processing = false;
    this.onBusyChange?.(false);
  }
}
