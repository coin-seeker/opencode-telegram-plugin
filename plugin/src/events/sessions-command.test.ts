import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Session } from "@opencode-ai/sdk";
import type { TelegramBotManager } from "../bot.js";
import type { SessionWithAgent } from "../lib/sdk-augmentation.js";
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

describe("sessions-command dispatcher", () => {
  test("empty sessions: sends 'no active sessions' and does not save snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createSessionsDispatcher({
      client: makeClient({ sessions: [] }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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
    const dispatcher = createSessionsDispatcher({
      client: makeClient({
        sessions,
        statuses: {
          ses_1: { type: "idle" },
          ses_2: { type: "busy" },
          ses_3: { type: "retry" },
        },
      }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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

  test("21 sessions: limit enforced after live session.list()", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    let listCalls = 0;
    const dispatcher = createSessionsDispatcher({
      client: makeClient({
        sessions: makeSessions(21),
        onList: () => {
          listCalls += 1;
        },
      }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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
    const dispatcher = createSessionsDispatcher({
      client: makeClient({
        sessions: [
          makeSession(1, { title: "Root" }),
          makeSession(2, { title: "Child", parentID: "ses_1" }),
        ],
      }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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
    const dispatcher = createSessionsDispatcher({
      client: makeClient({
        sessions: [makeSession(1, { title: "<script>alert(1)</script>" })],
      }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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
    const dispatcher = createSessionsDispatcher({
      client: makeClient({ sessions: makeSessions(2) }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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
    const dispatcher = createSessionsDispatcher({
      client: makeClient({ sessions: [] }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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
    const dispatcher = createSessionsDispatcher({
      client: makeClient({ sessions: makeSessions(3) }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
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

  test("missing agent renders as '?' and missing status omits suffix", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createSessionsDispatcher({
      client: makeClient({ sessions: [makeSession(1, { agent: undefined })] }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("[?]"), "missing agent should be '?' ");
    assert.ok(!text.includes("unknown"), "missing status should not render 'unknown'");
    assert.ok(!text.includes("Title 1 —"), "missing status should not render a dangling separator");
  });

  test("session list failure: sends load failure and does not save snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const cacheCalls = makeCacheCalls();
    const dispatcher = createSessionsDispatcher({
      client: makeClient({ listError: new Error("boom") }),
      sessionTitleService: makeSessionTitleService(cacheCalls),
      snapshotStore: makeSnapshotStore(saveCalls),
      serverUrl,
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(sendCalls[0]?.text, "세션 목록을 불러오지 못했습니다.");
    assert.equal(saveCalls.length, 0);
    assert.equal(logs[0]?.msg, "sessions list failed");
  });
});
