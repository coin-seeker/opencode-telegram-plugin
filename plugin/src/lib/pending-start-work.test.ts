import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const loaded = await store.loadPending(shortHash);
    assert.equal(loaded?.sessionID, "ses_test");
    assert.deepEqual(loaded?.telegramMessageIds, [10]);
    assert.equal(loaded?.status, "pending");
    await store.deletePending(shortHash);
    assert.equal(await store.loadPending(shortHash), undefined);
  });

  test("loads legacy scalar message state", async () => {
    const store = createPendingStartWorkStore({ tokenHash: "tok", baseDir: join(dir, "legacy") });
    const shortHash = createStartWorkShortHash("ses_legacy");
    await mkdir(store.dir, { recursive: true });
    await writeFile(
      join(store.dir, `${shortHash}.json`),
      JSON.stringify({
        sessionID: "ses_legacy",
        sentAt: 1,
        expiresAt: Date.now() + 10_000,
        telegramMessageId: 10,
      }),
      "utf8",
    );

    const loaded = await store.loadPending(shortHash);

    assert.deepEqual(loaded?.telegramMessageIds, [10]);
    assert.equal(loaded?.status, "pending");
  });

  test("loads multi-message consumed state", async () => {
    const store = createPendingStartWorkStore({
      tokenHash: "tok",
      baseDir: join(dir, "multi-message"),
    });
    const shortHash = createStartWorkShortHash("ses_consumed");
    await store.savePending(shortHash, {
      sessionID: "ses_consumed",
      sentAt: 1,
      expiresAt: Date.now() + 10_000,
      telegramMessageId: 10,
      telegramMessageIds: [10, 11],
      status: "consumed",
      handledAt: 123,
    });

    const loaded = await store.loadPending(shortHash);

    assert.deepEqual(loaded?.telegramMessageIds, [10, 11]);
    assert.equal(loaded?.status, "consumed");
    assert.equal(loaded?.handledAt, 123);
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
