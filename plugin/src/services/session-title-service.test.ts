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

  test("sets lastSeenAt on setSessionTitle", () => {
    const service = new SessionTitleService();
    const before = Date.now();

    service.setSessionTitle("s1", "Title");

    const entry = service["sessions"].get("s1");
    assert.ok(entry);
    assert.ok(entry.lastSeenAt >= before);
  });

  test("sets lastSeenAt on setSessionStatus", () => {
    const service = new SessionTitleService();
    const before = Date.now();

    service.setSessionStatus("s1", "idle");

    const entry = service["sessions"].get("s1");
    assert.ok(entry);
    assert.ok(entry.lastSeenAt >= before);
  });

  test("setServerUrl is idempotent (first write wins)", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("s1", "Title"));

    service.setServerUrl("s1", "http://first");
    service.setServerUrl("s1", "http://second");

    assert.equal(service.getServerUrl("s1"), "http://first");
  });

  test("getRootSessionsByRecency returns parentID===null sessions sorted desc, limited", () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;

    try {
      const service = new SessionTitleService();
      service.setSessionInfo(createSession("root1", "Root1"));
      now += 100;
      service.setSessionInfo(createSession("child1", "Child1", "root1"));
      now += 100;
      service.setSessionInfo(createSession("root2", "Root2"));

      const results = service.getRootSessionsByRecency(10);

      assert.equal(results.length, 2);
      assert.deepEqual(
        results.map((result) => result.sessionId),
        ["root2", "root1"],
      );
      assert.ok(results.every((result) => result.sessionId !== "child1"));
      assert.deepEqual(
        service.getRootSessionsByRecency(1).map((result) => result.sessionId),
        ["root2"],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("getRootSessionsByRecency empty map returns []", () => {
    const service = new SessionTitleService();

    assert.deepEqual(service.getRootSessionsByRecency(10), []);
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

describe("SessionTitleService idle settle window", () => {
  test("beginIdleSettle records the start time and is idempotent", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));

    assert.equal(service.beginIdleSettle("root", 1000), 1000);
    assert.equal(service.beginIdleSettle("root", 5000), 1000);
  });

  test("remainingIdleSettleMs counts down from the settle start", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));
    service.beginIdleSettle("root", 1000);

    assert.equal(service.remainingIdleSettleMs("root", 12000, 1000), 12000);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 7000), 6000);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 13000), 0);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 99999), 0);
  });

  test("remainingIdleSettleMs returns the full delay when settle not started", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));

    assert.equal(service.remainingIdleSettleMs("root", 12000, 1000), 12000);
  });

  test("clearIdleSettle resets the settle start and the sent flag", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));
    service.beginIdleSettle("root", 1000);
    service.markIdleNotificationSent("root", 1000);

    assert.equal(service.hasIdleNotificationSent("root"), true);

    service.clearIdleSettle("root");

    assert.equal(service.hasIdleNotificationSent("root"), false);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 1000), 12000);
  });

  test("markIdleNotificationSent toggles hasIdleNotificationSent", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));

    assert.equal(service.hasIdleNotificationSent("root"), false);

    service.markIdleNotificationSent("root", 1000);

    assert.equal(service.hasIdleNotificationSent("root"), true);
  });

  test("setSessionStatus non-idle clears settle start and sent flag", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));
    service.beginIdleSettle("root", 1000);
    service.markIdleNotificationSent("root", 1000);

    service.setSessionStatus("root", "busy");

    assert.equal(service.hasIdleNotificationSent("root"), false);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 1000), 12000);
  });

  test("setSessionStatus retry clears settle start and sent flag", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));
    service.beginIdleSettle("root", 1000);
    service.markIdleNotificationSent("root", 1000);

    service.setSessionStatus("root", "retry");

    assert.equal(service.hasIdleNotificationSent("root"), false);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 1000), 12000);
  });

  test("setSessionStatus idle preserves settle start and sent flag", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));
    service.beginIdleSettle("root", 1000);
    service.markIdleNotificationSent("root", 1000);

    service.setSessionStatus("root", "idle");

    assert.equal(service.hasIdleNotificationSent("root"), true);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 7000), 6000);
  });

  test("setSessionInfo preserves settle start and sent flag", () => {
    const service = new SessionTitleService();
    service.setSessionInfo(createSession("root", "Root"));
    service.beginIdleSettle("root", 1000);
    service.markIdleNotificationSent("root", 1000);

    service.setSessionInfo(createSession("root", "Root renamed"));

    assert.equal(service.hasIdleNotificationSent("root"), true);
    assert.equal(service.remainingIdleSettleMs("root", 12000, 7000), 6000);
  });
});
