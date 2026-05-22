import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { acquireLock } from "./lock.js";

describe("acquireLock", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `test-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates and releases a lock", async () => {
    const lockPath = join(dir, "happy.lock");
    const result = await acquireLock({ lockPath });
    assert.equal(result.acquired, true);
    if (result.acquired) {
      const text = await readFile(lockPath, "utf8");
      assert.match(text, new RegExp(`\"pid\":${process.pid}`));
      await result.handle.release();
      await result.handle.release();
    }
  });

  test("returns false for an active existing lock", async () => {
    const lockPath = join(dir, "exists.lock");
    const first = await acquireLock({ lockPath });
    assert.equal(first.acquired, true);
    const second = await acquireLock({ lockPath });
    assert.equal(second.acquired, false);
    if (!second.acquired) assert.equal(second.ownerPid, process.pid);
    if (first.acquired) await first.handle.release();
  });

  test("takes over stale lock with dead pid", async () => {
    const lockPath = join(dir, "dead.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 9_999_999, hostname: "test", createdAt: new Date().toISOString() }));
    const result = await acquireLock({ lockPath });
    assert.equal(result.acquired, true);
    if (result.acquired) await result.handle.release();
  });

  test("takes over stale lock by mtime", async () => {
    const lockPath = join(dir, "old.lock");
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: "test", createdAt: new Date().toISOString() }));
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const result = await acquireLock({ lockPath, ttlMs: 1 });
    assert.equal(result.acquired, true);
    if (result.acquired) await result.handle.release();
  });

  test("reports ENOENT parent directory conflict", async () => {
    const lockPath = join(dir, "missing", "bad.lock");
    const result = await acquireLock({ lockPath });
    assert.equal(result.acquired, false);
    if (!result.acquired) assert.match(result.reason, /ENOENT|no such file/i);
  });

  test("survives stale unlink conflict", async () => {
    const parent = join(dir, "conflict");
    await mkdir(parent);
    const lockPath = join(parent, "race.lock");
    await writeFile(lockPath, "bad-json");
    await rm(lockPath);
    const result = await acquireLock({ lockPath });
    assert.equal(result.acquired, true);
    if (result.acquired) await result.handle.release();
  });
});
