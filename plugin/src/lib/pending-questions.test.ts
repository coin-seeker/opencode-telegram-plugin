import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createPendingQuestionStore, createQuestionShortHash, type PendingQuestionState } from "./pending-questions.js";

function samplePending(expiresAt: number): PendingQuestionState {
  return {
    requestID: "req-1",
    sessionID: "ses-1",
    questions: [{ header: "Pick", question: "Choose?", options: [{ label: "Yes", description: "Confirm" }] }],
    sentAt: Date.now(),
    expiresAt,
    telegramMessageIds: [10],
    currentQuestionIndex: 0,
    answersInProgress: [],
  };
}

describe("pending question store", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `pending-test-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("saves and loads pending state", async () => {
    const store = createPendingQuestionStore({ tokenHash: "tok", baseDir: dir });
    const pending = samplePending(Date.now() + 60_000);
    await store.savePending("abc", pending);
    assert.deepEqual(await store.loadPending("abc"), pending);
  });

  test("finds by request id and awaiting custom", async () => {
    const store = createPendingQuestionStore({ tokenHash: "tok", baseDir: join(dir, "find") });
    const pending = samplePending(Date.now() + 60_000);
    pending.awaitingCustomFor = { shortHash: "abc", questionIndex: 0, chatId: 1, userId: 2, promptMessageId: 3 };
    await store.savePending("abc", pending);
    assert.equal((await store.findByRequestID("req-1"))?.shortHash, "abc");
    assert.equal((await store.findAwaitingCustom(1, 2))?.shortHash, "abc");
    assert.equal(await store.findAwaitingCustom(1, 9), undefined);
  });

  test("sweeps expired entries", async () => {
    const store = createPendingQuestionStore({ tokenHash: "tok", baseDir: join(dir, "expired") });
    await store.savePending("old", samplePending(Date.now() - 1));
    const expired = await store.sweepExpired();
    assert.equal(expired.length, 1);
    assert.equal(await store.loadPending("old"), undefined);
  });

  test("creates stable 10-character base64url hash", () => {
    const hash = createQuestionShortHash("request-id");
    assert.equal(hash.length, 10);
    assert.match(hash, /^[A-Za-z0-9_-]+$/);
  });
});
