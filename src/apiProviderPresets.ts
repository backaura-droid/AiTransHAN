// 붙여넣은 API 키의 접두사로 제공자를 추측한다. 접두사가 다른 서비스와 겹칠 위험이 있는
// 제공자(OpenAI의 평범한 "sk-", OpenCode 등)는 형식이 공식 문서에 없어 여기 넣지 않는다 —
// 그런 경우는 "커스텀(OpenAI 호환 엔드포인트)"을 사용자가 직접 고르게 한다.
export interface ApiProviderPreset {
  id: 'gemini' | 'groq' | 'openrouter';
  label: string;
  keyPattern: RegExp;
  baseUrl: string;
  defaultModel: string;
  getKeyUrl: string;
}

export const API_PROVIDER_PRESETS: ApiProviderPreset[] = [
  {
    id: 'gemini',
    label: 'Gemini',
    keyPattern: /^AIza/,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash-lite',
    getKeyUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'groq',
    label: 'Groq',
    keyPattern: /^gsk_/,
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    getKeyUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyPattern: /^sk-or-v1-/,
    // 2026-11-10: OpenRouter의 무료(:free) 모델 목록은 자주 바뀐다. 기본값이 나중에 없어지면
    // 설정(claudeThinkingKo.model)에 openrouter.ai/models의 현재 무료 모델 id를 직접 넣으면 된다.
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    getKeyUrl: 'https://openrouter.ai/keys'
  }
];

export function detectProvider(apiKey: string): ApiProviderPreset | undefined {
  return API_PROVIDER_PRESETS.find((preset) => preset.keyPattern.test(apiKey));
}
