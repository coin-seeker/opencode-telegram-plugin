import type { EventQuestionAsked, QuestionInfo } from "@opencode-ai/sdk/v2";
import type { TelegramQuestionDispatcher } from "../bot.js";
import { claimOnce, releaseClaim } from "../lib/claim.js";
import { field, notice } from "../lib/message-format.js";
import { createQuestionShortHash, type PendingQuestionState } from "../lib/pending-questions.js";
import { pendingQuestionText } from "../lib/question-format.js";
import type { EventHandlerContext, QuestionAnswer } from "./types.js";

// Pending question files are kept until OpenCode confirms the outcome (reply success,
// question.replied event, or a failed delivery). There is NO answer deadline: the user can reply
// from Telegram whenever they want, and OpenCode is the source of truth for whether the question
// is still answerable. `expiresAt` is only a retention horizon for garbage-collecting files
// orphaned by dead OpenCode processes (see sweepExpired callers).
const QUESTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
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

function answerSummaryLines(questions: QuestionInfo[], answers: QuestionAnswer[]): string[] {
  return answers.map((answer, index) =>
    field(questions[index]?.header ?? `질문 ${index + 1}`, answer.join(", ") || "(없음)"),
  );
}

async function sendQuestionReply(
  ctx: EventHandlerContext,
  pending: PendingQuestionState,
  shortHash: string,
  answers: QuestionAnswer[],
): Promise<void> {
  const messageId = pending.telegramMessageIds[0];
  // Delete BEFORE posting: OpenCode emits question.replied the instant it accepts the answer, and
  // concurrent handleQuestionReplied handlers must not find this pending and overwrite the
  // answered summary below with an "answered in OpenCode" notice.
  await ctx.pendingQuestions.deletePending(shortHash);
  try {
    await ctx.replyToQuestion(pending.requestID, answers, pending.serverUrl);
    await ctx.bot.editMessageRemoveKeyboard(
      messageId,
      notice("✅", "답변 완료", ...answerSummaryLines(pending.questions, answers)),
    );
    ctx.logger.info("question reply sent", {
      requestID: pending.requestID,
      sessionID: pending.sessionID,
    });
  } catch (err) {
    await ctx.bot.editMessageRemoveKeyboard(
      messageId,
      notice("⚠️", "답변 전송 실패", "OpenCode에 답변을 전달하지 못했어요. 로그를 확인해 주세요."),
    );
    ctx.logger.error("failed to send question reply", {
      error: String(err),
      requestID: pending.requestID,
    });
  }
}

export async function discardCustomAnswerPrompt(
  ctx: EventHandlerContext,
  pending: PendingQuestionState,
): Promise<void> {
  const promptMessageId = pending.awaitingCustomFor?.promptMessageId;
  pending.awaitingCustomFor = undefined;
  if (promptMessageId === undefined) return;
  try {
    await ctx.bot.deleteMessage(promptMessageId);
  } catch (err) {
    ctx.logger.warn("failed to delete custom answer prompt", {
      promptMessageId,
      error: String(err),
    });
  }
}

async function handOffQuestionReply(
  ctx: EventHandlerContext,
  pending: PendingQuestionState,
  shortHash: string,
  answers: QuestionAnswer[],
): Promise<void> {
  pending.answersInProgress = answers;
  pending.awaitingCustomFor = undefined;
  pending.submittedAt = Date.now();
  await ctx.pendingQuestions.savePending(shortHash, pending);
  await ctx.bot.editMessageRemoveKeyboard(
    pending.telegramMessageIds[0],
    notice("⏳", "답변 전송 중", "질문을 받은 OpenCode 창으로 답변을 전달하고 있어요."),
  );
  ctx.logger.info("question reply handed off to owner process", {
    requestID: pending.requestID,
    sessionID: pending.sessionID,
    ownerPID: pending.ownerPID,
  });
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
  const nextIndex = pending.answersInProgress.indexOf(null);
  if (nextIndex >= 0) {
    pending.currentQuestionIndex = nextIndex;
    await ctx.pendingQuestions.savePending(shortHash, pending);
    await editPromptForQuestion(ctx, pending, shortHash, nextIndex);
    return;
  }

  const answers = pending.answersInProgress.map((answer) => answer ?? []);
  if (pending.ownerInstanceID && pending.ownerInstanceID !== ctx.processInstanceID) {
    await handOffQuestionReply(ctx, pending, shortHash, answers);
    return;
  }
  await sendQuestionReply(ctx, pending, shortHash, answers);
}

