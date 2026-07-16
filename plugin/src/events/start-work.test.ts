import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import {
  createPendingStartWorkStore,
  createStartWorkShortHash,
} from "../lib/pending-start-work.js";
import { createStartWorkDispatcher, planCompleteMessage, startWorkKeyboard } from "./start-work.js";
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

describe("start-work telegram dispatcher", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `start-work-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("builds compact legacy callback data and plan completion message", () => {
    const shortHash = createStartWorkShortHash("ses_123");
    assert.deepEqual(startWorkKeyboard(shortHash), [
      [{ text: "▶️ Run /start-work", callback_data: `sw:${shortHash}` }],
    ]);
    assert.equal(
      planCompleteMessage("Remove earnings estimate"),
      "📝 <b>플랜 작성 완료</b>\n\n<b>세션</b>: Remove earnings estimate\n/sessions 확인 후 /start_work N 으로 실행할 수 있어요.",
    );
  });

  test("legacy inline start-work button is disabled and does not run commands", async () => {
    const edited: Array<{ messageId: number; text: string }> = [];
    const commands: Array<{ sessionID: string; command: string; serverUrl?: string }> = [];
    const pendingStartWorks = createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, "disabled"),
    });
    const shortHash = createStartWorkShortHash("ses_123");
    await pendingStartWorks.savePending(shortHash, {
      sessionID: "ses_123",
      serverUrl: "http://localhost:7777/",
      title: "Plan session",
      sentAt: 1,
      expiresAt: Date.now() + 10_000,
      telegramMessageId: 10,
      telegramMessageIds: [10, 11],
    });
    const bot = {
      async editMessageRemoveKeyboard(messageId: number, finalText: string) {
        edited.push({ messageId, text: finalText });
      },
    } as TelegramBotManager;
    const ctx = {
      bot,
      logger: createLogger(),
      pendingStartWorks,
      async runSessionCommand(sessionID: string, command: string, serverUrl?: string) {
        commands.push({ sessionID, command, serverUrl });
      },
    } as unknown as EventHandlerContext;

    const dispatcher = createStartWorkDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`sw:${shortHash}`, 10);

    assert.deepEqual(commands, []);
    assert.deepEqual(
      edited.map((entry) => entry.messageId),
      [10, 11],
    );
    assert.match(edited[0]?.text ?? "", /버튼 사용 중지/);
    assert.equal((await pendingStartWorks.loadPending(shortHash))?.status, "consumed");
  });

  test("consumed legacy inline start-work button remains a no-op", async () => {
    const edited: Array<{ messageId: number; text: string }> = [];
    const commands: Array<{ sessionID: string; command: string; serverUrl?: string }> = [];
    const pendingStartWorks = createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, "consumed"),
    });
    const shortHash = createStartWorkShortHash("ses_123");
    await pendingStartWorks.savePending(shortHash, {
      sessionID: "ses_123",
      sentAt: 1,
      expiresAt: Date.now() + 10_000,
      telegramMessageId: 10,
      status: "consumed",
    });
    const bot = {
      async editMessageRemoveKeyboard(messageId: number, finalText: string) {
        edited.push({ messageId, text: finalText });
      },
    } as TelegramBotManager;
    const ctx = {
      bot,
      logger: createLogger(),
      pendingStartWorks,
      async runSessionCommand(sessionID: string, command: string, serverUrl?: string) {
        commands.push({ sessionID, command, serverUrl });
      },
    } as unknown as EventHandlerContext;

    const dispatcher = createStartWorkDispatcher(ctx);
    await dispatcher.handleCallbackQuery(`sw:${shortHash}`, 10);

    assert.deepEqual(commands, []);
    assert.match(edited[0]?.text ?? "", /버튼 사용 중지/);
  });

  test("does not run start-work without pending plan completion state", async () => {
    const edited: string[] = [];
    const commands: Array<{ sessionID: string; command: string }> = [];
    const bot = {
      async editMessageRemoveKeyboard(_messageId: number, finalText: string) {
        edited.push(finalText);
      },
    } as TelegramBotManager;
    const ctx = {
      bot,
      logger: createLogger(),
      pendingStartWorks: createPendingStartWorkStore({
        tokenHash: "tok",
        baseDir: join(dir, "missing"),
      }),
      async runSessionCommand(sessionID: string, command: string) {
        commands.push({ sessionID, command });
      },
    } as unknown as EventHandlerContext;

    const dispatcher = createStartWorkDispatcher(ctx);
    await dispatcher.handleCallbackQuery("sw:missing", 10);

    assert.deepEqual(commands, []);
    assert.match(edited[0] ?? "", /만료된 요청/);
  });
});
