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

  test("builds compact callback data and plan completion message", () => {
    const shortHash = createStartWorkShortHash("ses_123");
    assert.deepEqual(startWorkKeyboard(shortHash), [
      [{ text: "▶️ Run /start-work", callback_data: `sw:${shortHash}` }],
    ]);
    assert.equal(
      planCompleteMessage("Remove earnings estimate"),
      "plan 작성이 끝났어요.\n\nRemove earnings estimate",
    );
  });

  test("sends start-work command to the original session server", async () => {
    const edited: string[] = [];
    const commands: Array<{ sessionID: string; command: string; serverUrl?: string }> = [];
    const pendingStartWorks = createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, "send"),
    });
    const shortHash = createStartWorkShortHash("ses_123");
    await pendingStartWorks.savePending(shortHash, {
      sessionID: "ses_123",
      serverUrl: "http://localhost:7777",
      title: "Plan session",
      sentAt: 1,
      expiresAt: Date.now() + 10_000,
      telegramMessageId: 10,
    });
    const bot = {
      async editMessageRemoveKeyboard(_messageId: number, finalText: string) {
        edited.push(finalText);
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

    assert.deepEqual(commands, [
      { sessionID: "ses_123", command: "start-work", serverUrl: "http://localhost:7777" },
    ]);
    assert.match(edited[0] ?? "", /Sent \/start-work/);
    assert.equal(await pendingStartWorks.loadPending(shortHash), undefined);
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
    assert.match(edited[0] ?? "", /expired/);
  });
});
