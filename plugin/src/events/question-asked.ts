import type { EventQuestionAsked, QuestionInfo } from "@opencode-ai/sdk/v2";
import type { TelegramQuestionDispatcher } from "../bot.js";
import { claimOnce } from "../lib/claim.js";
import { createQuestionShortHash, type PendingQuestionState } from "../lib/pending-questions.js";
import { pendingQuestionText } from "../lib/question-format.js";
import type { EventHandlerContext, QuestionAnswer } from "./types.js";

const QUESTION_EXPIRY_MS = 5 * 60_000;
const CALLBACK_RE = /^q:([^:]+):(\d+):(\d+|c|d)$/;

function isQuestionOption(value: Record<string, unknown>): boolean {
  return typeof value.label === "string" && typeof value.description === "string";
}

function isQuestionInfo(value: Record<string, unknown>): boolean {
  if (typeof value.question !== "string") return false;
  if (typeof value.header !== "string") return false;
  if (!Array.isArray(value.options)) return false;
  return value.options.every(
    (option) =>
      typeof option === "object" &&
      option !== null &&
      isQuestionOption(option as Record<string, unknown>),
  );
}

export function isEventQuestionAsked(event: {
  type: string;
  properties?: Record<string, unknown>;
}): event is EventQuestionAsked {
  if (event.type !== "question.asked") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.id !== "string") return false;
  if (typeof props.sessionID !== "string") return false;
  if (!Array.isArray(props.questions)) return false;
  return props.questions.every(
    (question) =>
      typeof question === "object" &&
      question !== null &&
      isQuestionInfo(question as Record<string, unknown>),
  );
}

function buildCallbackData(
  shortHash: string,
  questionIndex: number,
  optionIndex: number | "c" | "d",
): string {
  const data = `q:${shortHash}:${questionIndex}:${optionIndex}`;
  if (Buffer.byteLength(data, "utf8") > 64)
    throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}

function callbackDataForQuestion(
  shortHash: string,
  questionIndex: number,
  question: QuestionInfo,
): string[] {
  const data = question.options.map((_, optionIndex) =>
    buildCallbackData(shortHash, questionIndex, optionIndex),
  );
  if (question.custom !== false) data.push(buildCallbackData(shortHash, questionIndex, "c"));
  return data;
}

function useSimpleQuestionKeyboard(question: QuestionInfo): boolean {
  return question.multiple !== true;
}

function selectedAnswers(pending: PendingQuestionState, questionIndex: number): QuestionAnswer {
  return pending.answersInProgress[questionIndex] ?? [];
}

function questionInlineKeyboard(
  shortHash: string,
  questionIndex: number,
  question: QuestionInfo,
  selected: QuestionAnswer,
): Array<Array<{ text: string; callback_data: string }>> {
  const multiple = question.multiple === true;
  const inlineKeyboard = question.options.map((option, optionIndex) => [
    {
      text: multiple && selected.includes(option.label) ? `✅ ${option.label}` : option.label,
      callback_data: buildCallbackData(shortHash, questionIndex, optionIndex),
    },
  ]);
  if (question.custom !== false) {
    inlineKeyboard.push([
      { text: "✏️ Custom answer", callback_data: buildCallbackData(shortHash, questionIndex, "c") },
    ]);
  }
  if (multiple) {
    inlineKeyboard.push([
      { text: "✅ Done", callback_data: buildCallbackData(shortHash, questionIndex, "d") },
    ]);
  }
  return inlineKeyboard;
}

function questionPromptText(pending: PendingQuestionState, questionIndex: number): string {
  return pendingQuestionText(pending.questions, questionIndex);
}

function answerSummary(questions: QuestionInfo[], answers: QuestionAnswer[]): string {
  return answers
    .map(
      (answer, index) =>
        `${index + 1}. ${questions[index]?.header ?? "Question"}: ${answer.join(", ") || "(empty)"}`,
    )
    .join("\n");
}

