import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { field, notice } from "./message-format.js";

describe("message format helpers", () => {
  test("notice renders header only when no body is given", () => {
    assert.equal(notice("✅", "작업 완료"), "✅ <b>작업 완료</b>");
  });

  test("notice joins body lines and drops empty ones", () => {
    assert.equal(
      notice("✅", "작업 완료", "line1", "", "line2"),
      "✅ <b>작업 완료</b>\n\nline1\nline2",
    );
  });

  test("field escapes the value", () => {
    assert.equal(field("세션", "a <b> & c"), "<b>세션</b>: a &lt;b&gt; &amp; c");
  });
});
