import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Session } from "@opencode-ai/sdk";
import type { TelegramBotManager } from "../bot.js";
import type { SnapshotEntry, SnapshotStore } from "../lib/session-snapshot.js";
import type { SessionWithAgent } from "../lib/sdk-augmentation.js";
import { createStartWorkCommandDispatcher } from "./start-work-command.js";
import type { OpencodeClient } from "./types.js";

interface SendCall {
  text: string;
  opts: unknown;
}

interface CommandCall {
  sessionId: string;
  command: string;
  serverUrl: string | undefined;
}

interface LogCall {
  msg: string;
  data: Record<string, unknown> | undefined;
}

interface StatusError extends Error {
  status: number;
}

interface HarnessOptions {
  projectRoot: string;
  snapshot?: SnapshotEntry[] | null;
  session?: SessionWithAgent;
  sessionGetError?: Error;
  idle?: boolean;
  serviceAgent?: string;
  serverUrl?: string;
  runError?: Error;
}

function makeBot(sendCalls: SendCall[]): TelegramBotManager {
  return {
    sendMessage: async (text: string, opts?: unknown) => {
      sendCalls.push({ text, opts });
      return { message_id: sendCalls.length };
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

function makeSession(id: string, projectRoot: string, agent = "plan"): SessionWithAgent {
  return {
    id,
    projectID: "project-1",
    directory: projectRoot,
    parentID: undefined,
    title: "Plan session",
    version: "1",
    time: { created: 1, updated: 2 },
    agent,
  };
}

function makeEntry(overrides?: Partial<SnapshotEntry>): SnapshotEntry {
  return {
    index: 1,
    sessionId: "ses_plan",
    title: "Plan <session>",
    agent: "plan",
    status: "idle",
    capturedAt: 1,
    ...overrides,
  };
}

function makeNotFoundError(): StatusError {
  const err = new Error("Not Found") as StatusError;
  err.status = 404;
  return err;
}

function makeClient(args: {
  session: Session;
  sessionGetError?: Error;
  idle: boolean;
  statusCalls: { count: number };
}): OpencodeClient {
  return {
    session: {
      async get() {
        if (args.sessionGetError) throw args.sessionGetError;
        return { data: args.session };
      },
      async status() {
        args.statusCalls.count += 1;
        return { data: { [args.session.id]: { type: args.idle ? "idle" : "busy" } } };
      },
    },
  } as unknown as OpencodeClient;
}

function makeHarness(options: HarnessOptions) {
  const sendCalls: SendCall[] = [];
  const commands: CommandCall[] = [];
  const infoLogs: LogCall[] = [];
  const errorLogs: LogCall[] = [];
  const statusCalls = { count: 0 };
  const session = options.session ?? makeSession("ses_plan", options.projectRoot);
  const snapshot = options.snapshot === undefined ? [makeEntry({ sessionId: session.id })] : options.snapshot;
  const bot = makeBot(sendCalls);
  const dispatcher = createStartWorkCommandDispatcher({
    snapshotStore: makeSnapshotStore(snapshot),
    sessionTitleService: {
      getServerUrl() {
        return options.serverUrl;
      },
      getSessionAgent() {
        return options.serviceAgent;
      },
    },
    client: makeClient({
      session,
      sessionGetError: options.sessionGetError,
      idle: options.idle ?? true,
      statusCalls,
    }),
    async runSessionCommand(sessionId, command, serverUrl) {
      if (options.runError) throw options.runError;
      commands.push({ sessionId, command, serverUrl });
    },
    logger: {
      info(msg, data) {
        infoLogs.push({ msg, data });
      },
      error(msg, data) {
        errorLogs.push({ msg, data });
      },
    },
  });

  return {
    sendCalls,
    commands,
    infoLogs,
    errorLogs,
    statusCalls,
    run: (args: string[]) => dispatcher({ chatId: 42, userId: 7, bot, args }),
  };
}

async function createProjectRoot(baseDir: string, label: string): Promise<string> {
  const projectRoot = join(baseDir, `${label}-${randomUUID()}`);
  await mkdir(projectRoot, { recursive: true });
  return projectRoot;
}

async function createReadyProject(baseDir: string, label: string): Promise<string> {
  const projectRoot = await createProjectRoot(baseDir, label);
  const plansDir = join(projectRoot, ".omo", "plans");
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, "plan.md"), "- [ ] dispatch start-work\n", "utf8");
  return projectRoot;
}

async function createBoulderProject(baseDir: string): Promise<string> {
  const projectRoot = await createProjectRoot(baseDir, "boulder");
  const omoDir = join(projectRoot, ".omo");
  await mkdir(omoDir, { recursive: true });
  await writeFile(join(omoDir, "boulder.json"), "{}\n", "utf8");
  return projectRoot;
}

async function createNoPlansProject(baseDir: string): Promise<string> {
  const projectRoot = await createProjectRoot(baseDir, "no-plans");
  await mkdir(join(projectRoot, ".omo"), { recursive: true });
  return projectRoot;
}

async function createAllCompleteProject(baseDir: string): Promise<string> {
  const projectRoot = await createProjectRoot(baseDir, "all-complete");
  const plansDir = join(projectRoot, ".omo", "plans");
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, "plan.md"), "- [x] already done\n", "utf8");
  return projectRoot;
}

