// agy(Gemini CLI)를 호출해 텍스트를 번역한다 — 원문은 임시 파일에만 쓰고 명령줄 인자로는 넘기지 않는다
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { exec } from 'node:child_process';

export interface WriteAndRunAgyOptions {
  tempDir: string;
  commandBuilder?: (tempFilePath: string) => string;
}

function defaultCommandBuilder(tempFilePath: string): string {
  // 주의(Task 6 Ruling): 설계 문서가 가정한 `cmd /c type <file> | agy -p ...` 파이프 방식은
  // 실제로는 agy의 --print 모드가 표준입력을 프롬프트에 포함시키지 않아 동작하지 않음을 실행으로 확인함.
  // 대신 --add-dir로 임시 폴더를 열어주고 파일명을 지정해 agy 스스로 읽게 하는 방식이 실제로 동작함.
  const dir = path.dirname(tempFilePath);
  const fileName = path.basename(tempFilePath);
  const prompt = `${fileName} 파일을 읽어서 자연스러운 한국어로 번역해줘. 번역문만 출력하고 다른 말은 덧붙이지 마.`;
  return `agy -p "${prompt}" --model gemini-3.8-flash-low --dangerously-skip-permissions --add-dir "${dir}"`;
}

export function writeAndRunAgy(text: string, options: WriteAndRunAgyOptions): Promise<string> {
  const tempFilePath = path.join(options.tempDir, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(tempFilePath, text, 'utf8');

  const command = (options.commandBuilder ?? defaultCommandBuilder)(tempFilePath);

  return new Promise<string>((resolve, reject) => {
    exec(command, (error, stdout) => {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // 이미 지워졌거나 정리 실패해도 번역 결과 처리를 막지 않는다
      }
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}
