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

  test("defaults idleSettleDelayMs to 12000 when unset", () => {
    const config = loadConfig({ logger: createLogger(), env: validEnv() });

    assert.equal(config.idleSettleDelayMs, 12000);
  });

  test("accepts a positive integer TELEGRAM_IDLE_SETTLE_DELAY_MS override", () => {
    const config = loadConfig({
      logger: createLogger(),
      env: validEnv({ TELEGRAM_IDLE_SETTLE_DELAY_MS: "5000" }),
    });

    assert.equal(config.idleSettleDelayMs, 5000);
  });

  test("accepts 0 to disable the idle settle window", () => {
    const config = loadConfig({
      logger: createLogger(),
      env: validEnv({ TELEGRAM_IDLE_SETTLE_DELAY_MS: "0" }),
    });

    assert.equal(config.idleSettleDelayMs, 0);
  });

  test("rejects a non-integer TELEGRAM_IDLE_SETTLE_DELAY_MS", () => {
    assert.throws(
      () =>
        loadConfig({
          logger: createLogger(),
          env: validEnv({ TELEGRAM_IDLE_SETTLE_DELAY_MS: "12s" }),
        }),
      /TELEGRAM_IDLE_SETTLE_DELAY_MS/,
    );
  });

  test("rejects a negative TELEGRAM_IDLE_SETTLE_DELAY_MS", () => {
    assert.throws(
      () =>
        loadConfig({
          logger: createLogger(),
          env: validEnv({ TELEGRAM_IDLE_SETTLE_DELAY_MS: "-1" }),
        }),
      /TELEGRAM_IDLE_SETTLE_DELAY_MS/,
    );
  });
});
