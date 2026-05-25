import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Session } from "@opencode-ai/sdk";
import { SessionTitleService } from "./session-title-service.js";

function createSession(id: string, title: string, parentID?: string): Session {
  return {
    id,
    projectID: "project-1",
    directory: "/tmp/project",
    parentID,
    title,
    version: "1",
    time: {
      created: 1,
      updated: 2,
    },
  };
}

describe("SessionTitleService", () => {
  test("stores title and child parentID from full session info", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("child", "Child title", "parent"));

    assert.equal(service.getSessionTitle("child"), "Child title");
    assert.equal(service.getParentID("child"), "parent");
  });

  test("stores null parentID when session has no parent", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("main", "Main title"));

    assert.equal(service.getParentID("main"), null);
  });

  test("returns undefined parentID for cache misses", () => {
    const service = new SessionTitleService();

    assert.equal(service.getParentID("missing"), undefined);
    assert.equal(service.getSessionTitle("missing"), null);
  });

  test("setSessionStatus does not convert unknown parentID to known root", () => {
    const service = new SessionTitleService();

    service.setSessionStatus("first-seen", "idle");

    assert.equal(service.getParentID("first-seen"), undefined);
  });

  test("setSessionTitle preserves existing parentID", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("child", "Old", "parent"));
    service.setSessionTitle("child", "New");

    assert.equal(service.getSessionTitle("child"), "New");
    assert.equal(service.getParentID("child"), "parent");
  });

  test("tracks the selected agent without losing it on later updates", () => {
    const service = new SessionTitleService();
    service.setSessionAgent("plan-session", "plan");
    service.setSessionInfo(createSession("plan-session", "Plan title"));
    service.setSessionStatus("plan-session", "idle");

    assert.equal(service.getSessionAgent("plan-session"), "plan");
  });

  test("tracks unfinished children by parent", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent", "Parent"));
    service.setSessionInfo(createSession("child", "Child", "parent"));

    assert.equal(service.hasUnfinishedDescendants("parent"), true);

    service.setSessionStatus("child", "idle");

    assert.equal(service.hasUnfinishedDescendants("parent"), false);
  });

  test("tracks unfinished nested descendants by parent", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent", "Parent"));
    service.setSessionInfo(createSession("child", "Child", "parent"));
    service.setSessionInfo(createSession("grandchild", "Grandchild", "child"));
    service.setSessionStatus("child", "idle");

    assert.equal(service.hasUnfinishedDescendants("parent"), true);

    service.setSessionStatus("grandchild", "idle");

    assert.equal(service.hasUnfinishedDescendants("parent"), false);
  });

  test("preserves deferred parent idle notification state", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("parent", "Parent"));
    service.deferIdleNotification("parent");

    assert.equal(service.hasDeferredIdleNotification("parent"), true);

    service.setSessionInfo(createSession("parent", "Updated parent"));

    assert.equal(service.hasDeferredIdleNotification("parent"), true);

    service.clearDeferredIdleNotification("parent");

    assert.equal(service.hasDeferredIdleNotification("parent"), false);
  });
});
