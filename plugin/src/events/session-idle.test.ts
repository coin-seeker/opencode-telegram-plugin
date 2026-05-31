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
import {
  createPendingStartWorkStore,
  createStartWorkShortHash,
} from "../lib/pending-start-work.js";
import type { SessionRegistryStore } from "../lib/session-registry.js";
import { SessionTitleService } from "../services/session-title-service.js";
import { agentFinishedMessage, handleSessionIdle } from "./session-idle.js";
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
    isPolling() {
      return false;
    },
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
    setStartWorkDispatcher() {},
    setSessionsDispatcher() {},
    setStatusDispatcher() {},
    setStartWorkCommandDispatcher() {},
    setHelpDispatcher() {},
  };
  return { bot, sentMessages, sentOptions };
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
  service: SessionTitleService,
  childrenBySession: Record<string, Session[]> = {},
  sessionsById: Record<string, Session> = {},
): EventHandlerContext {
  return {
    client: {
      session: {
        async get(options: { path: { id: string } }) {
          return { data: sessionsById[options.path.id] };
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
    idleRecheckDelayMs: 20,
    async replyToQuestion(_requestID: string, _answers: QuestionAnswer[]) {},
    async replyToPermission(_requestID: string, _sessionID: string, _reply: PermissionReply) {},
    async runSessionCommand() {},
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

    assert.deepEqual(sentMessages, []);
    assert.equal(sentOptions[0], undefined);
    assert.equal(service.hasDeferredIdleNotification("parent"), true);

    service.setSessionStatus("parent", "busy");
    await handleSessionIdle(idleEvent("parent"), ctx);

    assert.deepEqual(sentMessages, ["Agent has finished: Plan builder"]);
    assert.equal(service.hasDeferredIdleNotification("parent"), false);
  });

  test("sends deferred parent notification after a background child finishes while parent stays idle", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("bg-parent", "Background task"));
    service.setSessionInfo(createSession("bg-child", "Subagent", "bg-parent"));
    service.setSessionStatus("bg-child", "busy");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "bg-defer"), service, {
      "bg-parent": [createSession("bg-child", "Subagent", "bg-parent")],
    });
    ctx.deferredConfirmDelayMs = 20;

    await handleSessionIdle(idleEvent("bg-parent"), ctx);
    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("bg-parent"), true);

    service.setSessionStatus("bg-child", "idle");
    await handleSessionIdle(idleEvent("bg-child"), ctx);
    assert.deepEqual(sentMessages, []);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.deepEqual(sentMessages, ["Agent has finished: Background task"]);
    assert.equal(service.hasDeferredIdleNotification("bg-parent"), false);
  });

  test("suppresses first-seen child idle by fetching parentID before status cache writes", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-fetch", "Parent"));
    const { bot, sentMessages } = createBot();
    const child = createSession("child-fetch", "Child", "parent-fetch");
    const ctx = createContext(
      bot,
      join(dir, "first-seen-child"),
      service,
      {},
      {
        "child-fetch": child,
      },
    );

    await handleSessionIdle(idleEvent("child-fetch"), ctx);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.getParentID("child-fetch"), "parent-fetch");
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

  test("shows start-work button only when a root plan session finishes", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("plan-session", "Remove earnings estimate"));
    service.setSessionAgent("plan-session", "plan");
    const { bot, sentMessages, sentOptions } = createBot();
    const ctx = createContext(bot, join(dir, "plan-complete"), service);

    await handleSessionIdle(idleEvent("plan-session"), ctx);

    assert.deepEqual(sentMessages, ["plan 작성이 끝났어요.\n\nRemove earnings estimate"]);
    assert.match(JSON.stringify(sentOptions[0]), /Run \/start-work/);
    assert.ok(await ctx.pendingStartWorks.loadPending(createStartWorkShortHash("plan-session")));
  });

  test("shows start-work button when a Plan Builder session finishes", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("plan-builder-session", "CRM SaaS 전환 및 Status 서버 구축"));
    service.setSessionAgent("plan-builder-session", "Prometheus - Plan Builder");
    const { bot, sentMessages, sentOptions } = createBot();
    const ctx = createContext(bot, join(dir, "plan-builder-complete"), service);

    await handleSessionIdle(idleEvent("plan-builder-session"), ctx);

    assert.deepEqual(sentMessages, ["plan 작성이 끝났어요.\n\nCRM SaaS 전환 및 Status 서버 구축"]);
    assert.match(JSON.stringify(sentOptions[0]), /Run \/start-work/);
    assert.ok(await ctx.pendingStartWorks.loadPending(createStartWorkShortHash("plan-builder-session")));
  });

  test("does not show start-work button for non-plan root completion", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("build-session", "Build task"));
    service.setSessionAgent("build-session", "build");
    const { bot, sentMessages, sentOptions } = createBot();
    const ctx = createContext(bot, join(dir, "non-plan-complete"), service);

    await handleSessionIdle(idleEvent("build-session"), ctx);

    assert.deepEqual(sentMessages, ["Agent has finished: Build task (build)"]);
    assert.equal(sentOptions[0], undefined);
  });

  test("includes the agent name in the completion notification", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("general-session", "주식 admin 메뉴 정상화 계획"));
    service.setSessionAgent("general-session", "general");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "agent-name"), service);

    await handleSessionIdle(idleEvent("general-session"), ctx);

    assert.deepEqual(sentMessages, ["Agent has finished: 주식 admin 메뉴 정상화 계획 (general)"]);
  });

  test("omits the agent suffix when the agent is unknown", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("unknown-agent-session", "Untracked task"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "unknown-agent"), service);

    await handleSessionIdle(idleEvent("unknown-agent-session"), ctx);

    assert.deepEqual(sentMessages, ["Agent has finished: Untracked task"]);
  });
});

describe("agentFinishedMessage", () => {
  test("appends the agent name when both title and agent are known", () => {
    assert.equal(
      agentFinishedMessage("Backend DB migration 계획", "build"),
      "Agent has finished: Backend DB migration 계획 (build)",
    );
  });

  test("keeps the plain title message when the agent is unknown", () => {
    assert.equal(agentFinishedMessage("Build task", undefined), "Agent has finished: Build task");
  });

  test("shows the agent even when there is no title", () => {
    assert.equal(agentFinishedMessage(null, "build"), "Agent has finished. (build)");
  });

  test("falls back to the bare message when nothing is known", () => {
    assert.equal(agentFinishedMessage(null, undefined), "Agent has finished.");
  });
});
