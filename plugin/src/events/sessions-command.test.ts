import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import type { SnapshotEntry, SnapshotStore } from "../lib/session-snapshot.js";
import { createSessionsDispatcher } from "./sessions-command.js";

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

interface SessionRecord {
  sessionId: string;
  title: string | null;
  agent: string | undefined;
  status: string | undefined;
  serverUrl: string | undefined;
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
  };
}

function makeSessions(count: number, overrides?: Partial<SessionRecord>): SessionRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `ses_${i + 1}`,
    title: `Title ${i + 1}`,
    agent: "build",
    status: "idle",
    serverUrl: "http://localhost:7777",
    ...overrides,
  }));
}

describe("sessions-command dispatcher", () => {
  test("empty sessions: sends 'no active sessions' and does not save snapshot", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => [] },
      snapshotStore: makeSnapshotStore(saveCalls),
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 42, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.text, "활성 세션이 없습니다.");
    assert.equal(saveCalls.length, 0);
  });

  test("3 sessions: numbered output and saveSnapshot called with 3 entries", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const sessions = makeSessions(3);
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => sessions },
      snapshotStore: makeSnapshotStore(saveCalls),
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
  });

  test("21 sessions: limit enforced via getRootSessionsByRecency(20)", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    let receivedLimit = -1;
    const allSessions = makeSessions(21);
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: {
        getRootSessionsByRecency: (limit: number) => {
          receivedLimit = limit;
          return allSessions.slice(0, limit);
        },
      },
      snapshotStore: makeSnapshotStore(saveCalls),
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(receivedLimit, 20);
    assert.equal(saveCalls[0]?.entries.length, 20);
    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("20."), "should include '20.'");
    assert.ok(!text.includes("21."), "should NOT include '21.'");
    assert.ok(text.includes("top 20"));
  });

  test("HTML special chars in title are escaped", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const sessions: SessionRecord[] = [
      {
        sessionId: "ses_x",
        title: "<script>alert(1)</script>",
        agent: "build",
        status: "idle",
        serverUrl: undefined,
      },
    ];
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => sessions },
      snapshotStore: makeSnapshotStore(saveCalls),
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
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => makeSessions(2) },
      snapshotStore: makeSnapshotStore(saveCalls),
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
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => [] },
      snapshotStore: makeSnapshotStore(saveCalls),
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
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => makeSessions(3) },
      snapshotStore: makeSnapshotStore(saveCalls),
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 99, userId: 1, bot: makeBot(sendCalls) });

    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.msg, "sessions listed");
    assert.equal(logs[0]?.data?.count, 3);
    assert.equal(logs[0]?.data?.chatId, 99);
    // ensure no message body / text / title leaks into log data
    const data = logs[0]?.data ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(data, "text"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "body"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "title"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "message"), false);
  });

  test("missing agent renders as '?' and missing status renders as 'unknown'", async () => {
    const sendCalls: SendCall[] = [];
    const saveCalls: SaveCall[] = [];
    const logs: LogCall[] = [];
    const sessions: SessionRecord[] = [
      {
        sessionId: "ses_a",
        title: "No agent or status",
        agent: undefined,
        status: undefined,
        serverUrl: undefined,
      },
    ];
    const dispatcher = createSessionsDispatcher({
      sessionTitleService: { getRootSessionsByRecency: () => sessions },
      snapshotStore: makeSnapshotStore(saveCalls),
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls) });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("[?]"), "missing agent should be '?'");
    assert.ok(text.includes("unknown"), "missing status should be 'unknown'");
  });
});
