import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { EventPermissionUpdated } from "@opencode-ai/sdk";
import type { EventPermissionAsked } from "@opencode-ai/sdk/v2";
import type { TelegramBotManager } from "../bot.js";
import {
  createPendingPermissionStore,
  createPermissionShortHash,
  type PermissionReply,
} from "../lib/pending-permissions.js";
import { createPendingQuestionStore, type QuestionAnswer } from "../lib/pending-questions.js";
import { createPendingStartWorkStore } from "../lib/pending-start-work.js";
import type { SessionRegistryStore } from "../lib/session-registry.js";
import { SessionTitleService } from "../services/session-title-service.js";
import {
  createPermissionDispatcher,
  handlePermissionAsked,
  handlePermissionReplied,
  handlePermissionUpdated,
  isEventPermissionAsked,
  isEventPermissionReplied,
} from "./permission-updated.js";
import type { EventHandlerContext } from "./types.js";

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
  dir: string,
  replies: Array<{
    requestID: string;
    sessionID: string;
    reply: PermissionReply;
    endpoint: "request" | "session";
    serverUrl?: string;
    directory?: string;
  }>,
): EventHandlerContext {
  return {
    client: {} as EventHandlerContext["client"],
    bot,
    sessionTitleService: new SessionTitleService(),
    stateStore: {} as EventHandlerContext["stateStore"],
    config: { botToken: "token", allowedUserIds: [1] },
    logger: createLogger(),
    claimsDir: join(dir, "claims"),
    pluginDir: dir,
    serverUrl: new URL("http://localhost:4096"),
    directory: dir,
    tokenHash: "tok",
    pendingQuestions: createPendingQuestionStore({
      tokenHash: "tok",
      baseDir: join(dir, "questions"),
    }),
    pendingPermissions: createPendingPermissionStore({
      tokenHash: "tok",
      baseDir: join(dir, "permissions"),
    }),
    pendingStartWorks: createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, "start-work"),
    }),
    sessionRegistry: createSessionRegistry(),
    async replyToQuestion(_requestID: string, _answers: QuestionAnswer[]) {},
    async replyToPermission(requestID, sessionID, reply, endpoint, serverUrl, directory) {
      const record = { requestID, sessionID, reply, endpoint, serverUrl };
      replies.push(directory === undefined ? record : { ...record, directory });
    },
    async runSessionCommand() {},
  };
}

function permissionAskedEvent(
  overrides: Partial<EventPermissionAsked["properties"]> = {},
): EventPermissionAsked {
  return {
    id: "event-permission-asked",
    type: "permission.asked",
    properties: {
      id: "per_asked",
      sessionID: "ses_test",
      permission: "read",
      patterns: [".env"],
      metadata: {},
      always: [".env"],
      ...overrides,
    },
  };
}

function permissionUpdatedEvent(
  overrides: Partial<EventPermissionUpdated["properties"]> = {},
): EventPermissionUpdated {
  return {
    type: "permission.updated",
    properties: {
      id: "per_updated",
      type: "read",
      pattern: ".env",
      sessionID: "ses_test",
      messageID: "msg_test",
      title: "Read .env",
      metadata: {},
      time: { created: Date.now() },
      ...overrides,
    },
  };
}

