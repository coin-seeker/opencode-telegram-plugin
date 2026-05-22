import type { EventSessionCreated } from "@opencode-ai/sdk";
import type { EventHandlerContext } from "./types.js";

export async function handleSessionCreated(
  event: EventSessionCreated,
  ctx: EventHandlerContext,
): Promise<void> {
  ctx.sessionTitleService.setSessionInfo(event.properties.info);
}
