// 번역 요청을 한 번에 하나씩 순서대로 처리하는 FIFO 큐
// 2026-11-10: 항목마다 세션 파일 경로를 함께 실어, 번역이 끝났을 때 이미 탭이 바뀌었어도
// 결과가 원래 세션으로 돌아가게 한다(탭 간 오염 방지).
export type TranslateFn = (text: string) => Promise<string>;
export type TranslationResult = { ok: true; text: string } | { ok: false; error: string };
export type OnResultFn = (filePath: string, input: string, result: TranslationResult) => void;

export class TranslationQueue {
  private queue: Array<{ filePath: string; text: string }> = [];
  private processing = false;

  constructor(
    private readonly translate: TranslateFn,
    private readonly onResult: OnResultFn
  ) {}

  enqueue(filePath: string, text: string): void {
    this.queue.push({ filePath, text });
    if (!this.processing) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const { filePath, text } = this.queue.shift()!;
      try {
        const translated = await this.translate(text);
        this.onResult(filePath, text, { ok: true, text: translated });
      } catch (e) {
        this.onResult(filePath, text, { ok: false, error: String(e) });
      }
    }
    this.processing = false;
  }
}
