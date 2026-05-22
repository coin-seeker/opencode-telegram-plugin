import type { EventQuestionAsked, QuestionInfo } from "@opencode-ai/sdk/v2";
import { claimOnce } from "../lib/claim.js";
import { createQuestionShortHash, type PendingQuestionState } from "../lib/pending-questions.js";
import type { TelegramQuestionDispatcher } from "../bot.js";
import type { EventHandlerContext, QuestionAnswer } from "./types.js";

const QUESTION_EXPIRY_MS = 5 * 60_000;
const CALLBACK_RE = /^q:([^:]+):(\d+):(\d+|c)$/;

function isQuestionOption(value: Record<string, unknown>): boolean {
  return typeof value.label === "string" && typeof value.description === "string";
}

function isQuestionInfo(value: Record<string, unknown>): boolean {
  if (typeof value.question !== "string") return false;
  if (typeof value.header !== "string") return false;
  if (!Array.isArray(value.options)) return false;
  return value.options.every((option) => typeof option === "object" && option !== null && isQuestionOption(option as Record<string, unknown>));
}

export function isEventQuestionAsked(event: { type: string; properties?: Record<string, unknown> }): event is EventQuestionAsked {
  if (event.type !== "question.asked") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.id !== "string") return false;
  if (typeof props.sessionID !== "string") return false;
  if (!Array.isArray(props.questions)) return false;
  return props.questions.every((question) => typeof question === "object" && question !== null && isQuestionInfo(question as Record<string, unknown>));
}

function buildCallbackData(shortHash: string, questionIndex: number, optionIndex: number | "c"): string {
  const data = `q:${shortHash}:${questionIndex}:${optionIndex}`;
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}

function callbackDataForQuestion(shortHash: string, questionIndex: number, question: QuestionInfo): string[] {
  const data = question.options.map((_, optionIndex) => buildCallbackData(shortHash, questionIndex, optionIndex));
  if (question.custom !== false) data.push(buildCallbackData(shortHash, questionIndex, "c"));
  return data;
}

function questionPromptText(pending: PendingQuestionState, questionIndex: number): string {
  const question = pending.questions[questionIndex];
  const prefix = pending.questions.length > 1 ? `Question ${questionIndex + 1}/${pending.questions.length}\n\n` : "";
  const allQuestions = pending.questions.length > 1
    ? `All questions:\n${pending.questions.map((q, i) => `${i + 1}. ${q.header}: ${q.question}`).join("\n")}\n\n`
    : "";
  return `${allQuestions}${prefix}❓ ${question.header}\n\n${question.question}`;
}

function answerSummary(questions: QuestionInfo[], answers: QuestionAnswer[]): string {
  return answers
    .map((answer, index) => `${index + 1}. ${questions[index]?.header ?? "Question"}: ${answer.join(", ") || "(empty)"}`)
    .join("\n");
}

async function editPromptForQuestion(ctx: EventHandlerContext, pending: PendingQuestionState, shortHash: string, questionIndex: number): Promise<void> {
  const messageId = pending.telegramMessageIds[0];
  const question = pending.questions[questionIndex];
  const inlineKeyboard = question.options.map((option, optionIndex) => ([{
    text: option.label,
    callback_data: buildCallbackData(shortHash, questionIndex, optionIndex),
  }]));
  if (question.custom !== false) {
    inlineKeyboard.push([{ text: "✏️ Custom answer", callback_data: buildCallbackData(shortHash, questionIndex, "c") }]);
  }
  await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), { reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function completeIfReady(ctx: EventHandlerContext, pending: PendingQuestionState, shortHash: string): Promise<void> {
  const nextIndex = pending.answersInProgress.findIndex((answer) => answer === undefined);
  if (nextIndex >= 0) {
    pending.currentQuestionIndex = nextIndex;
    await ctx.pendingQuestions.savePending(shortHash, pending);
    await editPromptForQuestion(ctx, pending, shortHash, nextIndex);
    return;
  }

  const answers = pending.answersInProgress.map((answer) => answer ?? []);
  const messageId = pending.telegramMessageIds[0];
  try {
    await ctx.replyToQuestion(pending.requestID, answers);
    await ctx.bot.editMessageRemoveKeyboard(messageId, `✅ Answered:\n${answerSummary(pending.questions, answers)}`);
    ctx.logger.info("question reply sent", { requestID: pending.requestID, sessionID: pending.sessionID });
  } catch (err) {
    await ctx.bot.editMessageRemoveKeyboard(messageId, "⚠️ Failed to send answer to opencode");
    ctx.logger.error("failed to send question reply", { error: String(err), requestID: pending.requestID });
  } finally {
    await ctx.pendingQuestions.deletePending(shortHash);
  }
}

async function expirePending(ctx: EventHandlerContext, shortHash: string, pending: PendingQuestionState, messageId: number): Promise<void> {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "⏱ Question expired");
  await ctx.pendingQuestions.deletePending(shortHash);
  ctx.logger.info("pending question expired", { requestID: pending.requestID });
}

