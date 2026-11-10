// Gemini REST API(API 키)로 직접 번역한다 — agy(구독 CLI)가 없는 배포 환경을 위한 대체 경로.
// Node 18+ 전역 fetch만 쓰고 의존성을 추가하지 않는다.
import { TRANSLATOR_INSTRUCTION } from './translatorPersona';

export type FetchFn = typeof fetch;

export interface GeminiApiOptions {
  apiKey: string;
  model?: string;
  /** 테스트에서 실제 네트워크 호출 없이 치환 */
  fetchImpl?: FetchFn;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_TIMEOUT_MS = 30_000;

export async function translateWithGeminiApi(text: string, options: GeminiApiOptions): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(options.apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TRANSLATOR_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: `<text>\n${text}\n</text>` }] }]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini API 오류 ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const translated = parts.map((p) => p.text ?? '').join('');
    if (!translated) {
      throw new Error('Gemini API 응답에서 번역문을 찾지 못함');
    }
    return translated;
  } finally {
    clearTimeout(timer);
  }
}
