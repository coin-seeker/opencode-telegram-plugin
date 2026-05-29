import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPendingPermissionStore, createPermissionShortHash } from "./pending-permissions.js";

describe("pending permission store", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `pending-permissions-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("saves, loads, finds, and deletes pending permissions", async () => {
    const store = createPendingPermissionStore({ tokenHash: "tok", baseDir: dir });
    const shortHash = createPermissionShortHash("per_test");

    await store.savePending(shortHash, {
      requestID: "per_test",
      sessionID: "ses_test",
      title: "Read .env",
      permission: "read",
      patterns: [".env"],
      always: [".env"],
      serverUrl: "http://localhost:4096/",
      sentAt: 1,
      expiresAt: Date.now() + 10_000,
      telegramMessageId: 10,
      endpoint: "request",
    });

    assert.deepEqual((await store.loadPending(shortHash))?.patterns, [".env"]);
    assert.equal((await store.findByRequestID("per_test"))?.shortHash, shortHash);
    assert.equal((await store.findByRequestID("per_test", "ses_test"))?.shortHash, shortHash);
    assert.equal(
      (await store.findByRequestID("per_test", "ses_test", "http://localhost:4096/"))?.shortHash,
      shortHash,
    );
    assert.equal(await store.findByRequestID("per_test", "ses_other"), undefined);
    assert.equal(
      await store.findByRequestID("per_test", "ses_test", "http://localhost:5099/"),
      undefined,
    );
    await store.deletePending(shortHash);
    assert.equal(await store.loadPending(shortHash), undefined);
  });

  test("sweeps expired pending permissions", async () => {
    const store = createPendingPermissionStore({ tokenHash: "tok", baseDir: join(dir, "expired") });
    const shortHash = createPermissionShortHash("per_expired");

    await store.savePending(shortHash, {
      requestID: "per_expired",
      sessionID: "ses_test",
      title: "Read .env",
      permission: "read",
      patterns: [".env"],
      always: [],
      sentAt: 1,
      expiresAt: Date.now() - 1_000,
      telegramMessageId: 10,
      endpoint: "session",
    });

    assert.equal((await store.sweepExpired()).length, 1);
    assert.equal(await store.loadPending(shortHash), undefined);
  });
});
