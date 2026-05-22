import type { EventSessionError } from "@opencode-ai/sdk/v2";
import { noteAbort } from "../lib/abort-tracker.js";
import type { EventHandlerContext } from "./types.js";

export function isEventSessionError(event: { type: string; properties?: Record<string, unknown> }): event is EventSessionError {
  return event.type === "session.error";
}

export async function handleSessionError(event: EventSessionError, ctx: EventHandlerContext): Promise<void> {
  if (event.properties.error?.name !== "MessageAbortedError") return;
  noteAbort(event.properties.sessionID);
  ctx.logger.info("session abort recorded", { sessionId: event.properties.sessionID ?? "global" });
}
