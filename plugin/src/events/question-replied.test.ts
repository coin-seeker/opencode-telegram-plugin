import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import { createPendingPermissionStore } from "../lib/pending-permissions.js";
import {
  createPendingQuestionStore,
  createQuestionShortHash,
  type PendingQuestionState,
} from "../lib/pending-questions.js";
import { createPendingStartWorkStore } from "../lib/pending-start-work.js";
import { SessionTitleService } from "../services/session-title-service.js";
import { handleQuestionReplied } from "./question-replied.js";
import type { EventHandlerContext } from "./types.js";

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

function createBot(failEdit = false) {
  const sentMessages: string[] = [];
  const editedMessages: Array<{ messageId: number; text: string }> = [];
  const bot: TelegramBotManager = {
    async start() {},
    async stop() {},
    isPolling() {
      return false;
    },
    async sendMessage(text) {
      sentMessages.push(text);
      return { message_id: 99 };
    },
    async sendQuestionWithKeyboard() {
      return { message_id: 98 };
    },
    async editMessage() {},
    async editMessageText() {},
    async editMessageRemoveKeyboard(messageId, finalText) {
      if (failEdit) throw new Error("message can't be edited");
      editedMessages.push({ messageId, text: finalText });
    },
    async replyWithForceReply() {
      return { message_id: 97 };
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

function createContext(bot: TelegramBotManager, name: string, dir: string): EventHandlerContext {
  return {
    client: {} as EventHandlerContext["client"],
    bot,
    sessionTitleService: new SessionTitleService(),
    stateStore: {} as EventHandlerContext["stateStore"],
    config: { botToken: "token", allowedUserIds: [1], idleSettleDelayMs: 40 },
    logger: createLogger(),
    claimsDir: join(dir, `claims-${name}`),
    pluginDir: dir,
    processInstanceID: "owner-instance",
    processID: 100,
    serverUrl: new URL("http://localhost:4096"),
    directory: dir,
    tokenHash: "tok",
    pendingQuestions: createPendingQuestionStore({
      tokenHash: "tok",
      baseDir: join(dir, `pending-${name}`),
    }),
    pendingPermissions: createPendingPermissionStore({
      tokenHash: "tok",
      baseDir: join(dir, `permissions-${name}`),
    }),
    pendingStartWorks: createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, `start-work-${name}`),
    }),
    sessionRegistry: {
      async upsertSession() {},
      async updateSession() {},
      async listSessions() {
        return [];
      },
    },
    async replyToQuestion() {},
    async replyToPermission() {},
    async runSessionCommand() {},
  };
}

function pendingState(requestID: string): PendingQuestionState {
  const now = Date.now();
  return {
    requestID,
    sessionID: "ses_test",
    serverUrl: "http://localhost:4096/",
    questions: [
      { header: "Deploy?", question: "Deploy now?", options: [{ label: "A", description: "" }] },
    ],
    sentAt: now,
    expiresAt: now + 60_000,
    telegramMessageIds: [42],
    currentQuestionIndex: 0,
    answersInProgress: [null],
  };
}

function repliedEvent(requestID: string, sessionID = "ses_test") {
  return {
    id: `event-${requestID}`,
    type: "question.replied" as const,
    properties: { sessionID, requestID, answers: [["A"]] },
  };
}

describe("question replied handling", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `question-replied-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("retries lookup so a reply racing the question send still clears the message", async () => {
    const { bot, editedMessages } = createBot();
    const ctx = createContext(bot, "race", dir);
    const shortHash = createQuestionShortHash("que_race", "ses_test", "http://localhost:4096/");

    const handled = handleQuestionReplied(repliedEvent("que_race"), ctx, {
      retryDelaysMs: [0, 40, 80, 160],
    });
    await sleep(60);
    // Simulate handleQuestionAsked finishing its slow Telegram send AFTER the replied event.
    await ctx.pendingQuestions.savePending(shortHash, pendingState("que_race"));
    await handled;

    assert.equal(editedMessages.length, 1);
    assert.equal(editedMessages[0]?.messageId, 42);
    assert.match(editedMessages[0]?.text ?? "", /답변 완료/);
    assert.equal(await ctx.pendingQuestions.loadPending(shortHash), undefined);
  });

  test("falls back to a fresh message when the question edit fails", async () => {
    const { bot, sentMessages } = createBot(true);
    const ctx = createContext(bot, "editfail", dir);
    const shortHash = createQuestionShortHash("que_editfail", "ses_test", "http://localhost:4096/");
    await ctx.pendingQuestions.savePending(shortHash, pendingState("que_editfail"));

    await handleQuestionReplied(repliedEvent("que_editfail"), ctx, { retryDelaysMs: [0] });

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0] ?? "", /답변 완료/);
    assert.match(sentMessages[0] ?? "", /Deploy\?/);
    assert.equal(await ctx.pendingQuestions.loadPending(shortHash), undefined);
  });

  test("handles each replied event once across duplicate deliveries", async () => {
    const { bot, editedMessages } = createBot();
    const ctx = createContext(bot, "dedup", dir);
    const shortHash = createQuestionShortHash("que_dedup", "ses_test", "http://localhost:4096/");
    await ctx.pendingQuestions.savePending(shortHash, pendingState("que_dedup"));

    await handleQuestionReplied(repliedEvent("que_dedup"), ctx, { retryDelaysMs: [0] });
    await handleQuestionReplied(repliedEvent("que_dedup"), ctx, { retryDelaysMs: [0] });

    assert.equal(editedMessages.length, 1);
  });

  test("ignores replies for a different session without touching pending state", async () => {
    const { bot, editedMessages, sentMessages } = createBot();
    const ctx = createContext(bot, "mismatch", dir);
    const shortHash = createQuestionShortHash("que_mismatch", "ses_test", "http://localhost:4096/");
    await ctx.pendingQuestions.savePending(shortHash, pendingState("que_mismatch"));

    await handleQuestionReplied(repliedEvent("que_mismatch", "ses_other"), ctx, {
      retryDelaysMs: [0],
    });

    assert.equal(editedMessages.length, 0);
    assert.equal(sentMessages.length, 0);
    assert.ok(await ctx.pendingQuestions.loadPending(shortHash));
  });
});