describe("start-work-command dispatcher", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `start-work-command-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("no args sends usage message", async () => {
    const projectRoot = await createReadyProject(dir, "no-args");
    const harness = makeHarness({ projectRoot });

    await harness.run([]);

    assert.equal(harness.sendCalls[0]?.text, "사용법: /start_work <번호>. 먼저 /sessions 로 목록 확인");
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.statusCalls.count, 0);
  });

  test("NaN arg sends numeric input error", async () => {
    const projectRoot = await createReadyProject(dir, "nan");
    const harness = makeHarness({ projectRoot });

    await harness.run(["abc"]);

    assert.match(harness.sendCalls[0]?.text ?? "", /숫자여야 합니다/);
    assert.equal(harness.commands.length, 0);
  });

  test("null snapshot asks user to run /sessions first", async () => {
    const projectRoot = await createReadyProject(dir, "null-snapshot");
    const harness = makeHarness({ projectRoot, snapshot: null });

    await harness.run(["1"]);

    assert.match(harness.sendCalls[0]?.text ?? "", /먼저 \/sessions/);
    assert.equal(harness.commands.length, 0);
  });

  test("out of range snapshot index reports list size", async () => {
    const projectRoot = await createReadyProject(dir, "out-of-range");
    const harness = makeHarness({ projectRoot, snapshot: [makeEntry()] });

    await harness.run(["2"]);

    assert.equal(harness.sendCalls[0]?.text, "2번 세션 없음 (목록 크기: 1)");
    assert.equal(harness.commands.length, 0);
  });

  test("session 404 returns graceful missing-session message", async () => {
    const projectRoot = await createReadyProject(dir, "not-found");
    const harness = makeHarness({ projectRoot, sessionGetError: makeNotFoundError() });

    await harness.run(["1"]);

    assert.equal(harness.sendCalls[0]?.text, "세션이 더 이상 존재하지 않습니다");
    assert.equal(harness.commands.length, 0);
  });

  test("agent build rejects non-plan sessions", async () => {
    const projectRoot = await createReadyProject(dir, "build-agent");
    const session = makeSession("ses_plan", projectRoot, "build");
    const harness = makeHarness({ projectRoot, session });

    await harness.run(["1"]);

    assert.match(
      harness.sendCalls[0]?.text ?? "",
      /에이전트는 'plan' 이 아닙니다 \(현재: build\)/,
    );
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.statusCalls.count, 0);
  });

  test("TOCTOU idle recheck rejects busy session even when cached agent says plan", async () => {
    const projectRoot = await createReadyProject(dir, "busy-toctou");
    const session = makeSession("ses_plan", projectRoot, "build");
    const harness = makeHarness({ projectRoot, session, serviceAgent: "plan", idle: false });

    await harness.run(["1"]);

    assert.match(harness.sendCalls[0]?.text ?? "", /idle 상태가 아닙니다/);
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.statusCalls.count, 1);
  });

  test("plan-readiness boulder-active returns Korean safety message", async () => {
    const projectRoot = await createBoulderProject(dir);
    const harness = makeHarness({ projectRoot, serviceAgent: "plan" });

    await harness.run(["1"]);

    assert.equal(
      harness.sendCalls[0]?.text,
      ".omo/boulder.json 이 이미 존재합니다. 기존 작업이 진행 중이거나 archive 가 필요합니다",
    );
    assert.equal(harness.commands.length, 0);
  });

  test("plan-readiness no-plans returns Korean safety message", async () => {
    const projectRoot = await createNoPlansProject(dir);
    const harness = makeHarness({ projectRoot, serviceAgent: "plan" });

    await harness.run(["1"]);

    assert.equal(harness.sendCalls[0]?.text, ".omo/plans/ 에 plan 파일이 없습니다");
    assert.equal(harness.commands.length, 0);
  });

  test("plan-readiness all-plans-complete returns Korean safety message", async () => {
    const projectRoot = await createAllCompleteProject(dir);
    const harness = makeHarness({ projectRoot, serviceAgent: "plan" });

    await harness.run(["1"]);

    assert.equal(
      harness.sendCalls[0]?.text,
      "plan 의 모든 task 가 완료되었습니다. 새 plan 작성 필요",
    );
    assert.equal(harness.commands.length, 0);
  });

  test("happy path dispatches start-work command with session server URL", async () => {
    const projectRoot = await createReadyProject(dir, "happy");
    const harness = makeHarness({
      projectRoot,
      serviceAgent: "plan",
      serverUrl: "http://localhost:7777",
    });

    await harness.run(["1"]);

    assert.deepEqual(harness.commands, [
      { sessionId: "ses_plan", command: "start-work", serverUrl: "http://localhost:7777" },
    ]);
    assert.equal(
      harness.sendCalls[0]?.text,
      "1번 세션에 opencode /start-work 슬래시 커맨드 전송 완료. (Plan &lt;session&gt;)",
    );
    assert.deepEqual(harness.sendCalls[0]?.opts, { parse_mode: "HTML" });
    assert.equal(harness.infoLogs[0]?.msg, "start-work dispatched");
    assert.equal(harness.infoLogs[0]?.data?.sessionId, "ses_plan");
    assert.equal(harness.statusCalls.count, 1);
  });

  test("runSessionCommand throws sends error message and logs failure", async () => {
    const projectRoot = await createReadyProject(dir, "run-error");
    const harness = makeHarness({
      projectRoot,
      serviceAgent: "plan",
      runError: new Error("boom"),
    });

    await harness.run(["1"]);

    assert.equal(harness.commands.length, 0);
    assert.equal(harness.sendCalls[0]?.text, "opencode /start-work 전송 실패: Error: boom");
    assert.deepEqual(harness.sendCalls[0]?.opts, { parse_mode: "HTML" });
    assert.equal(harness.errorLogs[0]?.msg, "start-work dispatch failed");
    assert.equal(harness.errorLogs[0]?.data?.sessionId, "ses_plan");
  });
});
