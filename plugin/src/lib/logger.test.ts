import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `test-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes buffered lines on flush", async () => {
    const filePath = join(dir, "happy.log");
    const logger = createLogger({ filePath, namespace: "unit", flushIntervalMs: 60_000 });
    logger.info("hello", { value: 1 });
    await logger.flush();
    const text = await readFile(filePath, "utf8");
    assert.match(text, /\[info\] \[\d+\] \[unit\] hello \{"value":1\}/);
    await logger.close();
  });

  test("flushes immediately for error", async () => {
    const filePath = join(dir, "error.log");
    const logger = createLogger({ filePath, namespace: "unit", flushIntervalMs: 60_000 });
    logger.error("boom", { reason: "test" });
    await logger.close();
    const text = await readFile(filePath, "utf8");
    assert.match(text, /\[error\].*boom/);
  });

  test("flushes when buffer limit is reached", async () => {
    const filePath = join(dir, "limit.log");
    const logger = createLogger({ filePath, bufferLimit: 10, flushIntervalMs: 60_000 });
    logger.debug("long enough");
    await logger.flush();
    const text = await readFile(filePath, "utf8");
    assert.match(text, /long enough/);
    await logger.close();
  });

  test("swallows append errors", async () => {
    const logger = createLogger({ filePath: join(dir, "missing", "bad.log"), flushIntervalMs: 60_000 });
    logger.info("will not throw");
    await assert.doesNotReject(logger.close());
  });
});
