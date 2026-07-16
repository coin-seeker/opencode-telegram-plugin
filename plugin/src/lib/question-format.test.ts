import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pendingQuestionText, questionText } from "./question-format.js";

describe("question text formatting", () => {
  test("renders the shared notice layout with an option list", () => {
    const text = questionText({
      header: "Strategy",
      question: "Choose one",
      options: [
        { label: "Split", description: "List frequently, detail overnight." },
        { label: "Hybrid", description: "Fast polling plus reconciliation." },
      ],
    });

    assert.equal(
      text,
      "❓ <b>Strategy</b>\n\nChoose one\n\n<b>선택지</b>\n1. <b>Split</b> — List frequently, detail overnight.\n2. <b>Hybrid</b> — Fast polling plus reconciliation.",
    );
  });

  test("escapes HTML in user-provided question content", () => {
    const text = questionText({
      header: "Use <script>?",
      question: "Allow a < b & c?",
      options: [{ label: "<b>yes</b>", description: "" }],
    });

    assert.equal(
      text,
      "❓ <b>Use &lt;script&gt;?</b>\n\nAllow a &lt; b &amp; c?\n\n<b>선택지</b>\n1. <b>&lt;b&gt;yes&lt;/b&gt;</b>",
    );
  });

  test("renders only the current question for multi-question prompts", () => {
    const text = pendingQuestionText(
      [
        { header: "First", question: "First?", options: [{ label: "A", description: "Alpha" }] },
        { header: "Second", question: "Second?", options: [{ label: "B", description: "Beta" }] },
      ],
      1,
    );

    assert.match(text, /^❓ <b>Second<\/b> \(2\/2\)/);
    assert.doesNotMatch(text, /All questions:/);
    assert.doesNotMatch(text, /First\?/);
    assert.match(text, /<b>선택지<\/b>\n1\. <b>B<\/b> — Beta/);
  });
});
