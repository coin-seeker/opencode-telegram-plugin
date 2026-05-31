import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import type { OpenCodeFetcher } from "../lib/opencode-http.js";
import type { SnapshotEntry, SnapshotStore } from "../lib/session-snapshot.js";
import { createStatusDispatcher } from "./status-command.js";
import type { OpencodeClient } from "./types.js";

interface SendCall {
  text: string;
  opts: unknown;
}

interface LogCall {
  msg: string;
  data: Record<string, unknown> | undefined;
}

function makeBot(sendCalls: SendCall[]): TelegramBotManager {
  return {
    sendMessage: async (text: string, opts?: unknown) => {
      sendCalls.push({ text, opts });
      return { message_id: 1 };
    },
  } as unknown as TelegramBotManager;
}

function makeSnapshotStore(entries: SnapshotEntry[] | null): SnapshotStore {
  return {
    async saveSnapshot() {},
    async loadSnapshot() {
      return entries;
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

const sessionTitleService = { getServerUrl: () => undefined };

interface MockClientShape {
  get: (path: { path: { id: string } }) => Promise<{
    data: { directory: string; title: string; id: string } | undefined;
    response?: { status: number };
  }>;
  status: () => Promise<{ data: { [k: string]: { type: "idle" | "busy" | "retry" } } }>;
  messages: (args: {
    path: { id: string };
    query: { limit: number };
  }) => Promise<{
    data: Array<{
      info: { role: "user" | "assistant" } & Record<string, unknown>;
      parts: Array<{ type: string; text?: string }>;
    }>;
  }>;
}

function makeClient(impl: Partial<MockClientShape>): OpencodeClient {
  const defaults: MockClientShape = {
    async get() {
      return { data: { directory: "/tmp/nowhere", title: "T", id: "ses_x" } };
    },
    async status() {
      return { data: {} };
    },
    async messages() {
      return { data: [] };
    },
  };
  const merged: MockClientShape = { ...defaults, ...impl };
  return {
    session: {
      get: merged.get,
      status: merged.status,
      messages: merged.messages,
    },
  } as unknown as OpencodeClient;
}

function makeEntry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    index: 1,
    sessionId: "ses_1",
    title: "Snap Title",
    agent: "build",
    status: "idle",
    capturedAt: Date.now(),
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("status-command dispatcher", () => {
  let baseDir = "";

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), `status-cmd-${randomUUID()}`));
  });

  after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function freshProject(): Promise<string> {
    const dir = join(baseDir, `proj-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  test("missing arg: sends usage message and does not fetch session", async () => {
    const sendCalls: SendCall[] = [];
    const logs: LogCall[] = [];
    let getCalled = false;
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry()]),
      sessionTitleService,
      client: makeClient({
        async get() {
          getCalled = true;
          return { data: undefined };
        },
      }),
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: [] });

    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0]?.text ?? "", /사용법: \/status/);
    assert.match(sendCalls[0]?.text ?? "", /\/sessions/);
    assert.equal(getCalled, false);
    assert.equal((sendCalls[0]?.opts as { parse_mode?: string } | undefined)?.parse_mode, "HTML");
  });

  test("non-numeric N: 숫자여야 합니다", async () => {
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry()]),
      sessionTitleService,
      client: makeClient({}),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["abc"] });

    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0]?.text ?? "", /abc은 숫자여야 합니다/);
  });

  test("null snapshot: 먼저 /sessions 안내", async () => {
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore(null),
      sessionTitleService,
      client: makeClient({}),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0]?.text ?? "", /세션 목록이 없습니다/);
    assert.match(sendCalls[0]?.text ?? "", /\/sessions/);
  });

  test("N out of range: <N>번 세션 없음", async () => {
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1 }), makeEntry({ index: 2 })]),
      sessionTitleService,
      client: makeClient({}),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["5"] });

    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0]?.text ?? "", /5번 세션 없음/);
    assert.match(sendCalls[0]?.text ?? "", /현재 목록 크기: 2/);
  });

  test("session 404: '더 이상 존재하지 않습니다'", async () => {
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_gone" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return { data: undefined, response: { status: 404 } };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0]?.text ?? "", /더 이상 존재하지 않습니다/);
    assert.match(sendCalls[0]?.text ?? "", /\/sessions 재실행/);
  });

  test("happy path: plan ready shows progress and session details", async () => {
    const projectRoot = await freshProject();
    const omoDir = join(projectRoot, ".omo", "plans");
    await mkdir(omoDir, { recursive: true });
    await writeFile(
      join(omoDir, "plan-1.md"),
      "- [x] done item\n- [ ] open item\n- [ ] another open\n",
      "utf8",
    );

    const sendCalls: SendCall[] = [];
    const logs: LogCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([
        makeEntry({ index: 3, sessionId: "ses_happy", agent: "plan" }),
      ]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Happy Title", id: "ses_happy" },
          };
        },
        async status() {
          return { data: { ses_happy: { type: "busy" } } };
        },
        async messages() {
          return {
            data: [
              {
                info: { role: "user", id: "m1", sessionID: "ses_happy" },
                parts: [{ type: "text", text: "hello world" }],
              },
              {
                info: { role: "assistant", id: "m2", sessionID: "ses_happy" },
                parts: [{ type: "text", text: "all good" }],
              },
            ],
          };
        },
      }),
      logger: makeLogger(logs),
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls), args: ["3"] });

    assert.equal(sendCalls.length, 1);
    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /<b>세션 #3<\/b>: Happy Title/);
    assert.match(text, /에이전트: plan/);
    assert.match(text, /상태: busy/);
    assert.match(text, /유저: hello world/);
    assert.match(text, /에이전트: all good/);
    assert.match(text, /<b>플랜 진행도<\/b>: 1\/3 \(plan-1\)/);
    assert.match(text, /<b>Boulder<\/b>: 없음/);
    assert.equal((sendCalls[0]?.opts as { parse_mode?: string } | undefined)?.parse_mode, "HTML");

    // log assertions
    const log = logs.find((l) => l.msg === "status shown");
    assert.ok(log, "expected status shown log");
    assert.equal(log?.data?.chatId, 7);
    assert.equal(log?.data?.sessionId, "ses_happy");
    assert.equal(log?.data?.snapshotIndex, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(log?.data ?? {}, "text"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(log?.data ?? {}, "body"), false);
  });

  test("session-linked boulder works show distinct plan progress per status index", async () => {
    const projectRoot = await freshProject();
    const plansDir = join(projectRoot, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "one.md"), "- [x] one done\n- [ ] one open\n", "utf8");
    await writeFile(
      join(plansDir, "two.md"),
      "- [x] two done\n- [x] two done again\n- [ ] two open\n",
      "utf8",
    );
    await writeFile(
      join(projectRoot, ".omo", "boulder.json"),
      JSON.stringify({
        schema_version: 2,
        active_work_id: "two-work",
        works: {
          "one-work": {
            active_plan: ".omo/plans/one.md",
            plan_name: "one",
            status: "active",
            started_at: "2026-05-30T00:00:00.000Z",
            updated_at: "2026-05-30T00:00:00.000Z",
            session_ids: ["ses_one"],
          },
          "two-work": {
            active_plan: ".omo/plans/two.md",
            plan_name: "two",
            status: "active",
            started_at: "2026-05-31T00:00:00.000Z",
            updated_at: "2026-05-31T00:00:00.000Z",
            session_ids: ["ses_two"],
          },
        },
        active_plan: ".omo/plans/two.md",
        plan_name: "two",
        status: "active",
        session_ids: ["ses_two"],
      }),
      "utf8",
    );

    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([
        makeEntry({ index: 1, sessionId: "ses_one", agent: "build", title: "One" }),
        makeEntry({ index: 2, sessionId: "ses_two", agent: "build", title: "Two" }),
      ]),
      sessionTitleService,
      client: makeClient({
        async get(args) {
          return {
            data: { directory: projectRoot, title: args.path.id, id: args.path.id },
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls), args: ["1"] });
    await dispatcher({ chatId: 7, userId: 1, bot: makeBot(sendCalls), args: ["2"] });

    const first = sendCalls[0]?.text ?? "";
    const second = sendCalls[1]?.text ?? "";
    assert.match(first, /<b>플랜 진행도<\/b>: 1\/2 \(one\)/);
    assert.match(second, /<b>플랜 진행도<\/b>: 2\/3 \(two\)/);
    assert.match(first, /<b>Boulder<\/b>: 활성/);
    assert.match(second, /<b>Boulder<\/b>: 활성/);
  });

  test("non-plan sessions do not fall back to the latest project plan", async () => {
    const projectRoot = await freshProject();
    const plansDir = join(projectRoot, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "latest.md"), "- [x] shared\n- [ ] shared\n", "utf8");

    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_build", agent: "build" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Build Session", id: "ses_build" },
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /<b>플랜 상태<\/b>: 세션 연결 plan 없음/);
    assert.ok(!text.includes("latest"));
    assert.ok(!text.includes("1/2"));
  });

  test("Plan Builder labels can fall back to the latest project plan", async () => {
    const projectRoot = await freshProject();
    const plansDir = join(projectRoot, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "latest.md"), "- [x] shared\n- [ ] shared\n", "utf8");

    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([
        makeEntry({
          index: 1,
          sessionId: "ses_prometheus",
          agent: "Prometheus - Plan Builder",
          title: "CRM SaaS 전환 및 Status 서버 구축",
        }),
      ]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "CRM SaaS 전환 및 Status 서버 구축", id: "ses_prometheus" },
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /에이전트: Prometheus - Plan Builder/);
    assert.match(text, /<b>플랜 진행도<\/b>: 1\/2 \(latest\)/);
  });

  test("0 messages: snippets render as '메시지 없음'", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_empty" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Empty", id: "ses_empty" },
          };
        },
        async messages() {
          return { data: [] };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /유저: 메시지 없음/);
    assert.match(text, /에이전트: 메시지 없음/);
  });

  test("missing status entry falls back to idle", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_idle_missing" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Idle Missing", id: "ses_idle_missing" },
          };
        },
        async status() {
          return { data: {} };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /상태: idle/);
    assert.ok(!text.includes("unknown"));
  });

  test("uses newest user and assistant messages from the end of returned history", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_latest" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Latest", id: "ses_latest" },
          };
        },
        async messages() {
          return {
            data: [
              {
                info: { role: "user", id: "m1", sessionID: "ses_latest" },
                parts: [{ type: "text", text: "old user" }],
              },
              {
                info: { role: "assistant", id: "m2", sessionID: "ses_latest" },
                parts: [{ type: "text", text: "old assistant" }],
              },
              {
                info: { role: "user", id: "m3", sessionID: "ses_latest" },
                parts: [{ type: "text", text: "new user" }],
              },
              {
                info: { role: "assistant", id: "m4", sessionID: "ses_latest" },
                parts: [{ type: "text", text: "new assistant" }],
              },
            ],
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /유저: new user/);
    assert.match(text, /에이전트: new assistant/);
    assert.ok(!text.includes("old user"));
    assert.ok(!text.includes("old assistant"));
  });

  test("uses snapshot serverUrl for status of sessions from another OpenCode server", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const requested: string[] = [];
    let localGetCalled = false;
    const opencodeFetch: OpenCodeFetcher = async (url) => {
      requested.push(url.href);
      if (url.pathname === "/session/ses_remote") {
        return jsonResponse({ id: "ses_remote", directory: projectRoot, title: "Remote Title" });
      }
      if (url.pathname === "/session/status") {
        return jsonResponse({ ses_remote: { type: "busy" } });
      }
      if (url.pathname === "/session/ses_remote/message") {
        assert.equal(url.searchParams.get("limit"), "10");
        return jsonResponse([
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "remote user" }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "remote assistant" }],
          },
        ]);
      }
      return jsonResponse({ message: "not found" }, 404);
    };
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([
        makeEntry({
          index: 1,
          sessionId: "ses_remote",
          agent: "build",
          serverUrl: "http://127.0.0.1:8888/",
        }),
      ]),
      sessionTitleService,
      client: makeClient({
        async get() {
          localGetCalled = true;
          return { data: undefined };
        },
      }),
      logger: makeLogger([]),
      serverUrl: "http://127.0.0.1:7777/",
      opencodeFetch,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    assert.equal(localGetCalled, false);
    assert.deepEqual(requested.sort(), [
      "http://127.0.0.1:8888/session/ses_remote",
      "http://127.0.0.1:8888/session/ses_remote/message?limit=10",
      "http://127.0.0.1:8888/session/status",
    ].sort());
    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /<b>세션 #1<\/b>: Remote Title/);
    assert.match(text, /상태: busy/);
    assert.match(text, /유저: remote user/);
    assert.match(text, /에이전트: remote assistant/);
  });

  test("remote session 404 returns graceful missing-session message", async () => {
    const sendCalls: SendCall[] = [];
    const requested: string[] = [];
    const opencodeFetch: OpenCodeFetcher = async (url) => {
      requested.push(url.href);
      return jsonResponse({ message: "not found" }, 404);
    };
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([
        makeEntry({
          index: 1,
          sessionId: "ses_remote_gone",
          serverUrl: "http://127.0.0.1:8888/",
        }),
      ]),
      sessionTitleService,
      client: makeClient({}),
      logger: makeLogger([]),
      serverUrl: "http://127.0.0.1:7777/",
      opencodeFetch,
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    assert.deepEqual(requested, ["http://127.0.0.1:8888/session/ses_remote_gone"]);
    assert.match(sendCalls[0]?.text ?? "", /더 이상 존재하지 않습니다/);
    assert.match(sendCalls[0]?.text ?? "", /\/sessions 재실행/);
  });

  test("invalid snapshot serverUrl is rejected without remote fetch", async () => {
    const sendCalls: SendCall[] = [];
    const logs: LogCall[] = [];
    let fetchCalled = false;
    let localGetCalled = false;
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([
        makeEntry({
          index: 1,
          sessionId: "ses_bad_url",
          serverUrl: "http://169.254.169.254/",
        }),
      ]),
      sessionTitleService,
      client: makeClient({
        async get() {
          localGetCalled = true;
          return { data: undefined };
        },
      }),
      logger: makeLogger(logs),
      serverUrl: "http://127.0.0.1:7777/",
      opencodeFetch: async () => {
        fetchCalled = true;
        return jsonResponse({});
      },
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    assert.equal(fetchCalled, false);
    assert.equal(localGetCalled, false);
    assert.match(sendCalls[0]?.text ?? "", /세션 서버 정보가 유효하지 않습니다/);
    assert.equal(logs[0]?.msg, "status invalid server url");
  });

  test("HTML escape in title and message snippets", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_xss" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: {
              directory: projectRoot,
              title: "<script>alert(1)</script>",
              id: "ses_xss",
            },
          };
        },
        async messages() {
          return {
            data: [
              {
                info: { role: "user", id: "m1", sessionID: "ses_xss" },
                parts: [{ type: "text", text: "<b>boom</b>" }],
              },
              {
                info: { role: "assistant", id: "m2", sessionID: "ses_xss" },
                parts: [{ type: "text", text: "<i>reply</i>" }],
              },
            ],
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(text.includes("&lt;b&gt;boom&lt;/b&gt;"));
    assert.ok(text.includes("&lt;i&gt;reply&lt;/i&gt;"));
    assert.ok(!text.includes("<script>"));
    assert.ok(!text.includes("<b>boom</b>"));
  });

  test("plan-readiness no-omo-dir: Korean reason shown, Boulder 없음", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_no_omo" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "No Omo", id: "ses_no_omo" },
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /<b>플랜 상태<\/b>: `\.omo\/` 없음/);
    assert.match(text, /<b>Boulder<\/b>: 없음/);
  });

  test("boulder active: shows '활성' for Boulder line", async () => {
    const projectRoot = await freshProject();
    const plansDir = join(projectRoot, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "run-plan.md"), "- [ ] running\n", "utf8");
    await writeFile(
      join(projectRoot, ".omo", "boulder.json"),
      JSON.stringify({
        active_plan: ".omo/plans/run-plan.md",
        plan_name: "run-plan",
        status: "active",
        session_ids: ["ses_boulder"],
      }),
      "utf8",
    );

    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_boulder" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Boulder Run", id: "ses_boulder" },
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /<b>플랜 진행도<\/b>: 0\/1 \(run-plan\)/);
    assert.match(text, /<b>Boulder<\/b>: 활성/);
  });

  test("code fences in messages are stripped before escaping", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_fence" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Fence", id: "ses_fence" },
          };
        },
        async messages() {
          return {
            data: [
              {
                info: { role: "user", id: "m1", sessionID: "ses_fence" },
                parts: [{ type: "text", text: "```ts\nconst x = 1;\n```" }],
              },
            ],
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.ok(!text.includes("```"), "code fences should be stripped");
    assert.match(text, /const x = 1;/);
  });

  test("only assistant message present: user snippet falls back to '메시지 없음'", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 1, sessionId: "ses_asst" })]),
      sessionTitleService,
      client: makeClient({
        async get() {
          return {
            data: { directory: projectRoot, title: "Asst Only", id: "ses_asst" },
          };
        },
        async messages() {
          return {
            data: [
              {
                info: { role: "assistant", id: "m1", sessionID: "ses_asst" },
                parts: [{ type: "text", text: "assistant only" }],
              },
            ],
          };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["1"] });

    const text = sendCalls[0]?.text ?? "";
    assert.match(text, /유저: 메시지 없음/);
    assert.match(text, /에이전트: assistant only/);
  });

  test("session.get and session.messages and session.status all invoked in parallel with correct args", async () => {
    const projectRoot = await freshProject();
    const sendCalls: SendCall[] = [];
    const calls: string[] = [];
    let getArgs: unknown = null;
    let messagesArgs: unknown = null;
    const dispatcher = createStatusDispatcher({
      snapshotStore: makeSnapshotStore([makeEntry({ index: 2, sessionId: "ses_par" })]),
      sessionTitleService,
      client: makeClient({
        async get(args) {
          calls.push("get");
          getArgs = args;
          return {
            data: { directory: projectRoot, title: "Par", id: "ses_par" },
          };
        },
        async status() {
          calls.push("status");
          return { data: {} };
        },
        async messages(args) {
          calls.push("messages");
          messagesArgs = args;
          return { data: [] };
        },
      }),
      logger: makeLogger([]),
    });

    await dispatcher({ chatId: 1, userId: 1, bot: makeBot(sendCalls), args: ["2"] });

    assert.ok(calls.includes("get"));
    assert.ok(calls.includes("status"));
    assert.ok(calls.includes("messages"));
    assert.deepEqual(getArgs, { path: { id: "ses_par" } });
    assert.deepEqual(messagesArgs, { path: { id: "ses_par" }, query: { limit: 10 } });
  });
});
