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

  // 리뷰 C2: thinkingDisplay는 실제 사고 텍스트가 아니라 "summarized" 같은 표시 모드
  // 플래그였다(실측 667/716건이 전부 이 값). 실제 본문은 content[].thinking뿐이다.
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

// 리뷰 I2: 백틱 코드 스팬과 경로/파일명처럼 보이는 토큰(\ / : 포함, 또는 .확장자로 끝남)을
// 한글 비율 계산 전에 제거한다. 그대로 두면 한국어 문장에 코드 식별자·경로가 섞여 있을 때
// (이 사용자의 실제 작성 습관) 오탐으로 번역 큐에 들어간다.
function stripCodeLikeTokens(text: string): string {
  const withoutCodeSpans = text.replace(/`[^`]*`/g, ' ');
  const tokens = withoutCodeSpans.split(/\s+/);
  const kept = tokens.filter((tok) => {
    if (tok.length === 0) return true;
    const looksLikePathOrIdentifier = /[\\/:]/.test(tok) || /\.[A-Za-z]{1,4}$/.test(tok);
    return !looksLikePathOrIdentifier;
  });
  return kept.join(' ');
}

export function needsTranslation(text: string): boolean {
  const cleaned = stripCodeLikeTokens(text);
  const hangul = (cleaned.match(/[가-힣]/g) || []).length;
  const latin = (cleaned.match(/[A-Za-z]/g) || []).length;
  if (latin < 20) return false;
  return hangul / (hangul + latin) < 0.3;
}

// 리뷰 I6: tailOnce → extractThinkingText → needsTranslation으로 이어지는 조합 자체를
// 실제 레코드 모양 fixture로 테스트하기 위한 순수 함수. extension.ts의 배선도 이 함수를 쓴다.
export function pickTranslatable(records: unknown[]): string[] {
  const result: string[] = [];
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue;
    const text = extractThinkingText(record as AnyRecord);
    if (text && needsTranslation(text)) {
      result.push(text);
    }
  }
  return result;
}
