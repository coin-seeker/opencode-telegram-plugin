import type { EventSessionIdle } from "@opencode-ai/sdk";
import { claimOnce } from "../lib/claim.js";
import type { EventHandlerContext } from "./types.js";

export async function handleSessionIdle(event: EventSessionIdle, ctx: EventHandlerContext): Promise<void> {
  const sessionId = event.properties.sessionID;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `session.idle:${sessionId}` });
  if (!claimed) return;

  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const message = title ? `Agent has finished: ${title}` : "Agent has finished.";
  try {
    await ctx.bot.sendMessage(message);
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}
