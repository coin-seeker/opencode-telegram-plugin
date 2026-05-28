import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createSnapshotStore, type SnapshotEntry } from "./session-snapshot.js";

interface LoggerCall {
  msg: string;
  data?: Record<string, unknown>;
}

function createMockLogger(): { error(msg: string, data?: Record<string, unknown>): void; calls: LoggerCall[] } {
  const calls: LoggerCall[] = [];
  return {
    error(msg: string, data?: Record<string, unknown>) {
      calls.push({ msg, data });
    },
    calls,
  };
}

function makeEntry(i: number, overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    index: i,
    sessionId: `ses_${i}`,
    title: `Title ${i}`,
    capturedAt: 1_700_000_000_000 + i,
    ...overrides,
  };
}

describe("createSnapshotStore", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `snap-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  let suiteCounter = 0;
  function freshConfigDir(): string {
    suiteCounter += 1;
    return join(dir, `c${suiteCounter}`);
  }

  test("save+load roundtrip returns exact entries", async () => {
    const logger = createMockLogger();
    const store = createSnapshotStore({
      configDir: freshConfigDir(),
      tokenHash: "abc123",
      logger,
    });
    const entries: SnapshotEntry[] = [
      makeEntry(1, { agent: "build", status: "idle", serverUrl: "http://x" }),
      makeEntry(2),
    ];
    await store.saveSnapshot(42, entries);
    const loaded = await store.loadSnapshot(42);
    assert.deepEqual(loaded, entries);
    assert.equal(logger.calls.length, 0);
  });

  test("file not found returns null", async () => {
    const logger = createMockLogger();
    const store = createSnapshotStore({
      configDir: freshConfigDir(),
      tokenHash: "abc123",
      logger,
    });
    const loaded = await store.loadSnapshot(999);
    assert.equal(loaded, null);
    assert.equal(logger.calls.length, 0);
  });

  test("TTL expired -> null and file deleted", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(7, [makeEntry(1)]);
    const path = store.snapshotFilePath(7);

    // rewrite createdAt to 2 hours ago
    const text = await readFile(path, "utf8");
    const obj = JSON.parse(text) as { createdAt: number };
    obj.createdAt = Date.now() - 2 * 60 * 60 * 1000;
    await writeFile(path, JSON.stringify(obj), "utf8");

    const loaded = await store.loadSnapshot(7);
    assert.equal(loaded, null);
    await assert.rejects(stat(path), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  });

  test("TTL boundary: just within 1h returns entries", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(8, [makeEntry(1)]);
    const path = store.snapshotFilePath(8);
    const text = await readFile(path, "utf8");
    const obj = JSON.parse(text) as { createdAt: number };
    obj.createdAt = Date.now() - 59 * 60 * 1000; // 59 minutes ago
    await writeFile(path, JSON.stringify(obj), "utf8");
    const loaded = await store.loadSnapshot(8);
    assert.ok(loaded);
    assert.equal(loaded?.length, 1);
  });

  test("corrupted JSON -> null and logger.error called", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    // save a valid file first to ensure dir exists
    await store.saveSnapshot(5, [makeEntry(1)]);
    const path = store.snapshotFilePath(5);
    await writeFile(path, "{not valid json", "utf8");
    const loaded = await store.loadSnapshot(5);
    assert.equal(loaded, null);
    assert.ok(logger.calls.length >= 1);
    assert.match(logger.calls[0]!.msg, /corrupted JSON/);
  });

  test("invalid shape -> null and logger.error called", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(11, [makeEntry(1)]);
    const path = store.snapshotFilePath(11);
    await writeFile(path, JSON.stringify({ version: 2, foo: "bar" }), "utf8");
    const loaded = await store.loadSnapshot(11);
    assert.equal(loaded, null);
    assert.ok(logger.calls.some((c) => /invalid shape/.test(c.msg)));
  });

  test("saved file is chmod 600", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(1, [makeEntry(1)]);
    const path = store.snapshotFilePath(1);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test("parent dir is chmod 700", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(2, [makeEntry(1)]);
    const parent = join(configDir, "snapshots");
    const mode = statSync(parent).mode & 0o777;
    assert.equal(mode, 0o700);
  });

  test("different chatIds get different files", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "hashA", logger });
    await store.saveSnapshot(100, [makeEntry(10)]);
    await store.saveSnapshot(200, [makeEntry(20)]);
    const a = await store.loadSnapshot(100);
    const b = await store.loadSnapshot(200);
    assert.equal(a?.[0]?.index, 10);
    assert.equal(b?.[0]?.index, 20);
    assert.notEqual(store.snapshotFilePath(100), store.snapshotFilePath(200));
  });

  test("different tokenHash isolates files for same chatId", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const storeA = createSnapshotStore({ configDir, tokenHash: "hashA", logger });
    const storeB = createSnapshotStore({ configDir, tokenHash: "hashB", logger });
    await storeA.saveSnapshot(50, [makeEntry(1)]);
    const loadedB = await storeB.loadSnapshot(50);
    assert.equal(loadedB, null);
  });

  test("snapshot filename contains tokenHash and chatId, not raw token", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({
      configDir,
      tokenHash: "deadbeefcafef00d",
      logger,
    });
    const path = store.snapshotFilePath(7);
    assert.match(path, /deadbeefcafef00d-7\.json$/);
  });

  test("concurrent saves same chatId are serialized (last write wins, no corruption)", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    const a = store.saveSnapshot(77, [makeEntry(1), makeEntry(2)]);
    const b = store.saveSnapshot(77, [makeEntry(10), makeEntry(20), makeEntry(30)]);
    const c = store.saveSnapshot(77, [makeEntry(100)]);
    await Promise.all([a, b, c]);
    const loaded = await store.loadSnapshot(77);
    assert.ok(loaded);
    // last queued write should win
    assert.equal(loaded?.length, 1);
    assert.equal(loaded?.[0]?.index, 100);
    // file should still be valid JSON (no temp leftovers in main path)
    const text = await readFile(store.snapshotFilePath(77), "utf8");
    JSON.parse(text);
  });

  test("repeated save overwrites previous content", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(3, [makeEntry(1)]);
    await store.saveSnapshot(3, [makeEntry(2), makeEntry(3)]);
    const loaded = await store.loadSnapshot(3);
    assert.equal(loaded?.length, 2);
    assert.equal(loaded?.[0]?.index, 2);
    assert.equal(loaded?.[1]?.index, 3);
  });

  test("optional fields omitted when not provided", async () => {
    const logger = createMockLogger();
    const configDir = freshConfigDir();
    const store = createSnapshotStore({ configDir, tokenHash: "abc123", logger });
    await store.saveSnapshot(4, [makeEntry(1)]);
    const loaded = await store.loadSnapshot(4);
    assert.ok(loaded);
    const entry = loaded![0]!;
    assert.equal(entry.agent, undefined);
    assert.equal(entry.status, undefined);
    assert.equal(entry.serverUrl, undefined);
  });
});