export async function handleQuestionAsked(event: EventQuestionAsked, ctx: EventHandlerContext): Promise<void> {
  const request = event.properties;
  if (request.questions.length === 0) return;

  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `question.asked:${request.id}`, ttlMs: 5_000 });
  if (!claimed) return;

  const shortHash = createQuestionShortHash(request.id);
  const firstQuestion = request.questions[0];
  const sentAt = Date.now();
  const pending: PendingQuestionState = {
    requestID: request.id,
    sessionID: request.sessionID,
    questions: request.questions,
    sentAt,
    expiresAt: sentAt + QUESTION_EXPIRY_MS,
    telegramMessageIds: [],
    currentQuestionIndex: 0,
    answersInProgress: request.questions.map(() => undefined),
  };

  try {
    const message = request.questions.length === 1
      ? await ctx.bot.sendQuestionWithKeyboard(firstQuestion, callbackDataForQuestion(shortHash, 0, firstQuestion))
      : await ctx.bot.sendMessage(questionPromptText(pending, 0), {
        reply_markup: {
          inline_keyboard: firstQuestion.options.map((option, optionIndex) => ([{
            text: option.label,
            callback_data: buildCallbackData(shortHash, 0, optionIndex),
          }])).concat(firstQuestion.custom !== false ? [[{ text: "✏️ Custom answer", callback_data: buildCallbackData(shortHash, 0, "c") }]] : []),
        },
      });
    pending.telegramMessageIds = [message.message_id];
    await ctx.pendingQuestions.savePending(shortHash, pending);
    ctx.logger.info("question prompt sent", { requestID: request.id, sessionID: request.sessionID, count: request.questions.length });
  } catch (err) {
    ctx.logger.error("failed to send question prompt", { error: String(err), requestID: request.id });
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
      if (pending.expiresAt < Date.now()) {
        await expirePending(ctx, shortHash, pending, messageId);
        return;
      }
      const question = pending.questions[questionIndex];
      if (!question) return;

      if (selection === "c") {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "✏️ Reply to the next message with your custom answer.");
        const prompt = await ctx.bot.replyWithForceReply("Type your custom answer", "Type your answer");
        pending.awaitingCustomFor = { shortHash, questionIndex, chatId, userId, promptMessageId: prompt.message_id };
        await ctx.pendingQuestions.savePending(shortHash, pending);
        return;
      }

      const option = question.options[Number(selection)];
      if (!option) return;
      if (question.multiple === true) {
        ctx.logger.info("multiple-choice question handled as single-select", { requestID: pending.requestID, questionIndex });
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
      if (match.data.expiresAt < Date.now()) {
        await expirePending(ctx, match.shortHash, match.data, match.data.telegramMessageIds[0]);
        return;
      }
      match.data.answersInProgress[awaiting.questionIndex] = [text];
      match.data.awaitingCustomFor = undefined;
      await ctx.bot.sendMessage("✅ Custom answer sent.");
      await completeIfReady(ctx, match.data, match.shortHash);
    },
  };
}
