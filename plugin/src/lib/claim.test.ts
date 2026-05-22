import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { claimOnce } from "./claim.js";

describe("claimOnce", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `test-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("claims a key once", async () => {
    const claimsDir = join(dir, "happy");
    assert.equal(await claimOnce({ claimsDir, key: "event-1" }), true);
    assert.equal(await claimOnce({ claimsDir, key: "event-1" }), false);
  });

  test("creates missing directory", async () => {
    const claimsDir = join(dir, "missing", "claims");
    assert.equal(await claimOnce({ claimsDir, key: "event-2" }), true);
    const entries = await readdir(claimsDir);
    assert.equal(entries.length, 1);
  });

  test("reclaims stale claim", async () => {
    const claimsDir = join(dir, "stale");
    assert.equal(await claimOnce({ claimsDir, key: "event-3", ttlMs: 1 }), true);
    const entries = await readdir(claimsDir);
    const filePath = join(claimsDir, entries[0] ?? "missing.claim");
    const old = new Date(Date.now() - 10_000);
    await utimes(filePath, old, old);
    assert.equal(await claimOnce({ claimsDir, key: "event-3", ttlMs: 1 }), true);
  });

  test("sweeps old claim files on first access", async () => {
    const claimsDir = join(dir, "sweep");
    await mkdir(claimsDir);
    const filePath = join(claimsDir, "old.claim");
    await writeFile(filePath, "old", "utf8");
    const old = new Date(Date.now() - 100_000);
    await utimes(filePath, old, old);
    assert.equal(await claimOnce({ claimsDir: join(dir, "sweep"), key: "new", ttlMs: 10 }), true);
    const remaining = await readdir(claimsDir);
    assert.equal(remaining.length, 1);
  });

  test("returns false on stale unlink conflict", async () => {
    const claimsDir = join(dir, "conflict");
    await claimOnce({ claimsDir, key: "event-4", ttlMs: 1 });
    const entries = await readdir(claimsDir);
    await writeFile(join(claimsDir, entries[0] ?? "missing.claim"), "touch");
    assert.equal(await claimOnce({ claimsDir, key: "event-4", ttlMs: 60_000 }), false);
  });
});
