import type { EventSessionUpdated } from "@opencode-ai/sdk";
import type { EventHandlerContext } from "./types.js";

export async function handleSessionUpdated(
  event: EventSessionUpdated,
  ctx: EventHandlerContext,
): Promise<void> {
  const info = event.properties.info;
  if (info.title && info.id) {
    ctx.sessionTitleService.setSessionTitle(info.id, info.title);
  }
}
