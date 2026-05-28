import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TelegramBotManager } from "../bot.js";
import type { Logger } from "../lib/logger.js";
import { createHelpDispatcher } from "./help-command.js";

interface SendCall {
  text: string;
  opts: Parameters<TelegramBotManager["sendMessage"]>[1];
}

interface LogCall {
  msg: string;
  data: Parameters<Logger["info"]>[1];
}

function makeBot(calls: SendCall[]): TelegramBotManager {
  return {
    async start() {},
    async stop() {},
    async sendMessage(text, opts) {
      calls.push({ text, opts });
      return { message_id: 1 };
    },
    async sendQuestionWithKeyboard() {
      return { message_id: 1 };
    },
    async editMessage() {},
    async editMessageText() {},
    async editMessageRemoveKeyboard() {},
    async replyWithForceReply() {
      return { message_id: 1 };
    },
    async deleteMessage() {},
    async getActiveChatId() {
      return undefined;
    },
    setQuestionDispatcher() {},
    setPermissionDispatcher() {},
    setStartWorkDispatcher() {},
  };
}

function makeLogger(logs: LogCall[]): Pick<Logger, "info"> {
  return {
    info(msg, data) {
      logs.push({ msg, data });
    },
  };
}

describe("help-command dispatcher", () => {
  test("sends help text with parse_mode HTML", async () => {
    const calls: SendCall[] = [];
    const logs: LogCall[] = [];
    const dispatcher = createHelpDispatcher({ logger: makeLogger(logs) });

    await dispatcher({ chatId: 42, userId: 1, bot: makeBot(calls) });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.opts?.parse_mode, "HTML");
  });

  test("help text contains all 4 Telegram commands", async () => {
    const calls: SendCall[] = [];
    const logs: LogCall[] = [];
    const dispatcher = createHelpDispatcher({ logger: makeLogger(logs) });

    await dispatcher({ chatId: 42, userId: 1, bot: makeBot(calls) });

    const text = calls[0]?.text ?? "";
    assert.ok(text.includes("/sessions"));
    assert.ok(text.includes("/status"));
    assert.ok(text.includes("/start_work"));
    assert.ok(text.includes("/help"));
  });

  test("help text mentions TTL and leader constraints", async () => {
    const calls: SendCall[] = [];
    const logs: LogCall[] = [];
    const dispatcher = createHelpDispatcher({ logger: makeLogger(logs) });

    await dispatcher({ chatId: 42, userId: 1, bot: makeBot(calls) });

    const text = calls[0]?.text ?? "";
    assert.ok(text.includes("TTL") || text.includes("1시간"));
    assert.ok(text.includes("leader"));
  });

  test("logs chatId without message body", async () => {
    const calls: SendCall[] = [];
    const logs: LogCall[] = [];
    const dispatcher = createHelpDispatcher({ logger: makeLogger(logs) });

    await dispatcher({ chatId: 42, userId: 1, bot: makeBot(calls) });

    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.msg, "help shown");
    assert.equal(logs[0]?.data?.chatId, 42);
    assert.equal(Object.prototype.hasOwnProperty.call(logs[0]?.data ?? {}, "text"), false);
  });
});
