import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { EventQuestionAsked } from "@opencode-ai/sdk/v2";
import type { TelegramBotManager } from "../bot.js";
import { createPendingPermissionStore } from "../lib/pending-permissions.js";
import { createPendingQuestionStore, createQuestionShortHash } from "../lib/pending-questions.js";
import { createPendingStartWorkStore } from "../lib/pending-start-work.js";
import type { SessionRegistryStore } from "../lib/session-registry.js";
import { SessionTitleService } from "../services/session-title-service.js";
import { createQuestionDispatcher, handleQuestionAsked } from "./question-asked.js";
import type { EventHandlerContext, QuestionAnswer } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async flush() {},
    async close() {},
  };
}

function createBot() {
  const sentMessages: Array<{ text: string; options?: unknown }> = [];
  const editedMessages: Array<{ messageId: number; text: string; options?: unknown }> = [];
  let nextMessageId = 10;
  const bot: TelegramBotManager = {
    async start() {},
    async stop() {},
    isPolling() {
      return false;
    },
    async sendMessage(text, options) {
      sentMessages.push({ text, options });
      return { message_id: nextMessageId++ };
    },
    async sendQuestionWithKeyboard(question, callbackData) {
      sentMessages.push({ text: question.question, options: callbackData });
      return { message_id: nextMessageId++ };
    },
    async editMessage(messageId, text) {
      editedMessages.push({ messageId, text });
    },
    async editMessageText(messageId, text, options) {
      editedMessages.push({ messageId, text, options });
    },
    async editMessageRemoveKeyboard(messageId, finalText) {
      editedMessages.push({ messageId, text: finalText });
    },
    async replyWithForceReply(text, placeholder) {
      sentMessages.push({ text, options: placeholder });
      return { message_id: nextMessageId++ };
    },
    async deleteMessage() {},
    async getActiveChatId() {
      return 1;
    },
    setQuestionDispatcher() {},
    setPermissionDispatcher() {},
    setStartWorkDispatcher() {},
    setSessionsDispatcher() {},
    setStatusDispatcher() {},
    setStartWorkCommandDispatcher() {},
    setHelpDispatcher() {},
  };
  return { bot, sentMessages, editedMessages };
}

function createSessionRegistry(): SessionRegistryStore {
  return {
    async upsertSession() {},
    async updateSession() {},
    async listSessions() {
      return [];
    },
  };
}

function createContext(
  bot: TelegramBotManager,
  requestID: string,
  dir: string,
  replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }>,
): EventHandlerContext {
  return {
    client: {} as EventHandlerContext["client"],
    bot,
    sessionTitleService: new SessionTitleService(),
    stateStore: {} as EventHandlerContext["stateStore"],
    config: { botToken: "token", allowedUserIds: [1] },
    logger: createLogger(),
    claimsDir: join(dir, `claims-${requestID}`),
    pluginDir: dir,
    serverUrl: new URL("http://localhost:4096"),
    tokenHash: "tok",
    pendingQuestions: createPendingQuestionStore({
      tokenHash: "tok",
      baseDir: join(dir, `pending-${requestID}`),
    }),
    pendingPermissions: createPendingPermissionStore({
      tokenHash: "tok",
      baseDir: join(dir, `permissions-${requestID}`),
    }),
    pendingStartWorks: createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, `start-work-${requestID}`),
    }),
    sessionRegistry: createSessionRegistry(),
    async replyToQuestion(answeredRequestID, answers, serverUrl) {
      replies.push({ requestID: answeredRequestID, answers, serverUrl });
    },
    async replyToPermission() {},
    async runSessionCommand() {},
  };
}

function questionEvent(requestID = "que_test"): EventQuestionAsked {
  return {
    id: "event-1",
    type: "question.asked",
    properties: {
      id: requestID,
      sessionID: "ses_test",
      questions: [
        { header: "First", question: "First?", options: [{ label: "A", description: "A" }] },
        { header: "Second", question: "Second?", options: [{ label: "B", description: "B" }] },
      ],
    },
  };
}

function multipleQuestionEvent(requestID = "que_multiple"): EventQuestionAsked {
  return {
    id: `event-${requestID}`,
    type: "question.asked",
    properties: {
      id: requestID,
      sessionID: "ses_test",
      questions: [
        {
          header: "Pick",
          question: "Pick options?",
          multiple: true,
          options: [
            { label: "A", description: "First choice details" },
            { label: "B", description: "Second choice details" },
          ],
        },
      ],
    },
  };
}

