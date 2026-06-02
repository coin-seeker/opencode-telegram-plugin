/**
 * Manual QA harness for the idle-settle-window fix.
 *
 * Replays the real production timeline captured in the plugin log:
 *   - a background subagent (child) finishes, the root looks idle, then
 *   - oh-my-opencode re-triggers the root ~6s later via OMO_INTERNAL_INITIATOR.
 *
 * Case A uses the REAL default settle window (12000ms) to prove the default
 * value actually covers the observed ~6s re-trigger latency and suppresses the
 * false "Agent has finished" notification. Case B proves a genuinely finished
 * root still delivers exactly one notification.
 *
 * Run: npx tsx qa/idle-settle-race.ts
 */
import type { Session } from "@opencode-ai/sdk";
import {
  handleSessionIdle,
  handleSessionStatus,
  resetSessionIdleTimersForTest,
} from "../src/events/session-idle.js";
import type { EventHandlerContext } from "../src/events/types.js";
import { SessionTitleService } from "../src/services/session-title-service.js";

type StatusEntry = { type: "busy" | "idle" | "retry" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function session(id: string, title: string, parentID?: string): Session {
  return {
    id,
    projectID: "p",
    directory: "/tmp/p",
    parentID,
    title,
    version: "1",
    time: { created: 1, updated: 2 },
  };
}

function makeCtx(
  sentMessages: string[],
  service: SessionTitleService,
  children: Record<string, Session[]>,
  statuses: Record<string, StatusEntry>,
  overrides: Partial<EventHandlerContext>,
): EventHandlerContext {
  const noopLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async flush() {},
    async close() {},
  };
  return {
    client: {
      session: {
        async get() {
          return { data: undefined as unknown as Session };
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
    } as unknown as EventHandlerContext["client"],
    bot: {
      async sendMessage(text: string) {
        sentMessages.push(text);
        return { message_id: sentMessages.length };
      },
    } as unknown as EventHandlerContext["bot"],
    sessionTitleService: service,
    stateStore: {} as EventHandlerContext["stateStore"],
    config: { botToken: "t", allowedUserIds: [1], idleSettleDelayMs: 12000 },
    logger: noopLogger as unknown as EventHandlerContext["logger"],
    claimsDir: `/tmp/qa-claims-${Math.random().toString(36).slice(2)}`,
    pluginDir: "/tmp",
    serverUrl: new URL("http://localhost:4096"),
    directory: "/tmp",
    tokenHash: "tok",
    pendingQuestions: {} as EventHandlerContext["pendingQuestions"],
    pendingPermissions: {} as EventHandlerContext["pendingPermissions"],
    pendingStartWorks: {} as EventHandlerContext["pendingStartWorks"],
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
    ...overrides,
  };
}

async function caseA(): Promise<boolean> {
  resetSessionIdleTimersForTest();
  const sent: string[] = [];
  const service = new SessionTitleService();
  service.setSessionInfo(session("root", "빠른 인사"));
  service.setSessionInfo(session("child", "Explore Task", "root"));
  service.setSessionStatus("child", "busy");
  const statuses: Record<string, StatusEntry> = { child: { type: "busy" } };
  const children = { root: [session("child", "Explore Task", "root")] };
  // No idleSettleDelayMs override → real default 12000ms. deferredConfirmDelayMs kept small
  // so the deferred loop reaches the settle boundary fast; the 12s window is what matters.
  const ctx = makeCtx(sent, service, children, statuses, { deferredConfirmDelayMs: 200 });

  const start = Date.now();
  await handleSessionIdle({ type: "session.idle", properties: { sessionID: "root" } }, ctx);

  service.setSessionStatus("child", "idle");
  statuses.child = { type: "idle" };
  await handleSessionIdle({ type: "session.idle", properties: { sessionID: "child" } }, ctx);

  // OMO re-triggers the root ~6s after the child finished (observed latency).
  await sleep(6000);
  statuses.root = { type: "busy" };
  await handleSessionStatus(
    { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } },
    ctx,
  );
  console.log(`  [t=${Date.now() - start}ms] OMO re-triggered root (busy)`);

  // Wait past the full 12s settle window (started ~200ms in → fires ~12.2s).
  await sleep(7000);
  console.log(`  [t=${Date.now() - start}ms] settle window elapsed; sent=${JSON.stringify(sent)}`);
  const pass = sent.length === 0;
  console.log(
    `Case A (default 12s window suppresses 6s OMO re-trigger): ${pass ? "PASS" : "FAIL"}`,
  );
  return pass;
}

async function caseB(): Promise<boolean> {
  resetSessionIdleTimersForTest();
  const sent: string[] = [];
  const service = new SessionTitleService();
  service.setSessionInfo(session("solo", "Real completion"));
  service.setSessionAgent("solo", "build");
  const ctx = makeCtx(sent, service, {}, {}, { idleSettleDelayMs: 300 });

  await handleSessionIdle({ type: "session.idle", properties: { sessionID: "solo" } }, ctx);
  await sleep(150);
  const midSent = sent.length;
  await sleep(400);
  const pass =
    midSent === 0 && sent.length === 1 && sent[0] === "Agent has finished: Real completion (build)";
  console.log(`  mid-window sent=${midSent}, final sent=${JSON.stringify(sent)}`);
  console.log(
    `Case B (genuine completion delivers exactly once after settle): ${pass ? "PASS" : "FAIL"}`,
  );
  return pass;
}

async function caseC(): Promise<boolean> {
  resetSessionIdleTimersForTest();
  const sent: string[] = [];
  const service = new SessionTitleService();
  service.setSessionInfo(session("c-root", "Window root"));
  const statuses: Record<string, StatusEntry> = {};
  const children: Record<string, Session[]> = {};
  const ctx = makeCtx(sent, service, children, statuses, {
    idleSettleDelayMs: 400,
    deferredConfirmDelayMs: 50,
  });

  await handleSessionIdle({ type: "session.idle", properties: { sessionID: "c-root" } }, ctx);

  // A background subagent appears and works entirely inside the settle window.
  await sleep(100);
  service.setSessionInfo(session("c-child", "Subagent", "c-root"));
  children["c-root"] = [session("c-child", "Subagent", "c-root")];
  statuses["c-child"] = { type: "busy" };
  await handleSessionStatus(
    { type: "session.status", properties: { sessionID: "c-child", status: { type: "busy" } } },
    ctx,
  );

  // Past the ORIGINAL settle deadline, but the child is still busy → must NOT send.
  await sleep(450);
  const earlySent = sent.length;

  service.setSessionStatus("c-child", "idle");
  statuses["c-child"] = { type: "idle" };
  await handleSessionIdle({ type: "session.idle", properties: { sessionID: "c-child" } }, ctx);

  await sleep(600);
  const pass =
    earlySent === 0 && sent.length === 1 && sent[0] === "Agent has finished: Window root";
  console.log(
    `  early(after original deadline, child busy)=${earlySent}, final=${JSON.stringify(sent)}`,
  );
  console.log(
    `Case C (descendant active inside window re-defers, sends after it finishes): ${pass ? "PASS" : "FAIL"}`,
  );
  return pass;
}

async function main(): Promise<void> {
  console.log("== idle-settle-race manual QA ==");
  const a = await caseA();
  const b = await caseB();
  const c = await caseC();
  resetSessionIdleTimersForTest();
  if (a && b && c) {
    console.log("\nALL QA CASES PASSED");
    process.exit(0);
  }
  console.log("\nQA FAILED");
  process.exit(1);
}

void main();
