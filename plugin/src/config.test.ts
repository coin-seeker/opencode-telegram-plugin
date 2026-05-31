import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "./config.js";

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

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOWED_USER_IDS: "123456789",
    ...overrides,
  };
}

describe("loadConfig", () => {
  test("rejects partially numeric allowed user ids", () => {
    assert.throws(
      () =>
        loadConfig({
          logger: createLogger(),
          env: validEnv({ TELEGRAM_ALLOWED_USER_IDS: "123abc" }),
        }),
      /TELEGRAM_ALLOWED_USER_IDS/,
    );
  });

  test("rejects partially numeric chat id", () => {
    assert.throws(
      () =>
        loadConfig({
          logger: createLogger(),
          env: validEnv({ TELEGRAM_CHAT_ID: "123abc" }),
        }),
      /TELEGRAM_CHAT_ID/,
    );
  });

  test("accepts comma separated integer user ids", () => {
    const config = loadConfig({
      logger: createLogger(),
      env: validEnv({ TELEGRAM_ALLOWED_USER_IDS: "123, 456" }),
    });

    assert.deepEqual(config.allowedUserIds, [123, 456]);
  });
});
