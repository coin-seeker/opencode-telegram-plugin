import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPendingStartWorkStore, createStartWorkShortHash } from "./pending-start-work.js";

describe("pending start-work store", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `pending-start-work-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("saves, loads, and deletes pending start-work state", async () => {
    const store = createPendingStartWorkStore({ tokenHash: "tok", baseDir: dir });
    const shortHash = createStartWorkShortHash("ses_test");

    await store.savePending(shortHash, {
      sessionID: "ses_test",
      serverUrl: "http://localhost:4096",
      title: "Plan session",
      sentAt: 1,
      expiresAt: Date.now() + 10_000,
      telegramMessageId: 10,
    });

    assert.equal((await store.loadPending(shortHash))?.sessionID, "ses_test");
    await store.deletePending(shortHash);
    assert.equal(await store.loadPending(shortHash), undefined);
  });

  test("sweeps expired pending start-work entries", async () => {
    const store = createPendingStartWorkStore({ tokenHash: "tok", baseDir: join(dir, "expired") });
    const shortHash = createStartWorkShortHash("ses_expired");

    await store.savePending(shortHash, {
      sessionID: "ses_expired",
      sentAt: 1,
      expiresAt: Date.now() - 1_000,
      telegramMessageId: 10,
    });

    assert.equal((await store.sweepExpired()).length, 1);
    assert.equal(await store.loadPending(shortHash), undefined);
  });

  test("creates stable 10-character base64url hash", () => {
    const hash = createStartWorkShortHash("ses_test");
    assert.equal(hash.length, 10);
    assert.match(hash, /^[A-Za-z0-9_-]+$/);
  });
});
