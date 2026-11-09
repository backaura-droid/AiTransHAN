// 세션 레코드에서 사고(thinking) 텍스트를 추출하고 번역이 필요한지 판별한다
type AnyRecord = Record<string, unknown>;

export function isSkippableRecord(record: AnyRecord): boolean {
  return (
    record.isApiErrorMessage === true ||
    !!record.apiRefusalCategory ||
    !!record.refusedMessageId
  );
}

// 교차검증 C-Filter: 한 레코드의 message.content[] 안에 여러 개의 thinking 블록이 있을 수 있다(실측 301건).
// 모든 thinking 블록을 빠짐없이 배열로 추출한다.
export function extractThinkingTexts(record: AnyRecord): string[] {
  if (isSkippableRecord(record)) return [];

  // 리뷰 C2: thinkingDisplay는 실제 사고 텍스트가 아니라 "summarized" 같은 표시 모드
  // 플래그였다(실측 667/716건이 전부 이 값). 실제 본문은 content[].thinking뿐이다.
  const message = record.message as AnyRecord | undefined;
  const content = message?.content;
  const results: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item &&
        typeof item === 'object' &&
        (item as AnyRecord).type === 'thinking' &&
        typeof (item as AnyRecord).thinking === 'string' &&
        ((item as AnyRecord).thinking as string).length > 0
      ) {
        results.push((item as AnyRecord).thinking as string);
      }
    }
  }

  return results;
}

export function extractThinkingText(record: AnyRecord): string | null {
  const texts = extractThinkingTexts(record);
  return texts.length > 0 ? texts[0] : null;
}

// 리뷰 I2 + 교차검증 보강:
// 1) 멀티라인 코드펜스(```...```)를 먼저 제거하고, 인라인 백틱은 줄바꿈을 넘지 않게(/`[^`\r\n]*`/g) 제거해
//    닫히지 않은 홀수 백틱 하나가 뒤따르는 영어 문단 전체를 삼키지 않도록 한다.
// 2) 토큰 양끝 구두점(Note:, Step: 등의 콜론 포함)을 먼저 벗긴 뒤 경로/파일명 여부를 판정하고,
//    and/or, true/false 같은 단순 영단어 슬래시 병기는 경로로 오인하지 않는다.
function stripCodeLikeTokens(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, ' ');
  const withoutCodeSpans = withoutFences.replace(/`[^`\r\n]*`/g, ' ');
  const tokens = withoutCodeSpans.split(/\s+/);
  const kept = tokens.filter((tok) => {
    if (tok.length === 0) return true;
    const core = tok.replace(/^[,.:;!?()[\]{}"']+|[,.:;!?()[\]{}"']+$/g, '');
    if (core.length === 0) return false;

    const hasBackslash = core.includes('\\');
    const isUrlOrDrive = /^[A-Za-z]+:\/\//.test(core) || /^[A-Za-z]:[\\/]/.test(core);
    const hasFileExt = /\.[A-Za-z0-9]{1,5}$/.test(core);
    // 슬래시 포함 토큰 중 단순 영단어 2개 병기(and/or, true/false, read/write 등)가 아닌 경로 형태만 제거
    const hasPathSlash =
      core.includes('/') && !/^[A-Za-z]{1,12}\/[A-Za-z]{1,12}$/.test(core);

    const looksLikePathOrIdentifier =
      hasBackslash || isUrlOrDrive || hasFileExt || hasPathSlash;
    return !looksLikePathOrIdentifier;
  });
  return kept.join(' ');
}

export function needsTranslation(text: string): boolean {
  const cleaned = stripCodeLikeTokens(text);
  const hangul = (cleaned.match(/[가-힣]/g) || []).length;
  const latin = (cleaned.match(/[A-Za-z]/g) || []).length;
  // 교차검증 보강: 한글이 한 글자도 없는 순수 영문 사고 문장은 경로/식별자 제거 후 영문자가 10자 이상이면 번역한다.
  if (hangul === 0) {
    return latin >= 10;
  }
  if (latin < 20) return false;
  return hangul / (hangul + latin) < 0.3;
}

// 리뷰 I6 + 교차검증 보강: 레코드 배열에서 다중 thinking 블록까지 모두 순회해 번역 대상을 뽑는다.
export function pickTranslatable(records: unknown[]): string[] {
  const result: string[] = [];
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue;
    for (const text of extractThinkingTexts(record as AnyRecord)) {
      if (needsTranslation(text)) {
        result.push(text);
      }
    }
  }
  return result;
}
