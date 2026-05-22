import type { EventSessionIdle, EventSessionStatus } from "@opencode-ai/sdk";
import { claimOnce } from "../lib/claim.js";
import { shouldSuppressIdle } from "../lib/abort-tracker.js";
import type { EventHandlerContext } from "./types.js";

async function resolveParentID(sessionId: string, ctx: EventHandlerContext): Promise<string | null | undefined> {
  const cachedParentID = ctx.sessionTitleService.getParentID(sessionId);
  if (cachedParentID !== undefined) return cachedParentID;

  try {
    const result = await ctx.client.session.get({ path: { id: sessionId } });
    if (result.data) {
      ctx.sessionTitleService.setSessionInfo(result.data);
      return ctx.sessionTitleService.getParentID(sessionId);
    }
    ctx.logger.warn("session parentID cache miss fetch returned no data", { sessionId });
    return undefined;
  } catch (err) {
    ctx.logger.warn("session parentID cache miss fetch failed", { sessionId, error: String(err) });
    return undefined;
  }
}

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
  const parentID = await resolveParentID(sessionId, ctx);
  if (typeof parentID === "string") {
    ctx.logger.info("suppressing child session idle notification", { sessionId, parentID });
    return;
  }
  if (parentID === undefined) {
    ctx.logger.warn("session parentID unknown; sending idle notification", { sessionId });
  }

  if (shouldSuppressIdle(sessionId)) {
    ctx.logger.info("idle suppressed - session was aborted", { sessionId });
    return;
  }

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
