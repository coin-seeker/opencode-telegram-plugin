import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { noteAbort, resetAbortTrackerForTest, shouldSuppressIdle } from "./abort-tracker.js";

describe("abort tracker", () => {
  afterEach(() => {
    resetAbortTrackerForTest();
  });

  test("suppresses idle once for matching session", () => {
    noteAbort("s1");
    assert.equal(shouldSuppressIdle("s1"), true);
    assert.equal(shouldSuppressIdle("s1"), false);
  });

  test("does not suppress unrelated session aborts", () => {
    noteAbort("s1");
    assert.equal(shouldSuppressIdle("s2"), false);
  });

  test("global abort suppresses any next idle once", () => {
    noteAbort(undefined);
    assert.equal(shouldSuppressIdle("s2"), true);
    assert.equal(shouldSuppressIdle("s3"), false);
  });
});
