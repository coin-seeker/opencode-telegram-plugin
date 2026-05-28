import type { EventSessionCreated } from "@opencode-ai/sdk";
import { registryEntryFromSession } from "../lib/session-registry.js";
import type { EventHandlerContext } from "./types.js";

export async function handleSessionCreated(
  event: EventSessionCreated,
  ctx: EventHandlerContext,
): Promise<void> {
  const info = event.properties.info;
  ctx.sessionTitleService.setSessionInfo(info);
  await ctx.sessionRegistry.upsertSession(
    registryEntryFromSession(info, ctx.serverUrl.href, ctx.sessionTitleService.getSessionStatus(info.id)),
  );
}
