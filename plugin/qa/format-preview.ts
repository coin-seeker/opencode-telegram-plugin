// Manual QA: sends the new notice-format messages to the live chat to verify
// Telegram accepts the HTML (parse_mode) and the layout looks right.
// Run: npx tsx qa/format-preview.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentFinishedMessage } from "../src/events/session-idle.js";
import { planCompleteMessage } from "../src/events/start-work.js";
import { field, notice } from "../src/lib/message-format.js";
import { questionText } from "../src/lib/question-format.js";

function envValue(key: string): string {
  const envPath = join(homedir(), ".config/opencode/telegram-remote/.env");
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found`);
  return line.slice(key.length + 1).trim();
}

const token = envValue("TELEGRAM_BOT_TOKEN");
const chatId = JSON.parse(
  readFileSync(join(homedir(), ".config/opencode/telegram-remote/state.json"), "utf8"),
).chatId as number;

const samples: Array<[string, string]> = [
  ["completion", agentFinishedMessage("텔레그램 플러그인 메시지 포맷 개편", "build")],
  ["plan", planCompleteMessage("메시지 포맷 통일 계획")],
  [
    "question",
    questionText({
      header: "배포할까요?",
      question: "1.3.0 버전을 npm에 배포합니다. <escape test & check>",
      options: [
        { label: "배포", description: "지금 바로 배포" },
        { label: "보류", description: "" },
      ],
    }),
  ],
  ["answered", notice("✅", "답변 완료", field("배포할까요?", "배포"))],
  [
    "answered-in-opencode",
    notice("✅", "답변 완료", field("질문", "배포할까요?"), "OpenCode에서 직접 답변했어요."),
  ],
  [
    "permission",
    notice(
      "🔐",
      "권한 요청",
      field("세션", "포맷 QA 세션"),
      field("권한", "bash"),
      field("내용", "rm -rf <dist>"),
    ),
  ],
];

for (const [name, text] of samples) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  console.log(`${name}: HTTP ${res.status} ok=${body.ok} ${body.description ?? ""}`);
  if (!body.ok) process.exitCode = 1;
}
