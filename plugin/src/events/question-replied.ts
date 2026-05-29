import type { EventQuestionReplied } from "@opencode-ai/sdk/v2";
import type { EventHandlerContext } from "./types.js";

export function isEventQuestionReplied(event: {
  type: string;
  properties?: Record<string, unknown>;
}): event is EventQuestionReplied {
  if (event.type !== "question.replied") return false;
  const props = event.properties;
  return Boolean(
    props && typeof props.requestID === "string" && typeof props.sessionID === "string",
  );
}

export async function handleQuestionReplied(
  event: EventQuestionReplied,
  ctx: EventHandlerContext,
): Promise<void> {
  const found = await ctx.pendingQuestions.findByRequestID(
    event.properties.requestID,
    event.properties.sessionID,
    ctx.serverUrl.href,
  );
  if (!found) {
    ctx.logger.info("question.replied no pending match", {
      requestID: event.properties.requestID,
      sessionID: event.properties.sessionID,
    });
    return;
  }
  const messageId = found.data.telegramMessageIds[0];
  try {
    await ctx.bot.editMessageRemoveKeyboard(messageId, "✅ Already answered in opencode.");
  } catch (err) {
    ctx.logger.error("failed to edit externally answered question", {
      error: String(err),
      requestID: event.properties.requestID,
    });
  } finally {
    await ctx.pendingQuestions.deletePending(found.shortHash);
  }
}
