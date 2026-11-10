# Claude 사고 한글 보기 (claude-thinking-ko)

Claude Code 세션의 영문 사고(thinking) 블록을 한국어로 번역해, 보조 사이드바에 원문·번역을 나란히 보여주는 VSCode 확장입니다.

- 보조 사이드바에 패널 하나를 두고, 지금 보고 있는 Claude Code 탭을 자동으로 따라갑니다.
- 다른 탭으로 옮겨도 이전 탭은 백그라운드에서 계속 번역되고, 돌아오면 그 사이 쌓인 내용까지 바로 보입니다.
- 번역이 진행 중일 때는 "⏳ 번역 중입니다..."가, 할 일이 없을 때는 "입력을 대기 중입니다"가 항상 표시됩니다.
- Claude Code 자체의 대화창·API 호출과는 무관하게, 로컬 세션 로그 파일만 읽어서 동작합니다.

## 설치

1. [Releases](https://github.com/backaura-droid/AiTransHAN/releases)에서 최신 `.vsix` 파일을 내려받습니다.
2. VSCode 명령 팔레트(`Ctrl+Shift+P`) → "Extensions: Install from VSIX..." → 내려받은 파일 선택.
3. 또는 터미널에서: `code --install-extension claude-thinking-ko-X.X.X.vsix`

소스에서 직접 빌드하려면:

```bash
git clone https://github.com/backaura-droid/AiTransHAN.git
cd AiTransHAN
npm install
npm run compile
npx vsce package --no-dependencies
code --install-extension claude-thinking-ko-*.vsix
```

## 번역 백엔드 설정

번역은 두 가지 방식 중 하나로 동작합니다. 설정 `claudeThinkingKo.provider`로 고를 수 있고, 기본값은 `auto`입니다.

| 값 | 동작 |
|---|---|
| `auto` (기본) | `agy`(Gemini CLI, 구독) CLI가 PATH에 있으면 그걸 쓰고, 없으면 Gemini API 키 입력을 안내합니다 |
| `agy` | `agy` CLI만 사용합니다 |
| `geminiApiKey` | Gemini API 키만 사용합니다 |

대부분의 사용자는 `agy`가 없으므로, 처음 켜면 아래와 같은 흐름으로 Gemini API 키를 안내합니다.

1. 확장이 켜질 때 agy가 없고 저장된 키도 없으면, 알림 토스트로 한 번만 안내합니다("API 키 입력" / "나중에").
2. "API 키 입력"을 누르면 입력창(가려짐)이 뜨고, 붙여넣으면 VSCode의 `SecretStorage`에 안전하게 저장됩니다(설정 파일에 평문으로 남지 않습니다).
3. 나중에 바꾸거나 처음 입력을 건너뛰었다면, 패널 상단의 **열쇠 아이콘**(또는 명령 팔레트에서 "Claude 사고 번역: Gemini API 키 설정")을 언제든 실행할 수 있습니다.

**키 발급(무료)**: [Google AI Studio](https://aistudio.google.com/apikey)에 Google 계정으로 로그인 → "Create API key" → 생성된 키를 복사해 붙여넣으면 됩니다.

> 이 확장은 Google 계정의 아이디·비밀번호를 받지 않습니다. API 키만 받아 로컬에 안전하게 저장하며, 번역 요청 외의 용도로 쓰지 않습니다.

## 패널 사용법

- **⏸ 전체 일시정지/재개**: 번역을 잠시 멈춥니다(재개 시 멈춰있던 동안의 내용은 건너뜁니다).
- **🗑 전체 지우기**: 지금 보고 있는 탭의 번역 내역을 지웁니다.
- **🔑 Gemini API 키 설정**: 키를 처음 넣거나 바꿀 때.

## 한계

- Claude Code의 세션 로그 파일(`~/.claude/projects/.../*.jsonl`) 내부 구조에 의존합니다. Claude Code 자체 업데이트로 이 구조가 바뀌면 동작이 멈출 수 있습니다.
- 개발·테스트는 Windows 환경 위주로 진행했습니다. macOS/Linux에서는 일부 동작(특히 타임아웃된 `agy` 프로세스 강제 종료)이 다를 수 있습니다.
- 번역은 순서대로 하나씩 처리되며, 호출당 수 초~십수 초가 걸릴 수 있습니다(백엔드 응답 속도에 따라 다름).

## 라이선스

MIT — [LICENSE](LICENSE) 참고.