async function editPromptForQuestion(
  ctx: EventHandlerContext,
  pending: PendingQuestionState,
  shortHash: string,
  questionIndex: number,
): Promise<void> {
  const messageId = pending.telegramMessageIds[0];
  const question = pending.questions[questionIndex];
  const inlineKeyboard = questionInlineKeyboard(
    shortHash,
    questionIndex,
    question,
    selectedAnswers(pending, questionIndex),
  );
  await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

async function completeIfReady(
  ctx: EventHandlerContext,
  pending: PendingQuestionState,
  shortHash: string,
): Promise<void> {
  const nextIndex = pending.answersInProgress.findIndex((answer) => answer === null);
  if (nextIndex >= 0) {
    pending.currentQuestionIndex = nextIndex;
    await ctx.pendingQuestions.savePending(shortHash, pending);
    await editPromptForQuestion(ctx, pending, shortHash, nextIndex);
    return;
  }

  const answers = pending.answersInProgress.map((answer) => answer ?? []);
  const messageId = pending.telegramMessageIds[0];
  try {
    await ctx.replyToQuestion(pending.requestID, answers, pending.serverUrl);
    await ctx.bot.editMessageRemoveKeyboard(
      messageId,
      `✅ Answered:\n${answerSummary(pending.questions, answers)}`,
    );
    ctx.logger.info("question reply sent", {
      requestID: pending.requestID,
      sessionID: pending.sessionID,
    });
  } catch (err) {
    await ctx.bot.editMessageRemoveKeyboard(messageId, "⚠️ Failed to send answer to opencode");
    ctx.logger.error("failed to send question reply", {
      error: String(err),
      requestID: pending.requestID,
    });
  } finally {
    await ctx.pendingQuestions.deletePending(shortHash);
  }
}

export async function handleQuestionAsked(
  event: EventQuestionAsked,
  ctx: EventHandlerContext,
): Promise<void> {
  const request = event.properties;
  if (request.questions.length === 0) return;

  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `question:${ctx.serverUrl.href}:${request.sessionID}:${request.id}`,
    ttlMs: 5_000,
  });
  if (!claimed) return;

  const shortHash = createQuestionShortHash(request.id, request.sessionID, ctx.serverUrl.href);
  const firstQuestion = request.questions[0];
  const sentAt = Date.now();
  const pending: PendingQuestionState = {
    requestID: request.id,
    sessionID: request.sessionID,
    serverUrl: ctx.serverUrl.href,
    questions: request.questions,
    sentAt,
    expiresAt: sentAt + QUESTION_EXPIRY_MS,
    telegramMessageIds: [],
    currentQuestionIndex: 0,
    answersInProgress: request.questions.map(() => null),
  };

  try {
    const message =
      request.questions.length === 1 && useSimpleQuestionKeyboard(firstQuestion)
        ? await ctx.bot.sendQuestionWithKeyboard(
            firstQuestion,
            callbackDataForQuestion(shortHash, 0, firstQuestion),
          )
        : await ctx.bot.sendMessage(questionPromptText(pending, 0), {
            reply_markup: {
              inline_keyboard: questionInlineKeyboard(shortHash, 0, firstQuestion, []),
            },
          });
    pending.telegramMessageIds = [message.message_id];
    await ctx.pendingQuestions.savePending(shortHash, pending);
    ctx.logger.info("question prompt sent", {
      requestID: request.id,
      sessionID: request.sessionID,
      count: request.questions.length,
    });
  } catch (err) {
    ctx.logger.error("failed to send question prompt", {
      error: String(err),
      requestID: request.id,
    });
  }
}

export function createQuestionDispatcher(ctx: EventHandlerContext): TelegramQuestionDispatcher {
  return {
    async handleCallbackQuery(data, messageId, chatId, userId) {
      const match = CALLBACK_RE.exec(data);
      if (!match) return;
      const shortHash = match[1];
      const questionIndex = Number(match[2]);
      const selection = match[3];
      const pending = await ctx.pendingQuestions.loadPending(shortHash);
      if (!pending) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "This question has expired.");
        return;
      }
      pending.expiresAt = Date.now() + QUESTION_EXPIRY_MS;
      const question = pending.questions[questionIndex];
      if (!question) return;

      if (selection === "c") {
        if (question.multiple === true) {
          await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), {
            reply_markup: { inline_keyboard: [] },
          });
        } else {
          await ctx.bot.editMessageRemoveKeyboard(
            messageId,
            "✏️ Reply to the next message with your custom answer.",
          );
        }
        const prompt = await ctx.bot.replyWithForceReply(
          "Type your custom answer",
          "Type your answer",
        );
        pending.awaitingCustomFor = {
          shortHash,
          questionIndex,
          chatId,
          userId,
          promptMessageId: prompt.message_id,
        };
        await ctx.pendingQuestions.savePending(shortHash, pending);
        return;
      }

      if (selection === "d") {
        if (question.multiple !== true) return;
        pending.answersInProgress[questionIndex] = selectedAnswers(pending, questionIndex);
        pending.awaitingCustomFor = undefined;
        await completeIfReady(ctx, pending, shortHash);
        return;
      }

      const option = question.options[Number(selection)];
      if (!option) return;
      if (question.multiple === true) {
        const current = selectedAnswers(pending, questionIndex);
        pending.answersInProgress[questionIndex] = current.includes(option.label)
          ? current.filter((answer) => answer !== option.label)
          : [...current, option.label];
        pending.awaitingCustomFor = undefined;
        await ctx.pendingQuestions.savePending(shortHash, pending);
        await editPromptForQuestion(ctx, pending, shortHash, questionIndex);
        return;
      }
      pending.answersInProgress[questionIndex] = [option.label];
      pending.awaitingCustomFor = undefined;
      await completeIfReady(ctx, pending, shortHash);
    },
    async handleTextReply(text, chatId, userId, replyToMessageId) {
      const match = await ctx.pendingQuestions.findAwaitingCustom(chatId, userId);
      if (!match) return;
      const awaiting = match.data.awaitingCustomFor;
      if (!awaiting || awaiting.promptMessageId !== replyToMessageId) return;
      match.data.expiresAt = Date.now() + QUESTION_EXPIRY_MS;
      const question = match.data.questions[awaiting.questionIndex];
      if (question?.multiple === true) {
        const current = selectedAnswers(match.data, awaiting.questionIndex);
        match.data.answersInProgress[awaiting.questionIndex] = current.includes(text)
          ? current
          : [...current, text];
        match.data.awaitingCustomFor = undefined;
        await ctx.bot.sendMessage("✅ Custom answer added. Tap Done when finished.");
        await ctx.pendingQuestions.savePending(match.shortHash, match.data);
        await editPromptForQuestion(ctx, match.data, match.shortHash, awaiting.questionIndex);
        return;
      }
      match.data.answersInProgress[awaiting.questionIndex] = [text];
      match.data.awaitingCustomFor = undefined;
      await ctx.bot.sendMessage("✅ Custom answer sent.");
      await completeIfReady(ctx, match.data, match.shortHash);
    },
  };
}
