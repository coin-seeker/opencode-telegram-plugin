import type { EventPermissionUpdated } from "@opencode-ai/sdk";
import { claimOnce } from "../lib/claim.js";
import type { EventHandlerContext } from "./types.js";

export async function handlePermissionUpdated(event: EventPermissionUpdated, ctx: EventHandlerContext): Promise<void> {
  const permission = event.properties;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `permission.updated:${permission.id}` });
  if (!claimed) return;

  const sessionTitle = ctx.sessionTitleService.getSessionTitle(permission.sessionID);
  const titleLine = sessionTitle ? `📋 ${sessionTitle}` : `Session: ${permission.sessionID}`;
  const message = `❓ Permission requested\n\n${titleLine}\n\nType: ${permission.type}\nDetail: ${permission.title}`;
  try {
    await ctx.bot.sendMessage(message);
  } catch (err) {
    ctx.logger.error("failed to send permission notification", { error: String(err) });
  }
}
