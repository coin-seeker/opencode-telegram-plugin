import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createStateStore } from "./state-store.js";

describe("createStateStore", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `test-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns empty state for ENOENT", async () => {
    const store = createStateStore({ filePath: join(dir, "missing", "state.json") });
    assert.deepEqual(await store.read(), {});
  });

  test("writes and reads merged state atomically", async () => {
    const filePath = join(dir, "happy", "state.json");
    const store = createStateStore({ filePath });
    const first = await store.write({ chatId: 123 });
    assert.equal(first.chatId, 123);
    assert.equal(typeof first.updatedAt, "string");
    const second = await store.write({ discoveredBy: 456 });
    assert.equal(second.chatId, 123);
    assert.equal(second.discoveredBy, 456);
    assert.deepEqual(await store.read(), second);
  });

  test("ignores unsupported JSON fields", async () => {
    const filePath = join(dir, "extra", "state.json");
    await rm(dirname(filePath), { recursive: true, force: true });
    const store = createStateStore({ filePath });
    await store.write({ chatId: 1 });
    await writeFile(filePath, JSON.stringify({ chatId: 2, extra: true }), "utf8");
    assert.deepEqual(await store.read(), { chatId: 2 });
  });

  test("surfaces malformed JSON errors", async () => {
    const filePath = join(dir, "bad.json");
    await writeFile(filePath, "not-json", "utf8");
    const store = createStateStore({ filePath });
    await assert.rejects(store.read(), SyntaxError);
  });

  test("last atomic writer wins in conflict simulation", async () => {
    const filePath = join(dir, "conflict", "state.json");
    const storeA = createStateStore({ filePath });
    const storeB = createStateStore({ filePath });
    await Promise.all([storeA.write({ chatId: 10 }), storeB.write({ chatId: 20 })]);
    const state = await storeA.read();
    assert.ok(state.chatId === 10 || state.chatId === 20);
    assert.equal(typeof (await readFile(filePath, "utf8")), "string");
  });
});
