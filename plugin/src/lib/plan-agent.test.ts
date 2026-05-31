import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPlanSessionAgent } from "./plan-agent.js";

describe("isPlanSessionAgent", () => {
  test("accepts raw plan and Plan Builder labels", () => {
    assert.equal(isPlanSessionAgent("plan"), true);
    assert.equal(isPlanSessionAgent("prometheus"), true);
    assert.equal(isPlanSessionAgent("Prometheus - Plan Builder"), true);
    assert.equal(isPlanSessionAgent("Prometheus — Plan Builder"), true);
    assert.equal(isPlanSessionAgent("Prometheus (Plan Builder)"), true);
  });

  test("rejects executor and non-plan labels", () => {
    assert.equal(isPlanSessionAgent("Atlas - Plan Executor"), false);
    assert.equal(isPlanSessionAgent("Metis - Plan Consultant"), false);
    assert.equal(isPlanSessionAgent("Custom - Plan Builder"), false);
    assert.equal(isPlanSessionAgent("Plan Builder"), false);
    assert.equal(isPlanSessionAgent("build"), false);
    assert.equal(isPlanSessionAgent(undefined), false);
  });
});
