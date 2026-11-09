// 세션 레코드에서 사고(thinking) 텍스트를 추출하고 번역이 필요한지 판별한다
type AnyRecord = Record<string, unknown>;

export function isSkippableRecord(record: AnyRecord): boolean {
  return (
    record.isApiErrorMessage === true ||
    !!record.apiRefusalCategory ||
    !!record.refusedMessageId
  );
}

export function extractThinkingText(record: AnyRecord): string | null {
  if (isSkippableRecord(record)) return null;

  if (typeof record.thinkingDisplay === 'string' && record.thinkingDisplay.length > 0) {
    return record.thinkingDisplay;
  }

  const message = record.message as AnyRecord | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item &&
        typeof item === 'object' &&
        (item as AnyRecord).type === 'thinking' &&
        typeof (item as AnyRecord).thinking === 'string'
      ) {
        return (item as AnyRecord).thinking as string;
      }
    }
  }

  return null;
}

export function needsTranslation(text: string): boolean {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (latin < 20) return false;
  return hangul / (hangul + latin) < 0.3;
}
