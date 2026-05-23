import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import {
  createStartWorkDispatcher,
  startWorkCallbackData,
  startWorkKeyboard,
} from "./start-work.js";
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
  test("builds compact callback data and keyboard", () => {
    assert.equal(startWorkCallbackData("ses_123"), "sw:ses_123");
    assert.deepEqual(startWorkKeyboard("ses_123"), [
      [{ text: "▶️ Run /start-work", callback_data: "sw:ses_123" }],
    ]);
  });

  test("sends start-work command to the selected session", async () => {
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
      async runSessionCommand(sessionID: string, command: string) {
        commands.push({ sessionID, command });
      },
    } as unknown as EventHandlerContext;

    const dispatcher = createStartWorkDispatcher(ctx);
    await dispatcher.handleCallbackQuery("sw:ses_123", 10);

    assert.deepEqual(commands, [{ sessionID: "ses_123", command: "start-work" }]);
    assert.match(edited[0] ?? "", /Sent \/start-work/);
  });
});
