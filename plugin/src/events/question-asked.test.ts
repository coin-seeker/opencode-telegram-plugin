import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { EventQuestionAsked } from "@opencode-ai/sdk/v2";
import type { TelegramBotManager } from "../bot.js";
import { createPendingQuestionStore, createQuestionShortHash } from "../lib/pending-questions.js";
import { createQuestionDispatcher, handleQuestionAsked } from "./question-asked.js";
import type { EventHandlerContext, QuestionAnswer } from "./types.js";

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
  };
  return { bot, sentMessages, editedMessages };
}

function questionEvent(): EventQuestionAsked {
  return {
    id: "event-1",
    type: "question.asked",
    properties: {
      id: "que_test",
      sessionID: "ses_test",
      questions: [
        { header: "First", question: "First?", options: [{ label: "A", description: "A" }] },
        { header: "Second", question: "Second?", options: [{ label: "B", description: "B" }] },
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
    const pendingQuestions = createPendingQuestionStore({ tokenHash: "tok", baseDir: join(dir, "pending") });
    const replies: Array<{ requestID: string; answers: QuestionAnswer[] }> = [];
    const ctx: EventHandlerContext = {
      client: {} as EventHandlerContext["client"],
      bot,
      sessionTitleService: {} as EventHandlerContext["sessionTitleService"],
      stateStore: {} as EventHandlerContext["stateStore"],
      config: { botToken: "token", allowedUserIds: [1] },
      logger: createLogger(),
      claimsDir: join(dir, "claims"),
      pluginDir: dir,
      serverUrl: new URL("http://localhost:4096"),
      tokenHash: "tok",
      pendingQuestions,
      async replyToQuestion(requestID, answers) {
        replies.push({ requestID, answers });
      },
    };

    await handleQuestionAsked(questionEvent(), ctx);
    const shortHash = createQuestionShortHash("que_test");
    const dispatcher = createQuestionDispatcher(ctx);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:0:0`, 10, 1, 1);
    assert.equal(replies.length, 0);
    assert.deepEqual((await pendingQuestions.loadPending(shortHash))?.answersInProgress, [["A"], null]);
    assert.match(editedMessages.at(-1)?.text ?? "", /Second\?/);

    await dispatcher.handleCallbackQuery(`q:${shortHash}:1:0`, 10, 1, 1);
    assert.deepEqual(replies, [{ requestID: "que_test", answers: [["A"], ["B"]] }]);
    assert.equal(await pendingQuestions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /Answered/);
  });
});
