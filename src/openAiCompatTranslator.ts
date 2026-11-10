// OpenAI 호환 "/chat/completions" 엔드포인트로 번역한다 — Gemini·Groq·OpenRouter의 OpenAI 호환
// 레이어는 물론, 사용자가 직접 넣는 커스텀 엔드포인트(OpenCode·LLM7·자체 게이트웨이 등)까지
// base URL·모델·키만 다르고 요청 형태는 전부 같아서 클라이언트 하나로 처리한다.
// Node 18+ 전역 fetch만 쓰고 의존성을 추가하지 않는다.
import { TRANSLATOR_INSTRUCTION } from './translatorPersona';

export type FetchFn = typeof fetch;

export interface OpenAiCompatOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 테스트에서 실제 네트워크 호출 없이 치환 */
  fetchImpl?: FetchFn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function translateViaOpenAiCompat(text: string, options: OpenAiCompatOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: TRANSLATOR_INSTRUCTION },
          { role: 'user', content: `<text>\n${text}\n</text>` }
        ]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API 오류 ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const translated = data.choices?.[0]?.message?.content ?? '';
    if (!translated) {
      throw new Error('API 응답에서 번역문을 찾지 못함');
    }
    return translated;
  } finally {
    clearTimeout(timer);
  }
}
