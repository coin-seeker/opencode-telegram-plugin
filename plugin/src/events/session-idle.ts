import type { EventSessionIdle, EventSessionStatus } from "@opencode-ai/sdk";
import { claimOnce } from "../lib/claim.js";
import type { EventHandlerContext } from "./types.js";

/**
 * Send an "agent finished" Telegram notification.
 *
 * opencode v1.15.x emits `session.status` with `status.type === "idle"`
 * rather than a dedicated `session.idle` event, so the dispatcher routes
 * both event shapes here. We accept either and extract the session id.
 */
export async function handleSessionIdle(
  event: EventSessionIdle | EventSessionStatus,
  ctx: EventHandlerContext,
): Promise<void> {
  const sessionId = event.properties.sessionID;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `session.idle:${sessionId}`, ttlMs: 5000 });
  if (!claimed) return;

  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const message = title ? `Agent has finished: ${title}` : "Agent has finished.";
  try {
    await ctx.bot.sendMessage(message);
    ctx.logger.info("idle notification sent", { sessionId, title });
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}
