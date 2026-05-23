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
      "❓ Strategy\n\nChoose one\n\n1. Split\n> List frequently, detail overnight.\n2. Hybrid\n> Fast polling plus reconciliation.",
    );
  });

  test("keeps multi-question context while rendering current options", () => {
    const text = pendingQuestionText(
      [
        { header: "First", question: "First?", options: [{ label: "A", description: "Alpha" }] },
        { header: "Second", question: "Second?", options: [{ label: "B", description: "Beta" }] },
      ],
      1,
    );

    assert.match(text, /Question 2\/2/);
    assert.match(text, /All questions:\n1\. First: First\?\n2\. Second: Second\?/);
    assert.match(text, /1\. B\n> Beta/);
  });
});
