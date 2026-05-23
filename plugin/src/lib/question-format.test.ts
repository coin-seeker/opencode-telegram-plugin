import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pendingQuestionText, questionText } from "./question-format.js";

describe("question text formatting", () => {
  test("renders option descriptions as quote-style text", () => {
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
      "❓ Strategy\n\nChoose one\n\nOptions:\n\n1. Split\n설명: List frequently, detail overnight.\n\n2. Hybrid\n설명: Fast polling plus reconciliation.",
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

    assert.match(text, /^❓ Question 2\/2 · Second/);
    assert.doesNotMatch(text, /All questions:/);
    assert.doesNotMatch(text, /First\?/);
    assert.match(text, /Options:\n\n1\. B\n설명: Beta/);
  });
});
