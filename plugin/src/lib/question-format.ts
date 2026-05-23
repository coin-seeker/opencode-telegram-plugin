import type { QuestionInfo } from "@opencode-ai/sdk/v2";

function optionDescriptionText(question: QuestionInfo): string {
  const options = question.options.map((option, index) => {
    const description = option.description.trim();
    return description
      ? `${index + 1}. ${option.label}\n> ${description}`
      : `${index + 1}. ${option.label}`;
  });
  return options.length > 0 ? `\n\n${options.join("\n")}` : "";
}

export function questionText(question: QuestionInfo): string {
  const header = question.header ? `❓ ${question.header}` : "❓ Question";
  return `${header}\n\n${question.question}${optionDescriptionText(question)}`;
}

export function pendingQuestionText(questions: QuestionInfo[], questionIndex: number): string {
  const question = questions[questionIndex];
  const prefix =
    questions.length > 1 ? `Question ${questionIndex + 1}/${questions.length}\n\n` : "";
  const allQuestions =
    questions.length > 1
      ? `All questions:\n${questions.map((q, i) => `${i + 1}. ${q.header}: ${q.question}`).join("\n")}\n\n`
      : "";
  return `${allQuestions}${prefix}${questionText(question)}`;
}