export async function drainSubmittedQuestionReplies(ctx: EventHandlerContext): Promise<number> {
  const submittedQuestions = await ctx.pendingQuestions.listSubmittedForOwner(
    ctx.processInstanceID,
  );
  for (const { shortHash, data } of submittedQuestions) {
    const answers = data.answersInProgress.map((answer) => answer ?? []);
    await sendQuestionReply(ctx, data, shortHash, answers);
  }
  return submittedQuestions.length;
}

export async function handleQuestionAsked(
  event: EventQuestionAsked,
  ctx: EventHandlerContext,
): Promise<void> {
  const request = event.properties;
  if (request.questions.length === 0) return;

  // Idempotency beyond the short claim TTL: a re-delivered question.asked must never send a second
  // Telegram prompt (the first message would keep live buttons forever once pending is replaced).
  const existing = await ctx.pendingQuestions.findByRequestID(
    request.id,
    request.sessionID,
    ctx.serverUrl.href,
  );
  if (existing) {
    ctx.logger.info("question prompt already pending - skipping duplicate", {
      requestID: request.id,
      sessionID: request.sessionID,
    });
    return;
  }

  const claimKey = `question:${ctx.serverUrl.href}:${request.sessionID}:${request.id}`;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: claimKey, ttlMs: 5_000 });
  if (!claimed) return;

  const shortHash = createQuestionShortHash(request.id, request.sessionID, ctx.serverUrl.href);
  const firstQuestion = request.questions[0];
  const sentAt = Date.now();
  const pending: PendingQuestionState = {
    requestID: request.id,
    sessionID: request.sessionID,
    serverUrl: ctx.serverUrl.href,
    ownerInstanceID: ctx.processInstanceID,
    ownerPID: ctx.processID,
    questions: request.questions,
    sentAt,
    expiresAt: sentAt + QUESTION_RETENTION_MS,
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
    await releaseClaim({ claimsDir: ctx.claimsDir, key: claimKey });
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
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          notice("ℹ️", "만료된 질문", "이미 답변되었거나 세션이 종료된 질문이에요."),
        );
        return;
      }
      if (pending.submittedAt !== undefined) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          notice("⏳", "답변 전송 중", "이미 답변이 전송되고 있어요."),
        );
        return;
      }
      const question = pending.questions[questionIndex];
      if (!question) return;

      if (selection === "c") {
        await discardCustomAnswerPrompt(ctx, pending);
        if (question.multiple === true) {
          await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), {
            reply_markup: { inline_keyboard: [] },
          });
        } else {
          await ctx.bot.editMessageRemoveKeyboard(
            messageId,
            notice("✏️", "커스텀 답변", "다음 메시지에 답장(Reply)으로 답변을 입력해 주세요."),
          );
        }
        const prompt = await ctx.bot.replyWithForceReply(
          notice("✏️", "커스텀 답변 입력"),
          "답변 입력",
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
        await discardCustomAnswerPrompt(ctx, pending);
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
        await discardCustomAnswerPrompt(ctx, pending);
        await ctx.pendingQuestions.savePending(shortHash, pending);
        await editPromptForQuestion(ctx, pending, shortHash, questionIndex);
        return;
      }
      pending.answersInProgress[questionIndex] = [option.label];
      await discardCustomAnswerPrompt(ctx, pending);
      await completeIfReady(ctx, pending, shortHash);
    },
    async handleTextReply(text, chatId, userId, replyToMessageId) {
      const match = await ctx.pendingQuestions.findAwaitingCustom(chatId, userId);
      if (!match) return;
      if (match.data.submittedAt !== undefined) return;
      const awaiting = match.data.awaitingCustomFor;
      if (!awaiting || awaiting.promptMessageId !== replyToMessageId) return;
      const question = match.data.questions[awaiting.questionIndex];
      if (question?.multiple === true) {
        const current = selectedAnswers(match.data, awaiting.questionIndex);
        match.data.answersInProgress[awaiting.questionIndex] = current.includes(text)
          ? current
          : [...current, text];
        match.data.awaitingCustomFor = undefined;
        await ctx.bot.sendMessage(
          notice("✅", "커스텀 답변 추가", "선택을 마치면 Done을 눌러 제출해 주세요."),
        );
        await ctx.pendingQuestions.savePending(match.shortHash, match.data);
        await editPromptForQuestion(ctx, match.data, match.shortHash, awaiting.questionIndex);
        return;
      }
      match.data.answersInProgress[awaiting.questionIndex] = [text];
      match.data.awaitingCustomFor = undefined;
      await ctx.bot.sendMessage(notice("✅", "커스텀 답변 접수"));
      await completeIfReady(ctx, match.data, match.shortHash);
    },
  };
}
