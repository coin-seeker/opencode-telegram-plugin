import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeHtml, stripCodeFences, truncateForTelegram } from "./html-escape.js";

describe("html-escape", () => {
  test("escapes ampersand first before angle brackets", () => {
    assert.equal(escapeHtml("Tom & Jerry <plot>"), "Tom &amp; Jerry &lt;plot&gt;");
  });

  test("escapes ampersand first key correctness", () => {
    assert.equal(escapeHtml("a & <b>"), "a &amp; &lt;b&gt;");
  });

  test("returns empty string unchanged", () => {
    assert.equal(escapeHtml(""), "");
  });

  test("escapes double quotes", () => {
    assert.equal(escapeHtml('say "hello"'), "say &quot;hello&quot;");
  });

  test("leaves short truncate text unchanged", () => {
    assert.equal(truncateForTelegram("hello world", 20), "hello world");
  });

  test("truncate multiline collapses whitespace", () => {
    assert.equal(truncateForTelegram("line1\n\nline2   spaces", 100), "line1 line2 spaces");
  });

  test("truncate result respects maxChars", () => {
    const maxChars = 12;

    assert.ok(truncateForTelegram("hello world from telegram", maxChars).length <= maxChars);
  });

  test("strips fenced code block markers", () => {
    const result = stripCodeFences("```js\nconst x = 1\n```");

    assert.equal(result, "const x = 1");
    assert.doesNotMatch(result, /```/);
  });

  test("strips inline code backticks", () => {
    assert.equal(stripCodeFences("Use `const x = 1` here"), "Use const x = 1 here");
  });
});
