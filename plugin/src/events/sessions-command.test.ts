import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Session } from "@opencode-ai/sdk";
import type { TelegramBotManager } from "../bot.js";
import type { OpenCodeFetcher } from "../lib/opencode-http.js";
import type { SessionWithAgent } from "../lib/sdk-augmentation.js";
import type { SessionRegistryEntry, SessionRegistryStore } from "../lib/session-registry.js";
import type { SnapshotEntry, SnapshotStore } from "../lib/session-snapshot.js";
import type { SessionStatusType } from "../services/session-title-service.js";
import { createSessionsDispatcher } from "./sessions-command.js";
import type { OpencodeClient } from "./types.js";

interface SendCall {
  text: string;
  opts: unknown;
}

interface LogCall {
  msg: string;
  data: Record<string, unknown> | undefined;
}

interface SaveCall {
  chatId: number;
  entries: SnapshotEntry[];
}

interface CacheCalls {
  infos: Session[];
  urls: Array<{ sessionId: string; serverUrl: string }>;
  statuses: Array<{ sessionId: string; status: SessionStatusType }>;
}

interface RegistryCalls {
  upserts: SessionRegistryEntry[];
  updates: Array<{ sessionId: string; patch: Partial<Omit<SessionRegistryEntry, "sessionId">> }>;
}

function makeBot(sendCalls: SendCall[]): TelegramBotManager {
  return {
    sendMessage: async (text: string, opts?: unknown) => {
      sendCalls.push({ text, opts });
      return { message_id: 1 };
    },
  } as unknown as TelegramBotManager;
}

function makeSnapshotStore(saveCalls: SaveCall[]): SnapshotStore {
  return {
    async saveSnapshot(chatId: number, entries: SnapshotEntry[]) {
      saveCalls.push({ chatId, entries });
    },
    async loadSnapshot() {
      return null;
    },
    snapshotFilePath() {
      return "";
    },
  };
}

function makeLogger(logs: LogCall[]) {
  return {
    info(msg: string, data?: Record<string, unknown>) {
      logs.push({ msg, data });
    },
    error(msg: string, data?: Record<string, unknown>) {
      logs.push({ msg, data });
    },
  };
}

function makeSessionTitleService(calls: CacheCalls) {
  return {
    setSessionInfo(info: Session) {
      calls.infos.push(info);
    },
    setServerUrl(sessionId: string, serverUrl: string) {
      calls.urls.push({ sessionId, serverUrl });
    },
    setSessionStatus(sessionId: string, status: SessionStatusType) {
      calls.statuses.push({ sessionId, status });
    },
  };
}

function makeSessionRegistry(
  entries: SessionRegistryEntry[] = [],
  calls: RegistryCalls = { upserts: [], updates: [] },
): SessionRegistryStore {
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  return {
    async upsertSession(entry) {
      calls.upserts.push(entry);
      const existing = byId.get(entry.sessionId);
      byId.set(entry.sessionId, { ...existing, ...entry });
    },
    async updateSession(sessionId, patch) {
      calls.updates.push({ sessionId, patch });
      const existing = byId.get(sessionId);
      if (!existing) return;
      byId.set(sessionId, { ...existing, ...patch, sessionId });
    },
    async listSessions() {
      return [...byId.values()];
    },
  };
}

function makeClient(opts: {
  sessions?: Session[];
  statuses?: Record<string, { type: SessionStatusType }>;
  listError?: Error;
  onList?: () => void;
}): OpencodeClient {
  return {
    session: {
      list: async () => {
        opts.onList?.();
        if (opts.listError) throw opts.listError;
        return { data: opts.sessions ?? [] };
      },
      status: async () => ({ data: opts.statuses ?? {} }),
    },
  } as unknown as OpencodeClient;
}

function makeSession(index: number, overrides: Partial<SessionWithAgent> = {}): SessionWithAgent {
  return {
    id: `ses_${index}`,
    projectID: "proj_1",
    directory: "/tmp/project",
    title: `Title ${index}`,
    version: "1",
    time: {
      created: 1000 - index,
      updated: 1000 - index,
    },
    agent: "build",
    ...overrides,
  };
}

function makeSessions(count: number): Session[] {
  return Array.from({ length: count }, (_, i) => makeSession(i + 1));
}

function makeCacheCalls(): CacheCalls {
  return { infos: [], urls: [], statuses: [] };
}

const serverUrl = "http://localhost:7777/";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createDispatcher(opts: {
  client: OpencodeClient;
  cacheCalls: CacheCalls;
  saveCalls: SaveCall[];
  logs: LogCall[];
  registry?: SessionRegistryStore;
  opencodeFetch?: OpenCodeFetcher;
}) {
  return createSessionsDispatcher({
    client: opts.client,
    sessionTitleService: makeSessionTitleService(opts.cacheCalls),
    sessionRegistry: opts.registry ?? makeSessionRegistry(),
    snapshotStore: makeSnapshotStore(opts.saveCalls),
    serverUrl,
    logger: makeLogger(opts.logs),
    opencodeFetch: opts.opencodeFetch,
  });
}

