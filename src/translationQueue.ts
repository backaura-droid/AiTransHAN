// 번역 요청을 한 번에 하나씩 순서대로 처리하는 FIFO 큐
export type TranslateFn = (text: string) => Promise<string>;
export type TranslationResult = { ok: true; text: string } | { ok: false; error: string };
export type OnResultFn = (input: string, result: TranslationResult) => void;

export class TranslationQueue {
  private queue: string[] = [];
  private processing = false;

  constructor(
    private readonly translate: TranslateFn,
    private readonly onResult: OnResultFn
  ) {}

  enqueue(text: string): void {
    this.queue.push(text);
    if (!this.processing) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const text = this.queue.shift() as string;
      try {
        const translated = await this.translate(text);
        this.onResult(text, { ok: true, text: translated });
      } catch (e) {
        this.onResult(text, { ok: false, error: String(e) });
      }
    }
    this.processing = false;
  }
}
