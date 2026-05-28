import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { OpencodeClient } from "../events/types.js";
import { checkPlanReadiness, recheckSessionIdle } from "./plan-readiness.js";

describe("checkPlanReadiness", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `plan-test-${randomUUID()}-`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("no-omo-dir: returns no-omo-dir when .omo missing", async () => {
    const root = join(dir, "no-omo");
    await mkdir(root, { recursive: true });
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.equal(result.reason, "no-omo-dir");
      assert.match(result.detail, /does not exist/);
    }
  });

  test("boulder-active: returns boulder-active when boulder.json exists", async () => {
    const root = join(dir, "boulder");
    await mkdir(join(root, ".omo"), { recursive: true });
    await writeFile(join(root, ".omo", "boulder.json"), "{}");
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.equal(result.reason, "boulder-active");
    }
  });

  test("no-plans: returns no-plans when .omo/plans missing", async () => {
    const root = join(dir, "no-plans-dir");
    await mkdir(join(root, ".omo"), { recursive: true });
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.equal(result.reason, "no-plans");
    }
  });

  test("no-plans: returns no-plans when .omo/plans empty", async () => {
    const root = join(dir, "empty-plans");
    await mkdir(join(root, ".omo", "plans"), { recursive: true });
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.equal(result.reason, "no-plans");
      assert.match(result.detail, /No \.md files/);
    }
  });

  test("plan-empty: returns plan-empty when plan has no checkboxes", async () => {
    const root = join(dir, "plan-empty");
    const plansDir = join(root, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "plan.md"),
      "# Plan title\n\nSome description text.\nNo checkboxes here.\n",
    );
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.equal(result.reason, "plan-empty");
    }
  });

  test("all-plans-complete: returns all-plans-complete when all checkboxes done", async () => {
    const root = join(dir, "all-done");
    const plansDir = join(root, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "plan.md"),
      "# Plan\n\n- [x] Task 1\n- [x] Task 2\n- [X] Task 3\n",
    );
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.equal(result.reason, "all-plans-complete");
      assert.match(result.detail, /3\/3/);
    }
  });

  test("ready happy: plan with 1 done, 5 pending → ready=true", async () => {
    const root = join(dir, "happy");
    const plansDir = join(root, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "my-plan.md"),
      [
        "# My plan",
        "",
        "- [x] Done item",
        "- [ ] Pending 1",
        "- [ ] Pending 2",
        "- [ ] Pending 3",
        "- [ ] Pending 4",
        "- [ ] Pending 5",
        "",
      ].join("\n"),
    );
    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, true);
    if (result.ready) {
      assert.equal(result.total, 6);
      assert.equal(result.completed, 1);
      assert.equal(result.planName, "my-plan");
      assert.match(result.planPath, /my-plan\.md$/);
    }
  });

  test("multiple plans: most recent mtime is selected", async () => {
    const root = join(dir, "multi-plan");
    const plansDir = join(root, ".omo", "plans");
    await mkdir(plansDir, { recursive: true });
    const oldPath = join(plansDir, "old.md");
    const newPath = join(plansDir, "new.md");
    await writeFile(oldPath, "- [ ] Old A\n- [ ] Old B\n");
    await writeFile(newPath, "- [ ] New A\n");

    // Force old.md to be older than new.md
    const oldDate = new Date(Date.now() - 60_000);
    const newDate = new Date();
    await utimes(oldPath, oldDate, oldDate);
    await utimes(newPath, newDate, newDate);

    const result = await checkPlanReadiness({ projectRoot: root });
    assert.equal(result.ready, true);
    if (result.ready) {
      assert.equal(result.planName, "new");
      assert.equal(result.total, 1);
      assert.equal(result.completed, 0);
    }
  });
});

describe("recheckSessionIdle", () => {
  test("returns true when session status is idle", async () => {
    const client = {
      session: {
        status: async () => ({
          data: { "ses-1": { type: "idle" as const } },
        }),
      },
    } as unknown as OpencodeClient;
    const result = await recheckSessionIdle(client, "ses-1");
    assert.equal(result, true);
  });

  test("returns false when session status is busy", async () => {
    const client = {
      session: {
        status: async () => ({
          data: { "ses-1": { type: "busy" as const } },
        }),
      },
    } as unknown as OpencodeClient;
    const result = await recheckSessionIdle(client, "ses-1");
    assert.equal(result, false);
  });

  test("returns true when session status is absent", async () => {
    const client = {
      session: {
        status: async () => ({ data: {} }),
      },
    } as unknown as OpencodeClient;
    const result = await recheckSessionIdle(client, "ses-missing");
    assert.equal(result, true);
  });
});
