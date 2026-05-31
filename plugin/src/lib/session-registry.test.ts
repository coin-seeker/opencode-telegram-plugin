import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createSessionRegistryStore } from "./session-registry.js";

function createLogger() {
  return {
    error() {},
  };
}

describe("createSessionRegistryStore", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `session-registry-${randomUUID()}`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("updateSession can clear parentID to null", async () => {
    const store = createSessionRegistryStore({
      configDir: join(dir, "clear-parent"),
      tokenHash: "tok",
      logger: createLogger(),
    });
    await store.upsertSession({
      sessionId: "ses_child",
      title: "Child",
      parentID: "ses_parent",
      serverUrl: "http://localhost:4096/",
      updatedAt: 1,
    });

    await store.updateSession("ses_child", { parentID: null, updatedAt: 2 });

    assert.deepEqual(await store.listSessions(), [
      {
        sessionId: "ses_child",
        title: "Child",
        parentID: null,
        serverUrl: "http://localhost:4096/",
        updatedAt: 2,
      },
    ]);
  });
});