function singleQuestionEvent(requestID = "que_single"): EventQuestionAsked {
  return {
    id: `event-${requestID}`,
    type: "question.asked",
    properties: {
      id: requestID,
      sessionID: "ses_test",
      questions: [{ header: "Only", question: "Only?", options: [{ label: "A", description: "A" }] }],
    },
  };
}

function mixedQuestionEvent(requestID = "que_mixed"): EventQuestionAsked {
  return {
    id: `event-${requestID}`,
    type: "question.asked",
    properties: {
      id: requestID,
      sessionID: "ses_test",
      questions: [
        {
          header: "Pick",
          question: "Pick options?",
          multiple: true,
          options: [
            { label: "A", description: "First choice details" },
            { label: "B", description: "Second choice details" },
          ],
        },
        { header: "Next", question: "Next?", options: [{ label: "C", description: "C" }] },
      ],
    },
  };
}

describe("question asked flow", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `question-flow-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("waits for all multi-question answers before replying", async () => {
    const { bot, editedMessages } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_test", dir, replies);

    await handleQuestionAsked(questionEvent(), ctx);
    const shortHash = createQuestionShortHash("que_test");
    const dispatcher = createQuestionDispatcher(ctx);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:0`, 10, 1, 1);
    assert.equal(replies.length, 0);
    assert.deepEqual((await ctx.pendingQuestions.loadPending(shortHash))?.answersInProgress, [
      ["A"],
      null,
    ]);
    assert.match(editedMessages.at(-1)?.text ?? "", /Second\?/);
    assert.doesNotMatch(editedMessages.at(-1)?.text ?? "", /All questions:/);
    assert.doesNotMatch(editedMessages.at(-1)?.text ?? "", /First\?/);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:1:0`, 10, 1, 1);
    assert.deepEqual(replies, [
      { requestID: "que_test", answers: [["A"], ["B"]], serverUrl: "http://localhost:4096/" },
    ]);
    assert.equal(await ctx.pendingQuestions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /Answered/);
  });

  test("stores source server URL for cross-process question replies", async () => {
    const { bot } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_source", dir, replies);
    ctx.serverUrl = new URL("http://localhost:5099/");

    await handleQuestionAsked(questionEvent("que_source"), ctx);

    const shortHash = createQuestionShortHash("que_source");
    const pending = await ctx.pendingQuestions.loadPending(shortHash);
    assert.equal(pending?.serverUrl, "http://localhost:5099/");
  });

  test("toggles multiple selections and waits for Done before replying", async () => {
    const { bot, sentMessages, editedMessages } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_multiple", dir, replies);

    await handleQuestionAsked(multipleQuestionEvent(), ctx);
    const shortHash = createQuestionShortHash("que_multiple");
    const dispatcher = createQuestionDispatcher(ctx);

    assert.match(sentMessages[0]?.text ?? "", /Pick options\?/);
    assert.match(sentMessages[0]?.text ?? "", /Options:\n\n1\. A/);
    assert.match(sentMessages[0]?.text ?? "", /설명: First choice details/);
    assert.match(sentMessages[0]?.text ?? "", /\n\n2\. B/);
    assert.match(sentMessages[0]?.text ?? "", /설명: Second choice details/);
    assert.deepEqual((await ctx.pendingQuestions.loadPending(shortHash))?.answersInProgress, [
      null,
    ]);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:0`, 10, 1, 1);
    assert.equal(replies.length, 0);
    assert.deepEqual((await ctx.pendingQuestions.loadPending(shortHash))?.answersInProgress, [
      ["A"],
    ]);
    assert.match(JSON.stringify(editedMessages.at(-1)?.options), /✅ A/);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:1`, 10, 1, 1);
    assert.equal(replies.length, 0);
    assert.deepEqual((await ctx.pendingQuestions.loadPending(shortHash))?.answersInProgress, [
      ["A", "B"],
    ]);
    assert.match(JSON.stringify(editedMessages.at(-1)?.options), /✅ B/);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:0`, 10, 1, 1);
    assert.deepEqual((await ctx.pendingQuestions.loadPending(shortHash))?.answersInProgress, [
      ["B"],
    ]);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:d`, 10, 1, 1);
    assert.deepEqual(replies, [
      { requestID: "que_multiple", answers: [["B"]], serverUrl: "http://localhost:4096/" },
    ]);
    assert.equal(await ctx.pendingQuestions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /Answered/);
  });

  test("adds custom multiple answers without replying until Done", async () => {
    const { bot, sentMessages } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_multiple_custom", dir, replies);

    await handleQuestionAsked(multipleQuestionEvent("que_multiple_custom"), ctx);
    const shortHash = createQuestionShortHash("que_multiple_custom");
    const dispatcher = createQuestionDispatcher(ctx);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:c`, 10, 1, 1);
    assert.match(sentMessages.at(-1)?.text ?? "", /Type your custom answer/);

    await dispatcher.handleTextReply("Custom", 1, 1, 11);
    assert.equal(replies.length, 0);
    assert.deepEqual((await ctx.pendingQuestions.loadPending(shortHash))?.answersInProgress, [
      ["Custom"],
    ]);
    assert.match(sentMessages.at(-1)?.text ?? "", /Custom answer added/);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:d`, 10, 1, 1);
    assert.deepEqual(replies, [
      {
        requestID: "que_multiple_custom",
        answers: [["Custom"]],
        serverUrl: "http://localhost:4096/",
      },
    ]);
  });

  test("accepts a custom reply after the original deadline once the user tapped Custom answer", async () => {
    const { bot, editedMessages } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_custom_refresh", dir, replies);

    await handleQuestionAsked(singleQuestionEvent("que_custom_refresh"), ctx);
    const shortHash = createQuestionShortHash("que_custom_refresh");
    const dispatcher = createQuestionDispatcher(ctx);

    const nearDeadlineMs = 1000;
    const pending = await ctx.pendingQuestions.loadPending(shortHash);
    assert.ok(pending);
    pending.expiresAt = Date.now() + nearDeadlineMs;
    await ctx.pendingQuestions.savePending(shortHash, pending);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:c`, 10, 1, 1);
    await sleep(nearDeadlineMs + 300);
    await dispatcher.handleTextReply("나의 커스텀 답변", 1, 1, 11);

    assert.deepEqual(replies, [
      {
        requestID: "que_custom_refresh",
        answers: [["나의 커스텀 답변"]],
        serverUrl: "http://localhost:4096/",
      },
    ]);
    assert.match(editedMessages.at(-1)?.text ?? "", /Answered/);
    assert.doesNotMatch(editedMessages.at(-1)?.text ?? "", /expired/i);
  });

  test("refreshes the expiry window when the user taps Custom answer", async () => {
    const { bot } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_custom_window", dir, replies);

    await handleQuestionAsked(singleQuestionEvent("que_custom_window"), ctx);
    const shortHash = createQuestionShortHash("que_custom_window");
    const dispatcher = createQuestionDispatcher(ctx);

    const pending = await ctx.pendingQuestions.loadPending(shortHash);
    assert.ok(pending);
    pending.expiresAt = Date.now() + 1000;
    await ctx.pendingQuestions.savePending(shortHash, pending);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:c`, 10, 1, 1);

    const refreshed = await ctx.pendingQuestions.loadPending(shortHash);
    assert.ok(refreshed);
    assert.ok(refreshed.expiresAt >= Date.now() + 4 * 60_000);
  });

  test("expires a genuinely stale question on the next interaction", async () => {
    const { bot, editedMessages } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_stale", dir, replies);

    await handleQuestionAsked(singleQuestionEvent("que_stale"), ctx);
    const shortHash = createQuestionShortHash("que_stale");
    const dispatcher = createQuestionDispatcher(ctx);

    const pending = await ctx.pendingQuestions.loadPending(shortHash);
    assert.ok(pending);
    pending.expiresAt = Date.now() - 1000;
    await ctx.pendingQuestions.savePending(shortHash, pending);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:0`, 10, 1, 1);

    assert.equal(replies.length, 0);
    assert.equal(await ctx.pendingQuestions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /expired/i);
  });

  test("submits mixed multi-select and single-select questions in order", async () => {
    const { bot, editedMessages } = createBot();
    const replies: Array<{ requestID: string; answers: QuestionAnswer[]; serverUrl?: string }> = [];
    const ctx = createContext(bot, "que_mixed", dir, replies);

    await handleQuestionAsked(mixedQuestionEvent(), ctx);
    const shortHash = createQuestionShortHash("que_mixed");
    const dispatcher = createQuestionDispatcher(ctx);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:0`, 10, 1, 1);
    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:1`, 10, 1, 1);
    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:d`, 10, 1, 1);
    assert.equal(replies.length, 0);
    assert.match(editedMessages.at(-1)?.text ?? "", /Next\?/);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:1:0`, 10, 1, 1);
    assert.deepEqual(replies, [
      { requestID: "que_mixed", answers: [["A", "B"], ["C"]], serverUrl: "http://localhost:4096/" },
    ]);
  });
});
