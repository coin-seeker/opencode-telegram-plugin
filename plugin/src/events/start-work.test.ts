import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import {
  createStartWorkDispatcher,
  extractStartWorkCommand,
  startWorkCallbackData,
  startWorkKeyboard,
  StartWorkCommandStore,
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
    const commands: Array<{ sessionID: string; command: string; args: string }> = [];
    const startWorkCommands = new StartWorkCommandStore();
    startWorkCommands.updateFromText("ses_123", "Continue with /start-work plan-builder-123");
    const bot = {
      async editMessageRemoveKeyboard(_messageId: number, finalText: string) {
        edited.push(finalText);
      },
    } as TelegramBotManager;
    const ctx = {
      bot,
      logger: createLogger(),
      startWorkCommands,
      async runSessionCommand(sessionID: string, command: string, args: string) {
        commands.push({ sessionID, command, args });
      },
    } as unknown as EventHandlerContext;

    const dispatcher = createStartWorkDispatcher(ctx);
    await dispatcher.handleCallbackQuery("sw:ses_123", 10);

    assert.deepEqual(commands, [
      { sessionID: "ses_123", command: "start-work", args: "plan-builder-123" },
    ]);
    assert.match(edited[0] ?? "", /Sent \/start-work plan-builder-123/);
  });

  test("does not run start-work without detected arguments", async () => {
    const edited: string[] = [];
    const commands: Array<{ sessionID: string; command: string; args: string }> = [];
    const bot = {
      async editMessageRemoveKeyboard(_messageId: number, finalText: string) {
        edited.push(finalText);
      },
    } as TelegramBotManager;
    const ctx = {
      bot,
      logger: createLogger(),
      startWorkCommands: new StartWorkCommandStore(),
      async runSessionCommand(sessionID: string, command: string, args: string) {
        commands.push({ sessionID, command, args });
      },
    } as unknown as EventHandlerContext;

    const dispatcher = createStartWorkDispatcher(ctx);
    await dispatcher.handleCallbackQuery("sw:ses_123", 10);

    assert.deepEqual(commands, []);
    assert.match(edited[0] ?? "", /No \/start-work command was detected/);
  });

  test("extracts the latest start-work command with arguments", () => {
    assert.deepEqual(
      extractStartWorkCommand("ses_123", "Plan ready. Run `/start-work boulder-456` when ready."),
      { sessionID: "ses_123", arguments: "boulder-456" },
    );
    assert.equal(extractStartWorkCommand("ses_123", "Run /start-work"), undefined);
  });
});
