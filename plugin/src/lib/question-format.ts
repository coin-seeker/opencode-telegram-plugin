import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { escapeHtml } from "./html-escape.js";

function optionLines(question: QuestionInfo): string {
  if (question.options.length === 0) return "";
  const lines = question.options.map((option, index) => {
    const description = option.description.trim();
    const label = `${index + 1}. <b>${escapeHtml(option.label)}</b>`;
    return description ? `${label} — ${escapeHtml(description)}` : label;
  });
  return `\n\n<b>선택지</b>\n${lines.join("\n")}`;
}

export function questionText(question: QuestionInfo, progress?: string): string {
  const title = escapeHtml(question.header || "질문");
  const header = progress ? `❓ <b>${title}</b> (${progress})` : `❓ <b>${title}</b>`;
  return `${header}\n\n${escapeHtml(question.question)}${optionLines(question)}`;
}

export function pendingQuestionText(questions: QuestionInfo[], questionIndex: number): string {
  const question = questions[questionIndex];
  const progress = questions.length > 1 ? `${questionIndex + 1}/${questions.length}` : undefined;
  return questionText(question, progress);
}
