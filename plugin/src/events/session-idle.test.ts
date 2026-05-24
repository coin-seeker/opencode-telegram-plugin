import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { EventSessionIdle, Session } from "@opencode-ai/sdk";
import type { TelegramBotManager } from "../bot.js";
import { createPendingPermissionStore, type PermissionReply } from "../lib/pending-permissions.js";
import { createPendingQuestionStore, type QuestionAnswer } from "../lib/pending-questions.js";
import { SessionTitleService } from "../services/session-title-service.js";
import { handleSessionIdle } from "./session-idle.js";
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

function createSession(id: string, title: string, parentID?: string): Session {
  return {
    id,
    projectID: "project-1",
    directory: "/tmp/project",
    parentID,
    title,
    version: "1",
    time: { created: 1, updated: 2 },
  };
}

function idleEvent(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } };
}

function createBot() {
  const sentMessages: string[] = [];
  const sentOptions: unknown[] = [];
  const bot: TelegramBotManager = {
    async start() {},
    async stop() {},
    async sendMessage(text, options) {
      sentMessages.push(text);
      sentOptions.push(options);
      return { message_id: sentMessages.length };
    },
    async sendQuestionWithKeyboard() {
      return { message_id: 1 };
    },
    async editMessage() {},
    async editMessageText() {},
    async editMessageRemoveKeyboard() {},
    async replyWithForceReply() {
      return { message_id: 1 };
    },
    async deleteMessage() {},
    async getActiveChatId() {
      return 1;
    },
    setQuestionDispatcher() {},
    setPermissionDispatcher() {},
  };
  return { bot, sentMessages, sentOptions };
}

function createContext(
  bot: TelegramBotManager,
  dir: string,
  service: SessionTitleService,
  childrenBySession: Record<string, Session[]> = {},
): EventHandlerContext {
  return {
    client: {
      session: {
        async get() {
          return { data: undefined };
        },
        async children(options: { path: { id: string } }) {
          return { data: childrenBySession[options.path.id] ?? [] };
        },
      },
    } as unknown as EventHandlerContext["client"],
    bot,
    sessionTitleService: service,
    stateStore: {} as EventHandlerContext["stateStore"],
    config: { botToken: "token", allowedUserIds: [1] },
    logger: createLogger(),
    claimsDir: join(dir, "claims"),
    pluginDir: dir,
    serverUrl: new URL("http://localhost:4096"),
    tokenHash: "tok",
    pendingQuestions: createPendingQuestionStore({
      tokenHash: "tok",
      baseDir: join(dir, "questions"),
    }),
    pendingPermissions: createPendingPermissionStore({
      tokenHash: "tok",
      baseDir: join(dir, "permissions"),
    }),
    idleRecheckDelayMs: 20,
    async replyToQuestion(_requestID: string, _answers: QuestionAnswer[]) {},
    async replyToPermission(_requestID: string, _sessionID: string, _reply: PermissionReply) {},
  };
}

describe("session idle notifications", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `session-idle-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("waits for checker child sessions created during root idle recheck", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent", "Plan builder"));
    const { bot, sentMessages, sentOptions } = createBot();
    const ctx = createContext(bot, join(dir, "race"), service);

    const parentIdle = handleSessionIdle(idleEvent("parent"), ctx);
    await new Promise((resolve) => setTimeout(resolve, 1));
    service.setSessionInfo(createSession("momus", "Momus accuracy check", "parent"));
    await parentIdle;

    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("parent"), true);

    await handleSessionIdle(idleEvent("momus"), ctx);

    assert.deepEqual(sentMessages, [
      "Agent has finished: Plan builder",
    ]);
    assert.equal(sentOptions[0], undefined);
    assert.equal(service.hasDeferredIdleNotification("parent"), false);
  });

  test("hydrates active checker children before sending root idle notification", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-hydrate", "Plan builder"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "hydrate"), service, {
      "parent-hydrate": [createSession("plan-check", "Plan checker", "parent-hydrate")],
      "plan-check": [createSession("momus-check", "Momus accuracy check", "plan-check")],
    });

    await handleSessionIdle(idleEvent("parent-hydrate"), ctx);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("parent-hydrate"), true);
    assert.equal(service.getParentID("momus-check"), "plan-check");
  });

  test("skips stale root idle notification if parent resumes during recheck", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-resume", "Plan builder"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "resume"), service);

    const parentIdle = handleSessionIdle(idleEvent("parent-resume"), ctx);
    await new Promise((resolve) => setTimeout(resolve, 1));
    service.setSessionStatus("parent-resume", "busy");
    await parentIdle;

    assert.deepEqual(sentMessages, []);
  });
});