describe("sessions-command dispatcher", () => {
  test("empty sessions: sends 'no active sessions' and does not save snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 42, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.text, "세션이 없습니다.");
    assert.equal(saveCalls.length, 0);
  });

  test("3 sessions: numbered output and saveSnapshot called with 3 entries", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const sessions = makeSessions(3);
    const dispatcher = createDispatcher({
      client: makeClient({
        sessions,
        statuses: {
          ses_1: { type: "idle" },
          ses_2: { type: "busy" },
          ses_3: { type: "retry" },
        },
      }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("1."), "should include '1.'");
    assert.ok(text.includes("2."), "should include '2.'");
    assert.ok(text.includes("3."), "should include '3.'");
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0]?.chatId, 7);
    assert.equal(saveCalls[0]?.entries.length, 3);
    assert.equal(saveCalls[0]?.entries[0]?.index, 1);
    assert.equal(saveCalls[0]?.entries[2]?.index, 3);
    assert.equal(cacheCalls.infos.length, 3);
    assert.equal(cacheCalls.urls.length, 3);
    assert.equal(cacheCalls.statuses.length, 3);
  });

  test("registry-only root sessions are included for cross-process visibility", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const registry = makeSessionRegistry([
      {
        sessionId: "ses_other",
        title: "Other Window",
        parentID: null,
        agent: "build",
        status: "idle",
        serverUrl: "http://localhost:8888/",
        updatedAt: 2000,
      },
    ]);
    const opencodeFetch: OpenCodeFetcher = async (url) => {
      if (url.href === "http://localhost:8888/session") {
        return jsonResponse([
          {
            id: "ses_other",
            title: "Other Window",
            parentID: null,
            agent: "build",
            time: { updated: 2000 },
          },
        ]);
      }
      if (url.href === "http://localhost:8888/session/status") {
        return jsonResponse({ ses_other: { type: "busy" } });
      }
      return jsonResponse({}, 404);
    };
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
      registry,
      opencodeFetch,
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("1. [build] Other Window — busy"));
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0]?.entries[0]?.sessionId, "ses_other");
    assert.equal(saveCalls[0]?.entries[0]?.serverUrl, "http://localhost:8888/");
  });

  test("remote registry server refresh includes root sessions not yet in registry", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const registry = makeSessionRegistry([
      {
        sessionId: "ses_known_remote",
        title: "Known Remote",
        parentID: null,
        agent: "build",
        status: "busy",
        serverUrl: "http://localhost:8888/",
        updatedAt: 2000,
      },
    ]);
    const opencodeFetch: OpenCodeFetcher = async (url) => {
      if (url.href === "http://localhost:8888/session") {
        return jsonResponse([
          {
            id: "ses_known_remote",
            title: "Known Remote",
            parentID: null,
            agent: "build",
            time: { updated: 2000 },
          },
          {
            id: "ses_rollback",
            title: "opencode 터미널 멈춤 롤백",
            parentID: null,
            agent: "build",
            time: { updated: 3000 },
          },
        ]);
      }
      if (url.href === "http://localhost:8888/session/status") {
        return jsonResponse({ ses_known_remote: { type: "busy" }, ses_rollback: { type: "busy" } });
      }
      return jsonResponse({}, 404);
    };
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
      registry,
      opencodeFetch,
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("1. [build] opencode 터미널 멈춤 롤백 — busy"));
    assert.ok(text.includes("2. [build] Known Remote — busy"));
    assert.deepEqual(saveCalls[0]?.entries.map((entry) => entry.sessionId), ["ses_rollback", "ses_known_remote"]);
  });

  test("unreachable remote registry server entries are not rendered", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const registry = makeSessionRegistry([
      {
        sessionId: "ses_stale_remote",
        title: "Stale Remote",
        parentID: null,
        agent: "build",
        status: "busy",
        serverUrl: "http://localhost:8888/",
        updatedAt: 2000,
      },
    ]);
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
      registry,
      opencodeFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(sendCalls[0]?.text, "세션이 없습니다.");
    assert.equal(saveCalls.length, 0);
    assert.equal(logs[0]?.msg, "sessions remote server refresh failed");
  });

  test("registry-only sessions without status render and snapshot as idle", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const registry = makeSessionRegistry([
      {
        sessionId: "ses_other_missing_status",
        title: "Other Missing Status",
        parentID: null,
        agent: "build",
        serverUrl: "http://localhost:8888/",
        updatedAt: 2000,
      },
    ]);
    const opencodeFetch: OpenCodeFetcher = async (url) => {
      if (url.href === "http://localhost:8888/session") {
        return jsonResponse([
          {
            id: "ses_other_missing_status",
            title: "Other Missing Status",
            parentID: null,
            agent: "build",
            time: { updated: 2000 },
          },
        ]);
      }
      if (url.href === "http://localhost:8888/session/status") {
        return jsonResponse({});
      }
      return jsonResponse({}, 404);
    };
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
      registry,
      opencodeFetch,
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("1. [build] Other Missing Status — idle"));
    assert.equal(saveCalls[0]?.entries[0]?.status, "idle");
  });

  test("live sessions override stale registry entries with the same id", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const registry = makeSessionRegistry([
      {
        sessionId: "ses_1",
        title: "Stale Title",
        parentID: null,
        agent: "plan",
        status: "busy",
        serverUrl: "http://localhost:9999/",
        updatedAt: 1,
      },
    ]);
    const dispatcher = createDispatcher({
      client: makeClient({
        sessions: [makeSession(1, { title: "Live Title", agent: "build" })],
        statuses: { ses_1: { type: "idle" } },
      }),
      cacheCalls,
      saveCalls,
      logs,
      registry,
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("1. [build] Live Title — idle"));
    assert.ok(!text.includes("Stale Title"));
    assert.equal(saveCalls[0]?.entries[0]?.serverUrl, serverUrl);
  });

  test("registry child sessions are excluded from the rendered snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const registry = makeSessionRegistry([
      {
        sessionId: "ses_registry_root",
        title: "Registry Root",
        parentID: null,
        agent: "build",
        status: "idle",
        serverUrl,
        updatedAt: 2000,
      },
      {
        sessionId: "ses_registry_child",
        title: "Registry Child",
        parentID: "ses_registry_root",
        agent: "build",
        status: "idle",
        serverUrl,
        updatedAt: 3000,
      },
    ]);
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
      registry,
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("Registry Root"));
    assert.ok(!text.includes("Registry Child"));
    assert.equal(saveCalls[0]?.entries.length, 1);
  });

  test("21 sessions: limit enforced after live session.list()", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    let listCalls = 0;
    const dispatcher = createDispatcher({
      client: makeClient({
        sessions: makeSessions(21),
        onList: () => {
          listCalls += 1;
        },
      }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(listCalls, 1);
    assert.equal(saveCalls[0]?.entries.length, 20);
    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("20."), "should include '20.'");
    assert.ok(!text.includes("21."), "should NOT include '21.'");
    assert.ok(text.includes("최근 세션 (top 20)"));
  });

  test("child sessions are excluded from the rendered snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({
        sessions: [
          makeSession(1, { title: "Root" }),
          makeSession(2, { title: "Child", parentID: "ses_1" }),
        ],
      }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(saveCalls[0]?.entries.length, 1);
    assert.equal(saveCalls[0]?.entries[0]?.title, "Root");
    assert.equal(cacheCalls.infos.length, 2);
  });

  test("HTML special chars in title are escaped", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({
        sessions: [makeSession(1, { title: "<script>alert(1)</script>" })],
      }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("&lt;script&gt;"), "should escape < and >");
    assert.ok(!text.includes("<script>"), "should NOT contain raw <script>");
    assert.ok(!text.includes("</script>"), "should NOT contain raw </script>");
  });

  test("parse_mode 'HTML' is passed to sendMessage", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: makeSessions(2) }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    const opts = sendCalls[0]?.opts as { parse_mode?: string } | undefined;
    assert.equal(opts?.parse_mode, "HTML");
  });

  test("parse_mode 'HTML' is also passed for empty-sessions path", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [] }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    const opts = sendCalls[0]?.opts as { parse_mode?: string } | undefined;
    assert.equal(opts?.parse_mode, "HTML");
  });

  test("logger.info called with count=3 and no message body leak", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: makeSessions(3) }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 99, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.msg, "sessions listed");
    assert.equal(logs[0]?.data?.count, 3);
    assert.equal(logs[0]?.data?.chatId, 99);
    const data = logs[0]?.data ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(data, "text"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "body"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "title"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "message"), false);
  });

  test("missing agent renders as '?' and missing status renders idle", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({ sessions: [makeSession(1, { agent: undefined })] }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("[?]"), "missing agent should be '?' ");
    assert.ok(!text.includes("unknown"), "missing status should not render 'unknown'");
    assert.ok(text.includes("Title 1 — idle"), "missing status should render idle");
  });

  test("session list failure: sends load failure and does not save snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createDispatcher({
      client: makeClient({ listError: new Error("boom") }),
      cacheCalls,
      saveCalls,
      logs,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(sendCalls[0]?.text, "세션 목록을 불러오지 못했습니다.");
    assert.equal(saveCalls.length, 0);
    assert.equal(logs[0]?.msg, "sessions list failed");
  });
});