describe("permission updated flow", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `permission-flow-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("detects v2 permission asked events", () => {
    assert.equal(isEventPermissionAsked(permissionAskedEvent()), true);
    assert.equal(
      isEventPermissionAsked({ type: "permission.asked", properties: { id: "x" } }),
      false,
    );
  });

  test("sends v2 permission prompt and replies once from Telegram", async () => {
    const { bot, sentMessages, editedMessages } = createBot();
    const replies: Array<{
      requestID: string;
      sessionID: string;
      reply: PermissionReply;
      endpoint: "request" | "session";
      serverUrl?: string;
    }> = [];
    const ctx = createContext(bot, join(dir, "asked"), replies);

    await handlePermissionAsked(permissionAskedEvent(), ctx);
    const shortHash = createPermissionShortHash(
      "per_asked",
      "ses_test",
      "request",
      "http://localhost:4096/",
    );
    assert.match(sentMessages[0]?.text ?? "", /Permission requested/);
    assert.match(sentMessages[0]?.text ?? "", /\.env/);
    assert.match(JSON.stringify(sentMessages[0]?.options), /Allow once/);
    const pending = await ctx.pendingPermissions.loadPending(shortHash);
    assert.deepEqual(pending?.patterns, [".env"]);
    assert.equal(pending?.serverUrl, "http://localhost:4096/");
    assert.equal(pending?.directory, join(dir, "asked"));

    const dispatcher = createPermissionDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`p:${shortHash}:o`, 10);

    assert.deepEqual(replies, [
      {
        requestID: "per_asked",
        sessionID: "ses_test",
        reply: "once",
        endpoint: "request",
        serverUrl: "http://localhost:4096/",
        directory: join(dir, "asked"),
      },
    ]);
    assert.equal(await ctx.pendingPermissions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /Allowed once/);
  });

  test("sends legacy permission prompt and rejects from Telegram", async () => {
    const { bot, editedMessages } = createBot();
    const replies: Array<{
      requestID: string;
      sessionID: string;
      reply: PermissionReply;
      endpoint: "request" | "session";
      serverUrl?: string;
    }> = [];
    const ctx = createContext(bot, join(dir, "updated"), replies);

    await handlePermissionUpdated(permissionUpdatedEvent(), ctx);
    const shortHash = createPermissionShortHash(
      "per_updated",
      "ses_test",
      "session",
      "http://localhost:4096/",
    );
    const dispatcher = createPermissionDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`p:${shortHash}:r`, 10);

    assert.deepEqual(replies, [
      {
        requestID: "per_updated",
        sessionID: "ses_test",
        reply: "reject",
        endpoint: "session",
        serverUrl: "http://localhost:4096/",
        directory: join(dir, "updated"),
      },
    ]);
    assert.equal(await ctx.pendingPermissions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /Rejected/);
  });

  test("keeps same request id permissions separate across sessions", async () => {
    const { bot, sentMessages, editedMessages } = createBot();
    const replies: Array<{
      requestID: string;
      sessionID: string;
      reply: PermissionReply;
      endpoint: "request" | "session";
      serverUrl?: string;
    }> = [];
    const ctx = createContext(bot, join(dir, "same-id-sessions"), replies);

    await handlePermissionAsked(
      permissionAskedEvent({
        id: "per_shared",
        sessionID: "ses_one",
        patterns: ["one.env"],
        always: [],
      }),
      ctx,
    );
    await handlePermissionAsked(
      permissionAskedEvent({
        id: "per_shared",
        sessionID: "ses_two",
        patterns: ["two.env"],
        always: [],
      }),
      ctx,
    );

    const firstHash = createPermissionShortHash(
      "per_shared",
      "ses_one",
      "request",
      "http://localhost:4096/",
    );
    const secondHash = createPermissionShortHash(
      "per_shared",
      "ses_two",
      "request",
      "http://localhost:4096/",
    );
    assert.notEqual(firstHash, secondHash);
    assert.equal(sentMessages.length, 2);
    assert.equal((await ctx.pendingPermissions.loadPending(firstHash))?.sessionID, "ses_one");
    assert.equal((await ctx.pendingPermissions.loadPending(secondHash))?.sessionID, "ses_two");

    const dispatcher = createPermissionDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`p:${firstHash}:o`, 10);
    await dispatcher.handleCallbackQuery(`p:${secondHash}:r`, 11);

    assert.deepEqual(
      replies.map((reply) => [reply.requestID, reply.sessionID, reply.reply]),
      [
        ["per_shared", "ses_one", "once"],
        ["per_shared", "ses_two", "reject"],
      ],
    );
    assert.equal(editedMessages.length, 2);
  });

  test("deduplicates current and legacy events for the same permission", async () => {
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "current-legacy-dedupe"), []);

    await handlePermissionAsked(
      permissionAskedEvent({ id: "per_same", sessionID: "ses_same" }),
      ctx,
    );
    await handlePermissionUpdated(
      permissionUpdatedEvent({ id: "per_same", sessionID: "ses_same", title: "Read .env" }),
      ctx,
    );

    assert.equal(sentMessages.length, 1);
  });

  test("upgrades legacy pending permission when v2 asked event arrives later", async () => {
    const { bot, sentMessages, editedMessages } = createBot();
    const replies: Array<{
      requestID: string;
      sessionID: string;
      reply: PermissionReply;
      endpoint: "request" | "session";
      serverUrl?: string;
    }> = [];
    const ctx = createContext(bot, join(dir, "legacy-upgrade"), replies);

    await handlePermissionUpdated(
      permissionUpdatedEvent({
        id: "per_env_example",
        sessionID: "ses_env",
        title: "Read .env.example",
        pattern: ".env.example",
      }),
      ctx,
    );

    const legacyHash = createPermissionShortHash(
      "per_env_example",
      "ses_env",
      "session",
      "http://localhost:4096/",
    );
    assert.equal((await ctx.pendingPermissions.loadPending(legacyHash))?.endpoint, "session");

    await handlePermissionAsked(
      permissionAskedEvent({
        id: "per_env_example",
        sessionID: "ses_env",
        patterns: [".env.example"],
        always: [".env.example"],
      }),
      ctx,
    );

    const pending = await ctx.pendingPermissions.loadPending(legacyHash);
    assert.equal(sentMessages.length, 1);
    assert.equal(pending?.endpoint, "request");
    assert.deepEqual(pending?.patterns, [".env.example"]);
    assert.deepEqual(pending?.always, [".env.example"]);
    assert.equal(pending?.directory, join(dir, "legacy-upgrade"));

    const dispatcher = createPermissionDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`p:${legacyHash}:o`, 10);

    assert.deepEqual(replies, [
      {
        requestID: "per_env_example",
        sessionID: "ses_env",
        reply: "once",
        endpoint: "request",
        serverUrl: "http://localhost:4096/",
        directory: join(dir, "legacy-upgrade"),
      },
    ]);
    assert.match(editedMessages.at(-1)?.text ?? "", /Allowed once/);
  });

  test("detects v1 and v2 permission.replied events", () => {
    assert.equal(
      isEventPermissionReplied({
        type: "permission.replied",
        properties: { sessionID: "ses_test", permissionID: "per_v1", response: "once" },
      }),
      true,
    );
    assert.equal(
      isEventPermissionReplied({
        type: "permission.replied",
        properties: { sessionID: "ses_test", requestID: "per_v2", reply: "reject" },
      }),
      true,
    );
    assert.equal(
      isEventPermissionReplied({ type: "permission.replied", properties: { sessionID: "x" } }),
      false,
    );
    assert.equal(
      isEventPermissionReplied({
        type: "something.else",
        properties: { requestID: "x", sessionID: "y" },
      }),
      false,
    );
  });

  test("clears pending permission when replied outside Telegram (v2 requestID)", async () => {
    const { bot, editedMessages } = createBot();
    const ctx = createContext(bot, join(dir, "replied-v2"), []);
    const shortHash = createPermissionShortHash(
      "per_external",
      "ses_test",
      "request",
      "http://localhost:4096/",
    );

    await ctx.pendingPermissions.savePending(shortHash, {
      requestID: "per_external",
      sessionID: "ses_test",
      title: "Read .env",
      permission: "read",
      patterns: [".env"],
      always: [],
      serverUrl: "http://localhost:4096/",
      sentAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      telegramMessageId: 42,
      endpoint: "request",
    });

    await handlePermissionReplied(
      {
        type: "permission.replied",
        properties: { sessionID: "ses_test", requestID: "per_external", reply: "once" },
      },
      ctx,
    );

    assert.equal(await ctx.pendingPermissions.loadPending(shortHash), undefined);
    assert.equal(editedMessages.at(-1)?.messageId, 42);
    assert.match(editedMessages.at(-1)?.text ?? "", /Allowed once in opencode/);
  });

  test("clears pending permission when replied outside Telegram (v1 permissionID)", async () => {
    const { bot, editedMessages } = createBot();
    const ctx = createContext(bot, join(dir, "replied-v1"), []);
    const shortHash = createPermissionShortHash(
      "per_legacy",
      "ses_test",
      "session",
      "http://localhost:4096/",
    );

    await ctx.pendingPermissions.savePending(shortHash, {
      requestID: "per_legacy",
      sessionID: "ses_test",
      title: "Read .env",
      permission: "read",
      patterns: [".env"],
      always: [],
      serverUrl: "http://localhost:4096/",
      sentAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      telegramMessageId: 55,
      endpoint: "session",
    });

    await handlePermissionReplied(
      {
        type: "permission.replied",
        properties: { sessionID: "ses_test", permissionID: "per_legacy", response: "reject" },
      },
      ctx,
    );

    assert.equal(await ctx.pendingPermissions.loadPending(shortHash), undefined);
    assert.equal(editedMessages.at(-1)?.messageId, 55);
    assert.match(editedMessages.at(-1)?.text ?? "", /Rejected in opencode/);
  });

  test("permission.replied for unknown requestID is a no-op", async () => {
    const { bot, editedMessages } = createBot();
    const ctx = createContext(bot, join(dir, "replied-unknown"), []);

    await handlePermissionReplied(
      {
        type: "permission.replied",
        properties: { sessionID: "ses_test", requestID: "per_unknown", reply: "once" },
      },
      ctx,
    );

    assert.deepEqual(editedMessages, []);
  });

  test("late permission callbacks still attempt the opencode reply", async () => {
    const { bot, editedMessages } = createBot();
    const replies: Array<{
      requestID: string;
      sessionID: string;
      reply: PermissionReply;
      endpoint: "request" | "session";
      serverUrl?: string;
    }> = [];
    const ctx = createContext(bot, join(dir, "expired"), replies);
    const shortHash = createPermissionShortHash(
      "per_expired",
      "ses_test",
      "request",
      "http://localhost:4096/",
    );

    await ctx.pendingPermissions.savePending(shortHash, {
      requestID: "per_expired",
      sessionID: "ses_test",
      title: "Read .env",
      permission: "read",
      patterns: [".env"],
      always: [],
      serverUrl: "http://localhost:4096/",
      sentAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1_000,
      telegramMessageId: 10,
      endpoint: "request",
    });

    const dispatcher = createPermissionDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`p:${shortHash}:a`, 10);

    assert.deepEqual(replies, [
      {
        requestID: "per_expired",
        sessionID: "ses_test",
        reply: "always",
        endpoint: "request",
        serverUrl: "http://localhost:4096/",
      },
    ]);
    assert.equal(await ctx.pendingPermissions.loadPending(shortHash), undefined);
    assert.match(editedMessages.at(-1)?.text ?? "", /Always allowed/);
  });
});
