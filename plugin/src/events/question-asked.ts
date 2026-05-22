import { claimOnce } from "../lib/claim.js";
import type { EventHandlerContext } from "./types.js";

interface QuestionAskedItem {
  header?: string;
  question: string;
}

export interface EventQuestionAsked {
  type: "question.asked";
  properties: {
    sessionID: string;
    questions: QuestionAskedItem[];
  };
}

function isEventQuestionAsked(event: { type: string; properties?: unknown }): event is EventQuestionAsked {
  if (event.type !== "question.asked") return false;
  const props = event.properties as { sessionID?: unknown; questions?: unknown } | undefined;
  if (!props || typeof props.sessionID !== "string") return false;
  if (!Array.isArray(props.questions)) return false;
  return true;
}

export async function handleQuestionAsked(
  event: EventQuestionAsked,
  ctx: EventHandlerContext,
): Promise<void> {
  const { sessionID, questions } = event.properties;
  if (questions.length === 0) return;

  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `question.asked:${sessionID}:${questions.length}`,
    ttlMs: 5000,
  });
  if (!claimed) return;

  const title = ctx.sessionTitleService.getSessionTitle(sessionID);
  const titleLine = title ? `📋 ${title}` : `Session: ${sessionID}`;
  const questionLines = questions
    .map((q, i) => `${i + 1}. ${q.header ? `${q.header}: ` : ""}${q.question}`)
    .join("\n");
  const message = `${titleLine}\n\n❓ Questions:\n${questionLines}`;

  try {
    await ctx.bot.sendMessage(message);
    ctx.logger.info("question notification sent", { sessionID, count: questions.length });
  } catch (err) {
    ctx.logger.error("failed to send question notification", { error: String(err) });
  }
}

export { isEventQuestionAsked };
