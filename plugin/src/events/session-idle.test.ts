import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
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
import {
  agentFinishedMessage,
  handleSessionIdle,
  handleSessionStatus,
  hasStartWorkCommandInstruction,
  resetSessionIdleTimersForTest,
} from "./session-idle.js";
import type { EventHandlerContext } from "./types.js";

type TestMessageEnvelope = {
  info: { role: string };
  parts: Array<{ type: string; text?: string }>;
};

type TestStatusEntry = { type: "busy" | "idle" | "retry" };

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

function assistantMessage(text: string): TestMessageEnvelope {
  return { info: { role: "assistant" }, parts: [{ type: "text", text }] };
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
  messagesBySession: Record<string, TestMessageEnvelope[]> = {},
  statusesBySession: Record<string, TestStatusEntry> = {},
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
        async messages(options: { path: { id: string }; query?: { limit?: number } }) {
          return { data: messagesBySession[options.path.id] ?? [] };
        },
        async status() {
          return { data: statusesBySession };
        },
      },
    } as unknown as EventHandlerContext["client"],
    bot,
    sessionTitleService: service,
    stateStore: {} as EventHandlerContext["stateStore"],
    config: { botToken: "token", allowedUserIds: [1], idleSettleDelayMs: 40 },
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
    deferredConfirmDelayMs: 20,
    idleSettleDelayMs: 40,
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

  afterEach(() => {
    resetSessionIdleTimersForTest();
  });

  test("suppresses child session idle and resolves parentID without notifying", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-fetch", "Parent"));
    const { bot, sentMessages } = createBot();
    const child = createSession("child-fetch", "Child", "parent-fetch");
    const ctx = createContext(
      bot,
      join(dir, "first-seen-child"),
      service,
      {},
      { "child-fetch": child },
    );

    await handleSessionIdle(idleEvent("child-fetch"), ctx);
    await sleep(80);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.getParentID("child-fetch"), "parent-fetch");
  });

  test("S1: suppresses the OMO continuation race (child idle then parent re-triggered within settle window)", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("race-parent", "Race parent"));
    service.setSessionInfo(createSession("race-child", "Subagent", "race-parent"));
    service.setSessionStatus("race-child", "busy");
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = { "race-child": { type: "busy" } };
    const ctx = createContext(
      bot,
      join(dir, "omo-race"),
      service,
      { "race-parent": [createSession("race-child", "Subagent", "race-parent")] },
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 120;

    await handleSessionIdle(idleEvent("race-parent"), ctx);
    assert.deepEqual(sentMessages, []);

    service.setSessionStatus("race-child", "idle");
    statuses["race-child"] = { type: "idle" };
    await handleSessionIdle(idleEvent("race-child"), ctx);

    await sleep(50);
    statuses["race-parent"] = { type: "busy" };
    service.setSessionStatus("race-parent", "busy");

    await sleep(160);

    assert.deepEqual(sentMessages, []);
  });

  test("S2: sends the deferred parent notification only after sustained quiet", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("bg-parent", "Background task"));
    service.setSessionInfo(createSession("bg-child", "Subagent", "bg-parent"));
    service.setSessionStatus("bg-child", "busy");
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = { "bg-child": { type: "busy" } };
    const ctx = createContext(
      bot,
      join(dir, "bg-defer"),
      service,
      { "bg-parent": [createSession("bg-child", "Subagent", "bg-parent")] },
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 60;

    await handleSessionIdle(idleEvent("bg-parent"), ctx);
    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("bg-parent"), true);

    service.setSessionStatus("bg-child", "idle");
    statuses["bg-child"] = { type: "idle" };
    await handleSessionIdle(idleEvent("bg-child"), ctx);

    await sleep(40);
    assert.deepEqual(sentMessages, []);

    await sleep(110);
    assert.deepEqual(sentMessages, ["Agent has finished: Background task"]);
    assert.equal(service.hasDeferredIdleNotification("bg-parent"), false);
  });

  test("S3: starts the settle window at the descendants-quiet boundary, not the original root idle", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("boundary-parent", "Boundary parent"));
    service.setSessionInfo(createSession("boundary-child", "Subagent", "boundary-parent"));
    service.setSessionStatus("boundary-child", "busy");
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = { "boundary-child": { type: "busy" } };
    const ctx = createContext(
      bot,
      join(dir, "boundary"),
      service,
      { "boundary-parent": [createSession("boundary-child", "Subagent", "boundary-parent")] },
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 80;

    await handleSessionIdle(idleEvent("boundary-parent"), ctx);
    await sleep(150);
    assert.deepEqual(sentMessages, []);

    service.setSessionStatus("boundary-child", "idle");
    statuses["boundary-child"] = { type: "idle" };
    await handleSessionIdle(idleEvent("boundary-child"), ctx);

    await sleep(40);
    assert.deepEqual(sentMessages, []);

    await sleep(120);
    assert.deepEqual(sentMessages, ["Agent has finished: Boundary parent"]);
  });

  test("S4: delays a quick root task by the settle window then delivers it", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("solo", "Quick task"));
    service.setSessionAgent("solo", "build");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "quick"), service);
    ctx.idleSettleDelayMs = 60;

    await handleSessionIdle(idleEvent("solo"), ctx);
    await sleep(30);
    assert.deepEqual(sentMessages, []);

    await sleep(80);
    assert.deepEqual(sentMessages, ["Agent has finished: Quick task (build)"]);
  });

  test("S5: a root resume during the settle window restarts the window", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("reset-root", "Resettable"));
    service.setSessionAgent("reset-root", "build");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "reset-window"), service);
    ctx.idleSettleDelayMs = 80;

    await handleSessionIdle(idleEvent("reset-root"), ctx);
    await sleep(30);
    service.setSessionStatus("reset-root", "busy");
    await sleep(5);
    await handleSessionIdle(idleEvent("reset-root"), ctx);

    await sleep(60);
    assert.deepEqual(sentMessages, []);

    await sleep(70);
    assert.deepEqual(sentMessages, ["Agent has finished: Resettable (build)"]);
    assert.equal(sentMessages.length, 1);
  });

  test("S6: child activity during the parent settle window re-defers until it finishes", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("late-parent", "Late parent"));
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = {};
    const childrenBySession: Record<string, Session[]> = {};
    const ctx = createContext(
      bot,
      join(dir, "late-child"),
      service,
      childrenBySession,
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 60;

    await handleSessionIdle(idleEvent("late-parent"), ctx);
    await sleep(20);

    service.setSessionInfo(createSession("late-child", "Subagent", "late-parent"));
    service.setSessionStatus("late-child", "busy");
    statuses["late-child"] = { type: "busy" };
    childrenBySession["late-parent"] = [createSession("late-child", "Subagent", "late-parent")];

    await sleep(70);
    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("late-parent"), true);

    service.setSessionStatus("late-child", "idle");
    statuses["late-child"] = { type: "idle" };
    await handleSessionIdle(idleEvent("late-child"), ctx);

    await sleep(150);
    assert.deepEqual(sentMessages, ["Agent has finished: Late parent"]);
  });

  test("S7a: a plan session without a start-work instruction is not notified after settle", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("plan-still-writing", "Portfolio trading plan"));
    service.setSessionAgent("plan-still-writing", "Prometheus - Plan Builder");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "plan-still-writing"),
      service,
      {},
      {},
      { "plan-still-writing": [assistantMessage("Research subagents are still running.")] },
    );
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("plan-still-writing"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, []);
    assert.equal(
      await ctx.pendingStartWorks.loadPending(createStartWorkShortHash("plan-still-writing")),
      undefined,
    );
  });

  test("S7b: a plan session with a start-work instruction sends the plan completion after settle", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("plan-session", "Remove earnings estimate"));
    service.setSessionAgent("plan-session", "plan");
    const { bot, sentMessages, sentOptions } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "plan-complete"),
      service,
      {},
      {},
      { "plan-session": [assistantMessage("Plan ready. Use /start_work 1 to execute it.")] },
    );
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("plan-session"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["plan 작성이 끝났어요.\n\nRemove earnings estimate"]);
    assert.equal(sentOptions[0], undefined);
    assert.equal(
      (await ctx.pendingStartWorks.loadPending(createStartWorkShortHash("plan-session")))?.status,
      "consumed",
    );
  });

  test("S8: duplicate idle events do not produce duplicate notifications", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("dup", "Dup task"));
    service.setSessionAgent("dup", "build");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "dup"), service);
    ctx.idleSettleDelayMs = 50;

    await handleSessionIdle(idleEvent("dup"), ctx);
    await handleSessionIdle(idleEvent("dup"), ctx);

    await sleep(120);
    assert.deepEqual(sentMessages, ["Agent has finished: Dup task (build)"]);

    await handleSessionIdle(idleEvent("dup"), ctx);
    await sleep(80);
    assert.equal(sentMessages.length, 1);
  });

  test("S9: a descendant that becomes active during the settle window re-defers the parent", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("win-parent", "Window parent"));
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = {};
    const children: Record<string, Session[]> = {};
    const ctx = createContext(
      bot,
      join(dir, "descendant-in-window"),
      service,
      children,
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 80;

    await handleSessionIdle(idleEvent("win-parent"), ctx);

    await sleep(20);
    service.setSessionInfo(createSession("win-child", "Subagent", "win-parent"));
    children["win-parent"] = [createSession("win-child", "Subagent", "win-parent")];
    statuses["win-child"] = { type: "busy" };
    await handleSessionStatus(
      { type: "session.status", properties: { sessionID: "win-child", status: { type: "busy" } } },
      ctx,
    );
    assert.equal(service.hasDeferredIdleNotification("win-parent"), true);

    await sleep(100);
    assert.deepEqual(sentMessages, []);

    service.setSessionStatus("win-child", "idle");
    statuses["win-child"] = { type: "idle" };
    await handleSessionIdle(idleEvent("win-child"), ctx);

    await sleep(160);
    assert.deepEqual(sentMessages, ["Agent has finished: Window parent"]);
  });

  test("S10: a busy observed during the confirm status fetch is not overridden by a stale live-idle", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("stale-root", "Stale root"));
    service.setSessionAgent("stale-root", "build");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "stale-idle"), service);
    ctx.idleSettleDelayMs = 40;
    let statusCalls = 0;
    ctx.client = {
      session: {
        async get() {
          return { data: undefined };
        },
        async children() {
          return { data: [] };
        },
        async messages() {
          return { data: [] };
        },
        async status() {
          statusCalls += 1;
          if (statusCalls >= 2) service.setSessionStatus("stale-root", "busy");
          return { data: { "stale-root": { type: "idle" as const } } };
        },
      },
    } as unknown as EventHandlerContext["client"];

    await handleSessionIdle(idleEvent("stale-root"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, []);
  });

  test("S11: a resume during the pre-send agent resolution aborts the notification", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("gap-root", "Gap root"));
    service.setSessionAgent("gap-root", "build");
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = {};
    const ctx = createContext(bot, join(dir, "send-gap"), service, {}, {}, {}, statuses);
    ctx.idleSettleDelayMs = 40;
    ctx.client = {
      session: {
        async get() {
          statuses["gap-root"] = { type: "busy" };
          return { data: undefined };
        },
        async children() {
          return { data: [] };
        },
        async messages() {
          return { data: [] };
        },
        async status() {
          return { data: statuses };
        },
      },
    } as unknown as EventHandlerContext["client"];

    await handleSessionIdle(idleEvent("gap-root"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, []);
  });

  test("S12: a plan bookkeeping failure after a successful send still records the send", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("plan-flaky", "Flaky plan"));
    service.setSessionAgent("plan-flaky", "plan");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "plan-flaky"),
      service,
      {},
      {},
      {
        "plan-flaky": [assistantMessage("Plan ready. Use /start_work 1.")],
      },
    );
    ctx.idleSettleDelayMs = 40;
    ctx.pendingStartWorks = {
      async loadPending() {
        return undefined;
      },
      async savePending() {
        throw new Error("disk full");
      },
      async deletePending() {},
    } as unknown as typeof ctx.pendingStartWorks;

    await handleSessionIdle(idleEvent("plan-flaky"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["plan 작성이 끝났어요.\n\nFlaky plan"]);
    assert.equal(service.hasIdleNotificationSent("plan-flaky"), true);
  });

  test("S13: a descendant that becomes busy during the pre-send gap aborts the notification", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("g2-root", "Gap2 root"));
    service.setSessionAgent("g2-root", "build");
    service.setSessionInfo(createSession("g2-child", "Subagent", "g2-root"));
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = {};
    const children: Record<string, Session[]> = {
      "g2-root": [createSession("g2-child", "Subagent", "g2-root")],
    };
    const ctx = createContext(
      bot,
      join(dir, "gap-descendant"),
      service,
      children,
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 1000;
    ctx.idleSettleDelayMs = 40;
    ctx.client = {
      session: {
        async get() {
          statuses["g2-child"] = { type: "busy" };
          return { data: undefined };
        },
        async children(o: { path: { id: string } }) {
          return { data: children[o.path.id] ?? [] };
        },
        async messages() {
          return { data: [] };
        },
        async status() {
          return { data: statuses };
        },
      },
    } as unknown as EventHandlerContext["client"];

    await handleSessionIdle(idleEvent("g2-root"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("g2-root"), true);
  });

  test("S14: a finished child absent from the live status map does not permanently defer the parent", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("dis-root", "Disappearing child root"));
    service.setSessionInfo(createSession("dis-child", "Subagent", "dis-root"));
    service.setSessionStatus("dis-child", "busy");
    const { bot, sentMessages } = createBot();
    const statuses: Record<string, TestStatusEntry> = { "dis-child": { type: "busy" } };
    const children: Record<string, Session[]> = {
      "dis-root": [createSession("dis-child", "Subagent", "dis-root")],
    };
    const ctx = createContext(bot, join(dir, "disappearing"), service, children, {}, {}, statuses);
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("dis-root"), ctx);
    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("dis-root"), true);

    delete statuses["dis-child"];

    await sleep(200);
    assert.deepEqual(sentMessages, ["Agent has finished: Disappearing child root"]);
  });

  test("defers when a checker grandchild is still running", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-hydrate", "Plan builder"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "hydrate"),
      service,
      {
        "parent-hydrate": [createSession("plan-check", "Plan checker", "parent-hydrate")],
        "plan-check": [createSession("momus-check", "Momus accuracy check", "plan-check")],
      },
      {},
      {},
      {
        "plan-check": { type: "idle" },
        "momus-check": { type: "busy" },
      },
    );

    await handleSessionIdle(idleEvent("parent-hydrate"), ctx);
    await sleep(80);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("parent-hydrate"), true);
    assert.equal(service.getParentID("momus-check"), "plan-check");
  });

  test("sends after settle when hydrated children are all idle", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-live-idle", "Live idle children"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "live-idle-children"), service, {
      "parent-live-idle": [createSession("child-live-idle", "Finished child", "parent-live-idle")],
    });
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("parent-live-idle"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["Agent has finished: Live idle children"]);
    assert.equal(service.hasDeferredIdleNotification("parent-live-idle"), false);
  });

  test("rechecks a deferred parent when a child status flips to idle without a child idle event", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-poll", "Polling parent"));
    const statuses: Record<string, TestStatusEntry> = { "child-poll": { type: "busy" } };
    const { bot, sentMessages } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "poll-deferred"),
      service,
      { "parent-poll": [createSession("child-poll", "Polling child", "parent-poll")] },
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("parent-poll"), ctx);
    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("parent-poll"), true);

    statuses["child-poll"] = { type: "idle" };
    await sleep(150);

    assert.deepEqual(sentMessages, ["Agent has finished: Polling parent"]);
    assert.equal(service.hasDeferredIdleNotification("parent-poll"), false);
  });

  test("skips a stale root idle notification if the parent resumes (cached busy)", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-resume", "Plan builder"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "resume"), service);
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("parent-resume"), ctx);
    service.setSessionStatus("parent-resume", "busy");
    await sleep(90);

    assert.deepEqual(sentMessages, []);
  });

  test("skips a stale root idle notification if the live status map reports busy", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-live-busy", "Resumed parent"));
    const statuses: Record<string, TestStatusEntry> = {};
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "parent-live-busy"), service, {}, {}, {}, statuses);
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("parent-live-busy"), ctx);
    statuses["parent-live-busy"] = { type: "busy" };
    await sleep(90);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.getSessionStatus("parent-live-busy"), "busy");
  });

  test("clears a deferred parent when the live status resumes during confirm", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent-confirm-busy", "Confirm parent"));
    const statuses: Record<string, TestStatusEntry> = { "child-confirm-busy": { type: "busy" } };
    const { bot, sentMessages } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "parent-confirm-busy"),
      service,
      {
        "parent-confirm-busy": [
          createSession("child-confirm-busy", "Confirm child", "parent-confirm-busy"),
        ],
      },
      {},
      {},
      statuses,
    );
    ctx.deferredConfirmDelayMs = 20;
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("parent-confirm-busy"), ctx);
    assert.deepEqual(sentMessages, []);
    assert.equal(service.hasDeferredIdleNotification("parent-confirm-busy"), true);

    statuses["parent-confirm-busy"] = { type: "busy" };
    statuses["child-confirm-busy"] = { type: "idle" };
    await sleep(150);

    assert.deepEqual(sentMessages, []);
    assert.equal(service.getSessionStatus("parent-confirm-busy"), "busy");
    assert.equal(service.hasDeferredIdleNotification("parent-confirm-busy"), false);
  });

  test("does not show a start-work button for a non-plan root completion", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("build-session", "Build task"));
    service.setSessionAgent("build-session", "build");
    const { bot, sentMessages, sentOptions } = createBot();
    const ctx = createContext(bot, join(dir, "non-plan-complete"), service);
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("build-session"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["Agent has finished: Build task (build)"]);
    assert.equal(sentOptions[0], undefined);
  });

  test("includes the agent name in the completion notification", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("general-session", "주식 admin 메뉴 정상화 계획"));
    service.setSessionAgent("general-session", "general");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "agent-name"), service);
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("general-session"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["Agent has finished: 주식 admin 메뉴 정상화 계획 (general)"]);
  });

  test("omits the agent suffix when the agent is unknown", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("unknown-agent-session", "Untracked task"));
    const { bot, sentMessages } = createBot();
    const ctx = createContext(bot, join(dir, "unknown-agent"), service);
    ctx.idleSettleDelayMs = 40;

    await handleSessionIdle(idleEvent("unknown-agent-session"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["Agent has finished: Untracked task"]);
  });

  test("uses the registry Plan Builder agent when the local cache holds a stale raw agent", async () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("registry-plan-session", "Registry-backed plan"));
    service.setSessionAgent("registry-plan-session", "build");
    const { bot, sentMessages } = createBot();
    const ctx = createContext(
      bot,
      join(dir, "registry-plan-complete"),
      service,
      {},
      {},
      { "registry-plan-session": [assistantMessage("Ready for execution: /start_work 1")] },
    );
    ctx.idleSettleDelayMs = 40;
    ctx.sessionRegistry = {
      async upsertSession() {},
      async updateSession() {},
      async listSessions() {
        return [
          {
            sessionId: "registry-plan-session",
            title: "Registry-backed plan",
            parentID: null,
            agent: "Prometheus - Plan Builder",
            serverUrl: "http://localhost:4096/",
            updatedAt: Date.now(),
          },
        ];
      },
    };

    await handleSessionIdle(idleEvent("registry-plan-session"), ctx);
    await sleep(120);

    assert.deepEqual(sentMessages, ["plan 작성이 끝났어요.\n\nRegistry-backed plan"]);
  });
});

describe("hasStartWorkCommandInstruction", () => {
  test("matches Telegram and OpenCode start-work command spellings", () => {
    assert.equal(hasStartWorkCommandInstruction("Run /start_work 1"), true);
    assert.equal(hasStartWorkCommandInstruction("Use /start-work now"), true);
    assert.equal(hasStartWorkCommandInstruction("start_work is available"), true);
    assert.equal(hasStartWorkCommandInstruction("Research is still running"), false);
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
