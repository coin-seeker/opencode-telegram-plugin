import type { QuestionInfo } from "@opencode-ai/sdk/v2";

function optionDescriptionText(question: QuestionInfo): string {
  const options = question.options.map((option, index) => {
    const description = option.description.trim();
    return description
      ? `${index + 1}. ${option.label}\n설명: ${description}`
      : `${index + 1}. ${option.label}`;
  });
  return options.length > 0 ? `\n\nOptions:\n\n${options.join("\n\n")}` : "";
}

export function questionText(question: QuestionInfo, progress?: string): string {
  const title = question.header || "Question";
  const header = progress ? `❓ ${progress} · ${title}` : `❓ ${title}`;
  return `${header}\n\n${question.question}${optionDescriptionText(question)}`;
}

export function pendingQuestionText(questions: QuestionInfo[], questionIndex: number): string {
  const question = questions[questionIndex];
  const progress =
    questions.length > 1 ? `Question ${questionIndex + 1}/${questions.length}` : undefined;
  return questionText(question, progress);
}
