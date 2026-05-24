import type { EventSessionIdle, EventSessionStatus } from "@opencode-ai/sdk";
import { shouldSuppressIdle } from "../lib/abort-tracker.js";
import { claimOnce } from "../lib/claim.js";
import type { EventHandlerContext } from "./types.js";

const ROOT_IDLE_RECHECK_DELAY_MS = 2_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveParentID(
  sessionId: string,
  ctx: EventHandlerContext,
): Promise<string | null | undefined> {
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

async function hydrateDescendants(
  sessionId: string,
  ctx: EventHandlerContext,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(sessionId)) return;
  seen.add(sessionId);

  try {
    const result = await ctx.client.session.children({ path: { id: sessionId } });
    for (const child of result.data ?? []) {
      ctx.sessionTitleService.setSessionInfo(child);
      await hydrateDescendants(child.id, ctx, seen);
    }
  } catch (err) {
    ctx.logger.warn("session children fetch failed", { sessionId, error: String(err) });
  }
}

async function sendIdleNotification(sessionId: string, ctx: EventHandlerContext): Promise<void> {
  if (shouldSuppressIdle(sessionId)) {
    ctx.logger.info("idle suppressed - session was aborted", { sessionId });
    return;
  }

  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `session.idle:${sessionId}`,
    ttlMs: 5000,
  });
  if (!claimed) return;

  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const text = title ? `Agent has finished: ${title}` : "Agent has finished.";
  try {
    await ctx.bot.sendMessage(text);
    ctx.sessionTitleService.clearDeferredIdleNotification(sessionId);
    ctx.logger.info("idle notification sent", { sessionId, title });
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}

async function flushDeferredParentIfReady(
  parentID: string,
  ctx: EventHandlerContext,
): Promise<void> {
  if (!ctx.sessionTitleService.hasDeferredIdleNotification(parentID)) return;
  if (ctx.sessionTitleService.hasUnfinishedDescendants(parentID)) return;
  if (ctx.sessionTitleService.getSessionStatus(parentID) !== "idle") {
    ctx.sessionTitleService.clearDeferredIdleNotification(parentID);
    ctx.logger.info("clearing deferred parent idle notification - parent resumed", {
      sessionId: parentID,
    });
    return;
  }
  ctx.logger.info("sending deferred parent idle notification", { sessionId: parentID });
  await sendIdleNotification(parentID, ctx);
}

async function deferParentIdleIfDescendantsRunning(
  sessionId: string,
  ctx: EventHandlerContext,
): Promise<boolean> {
  await hydrateDescendants(sessionId, ctx);
  if (!ctx.sessionTitleService.hasUnfinishedDescendants(sessionId)) return false;
  ctx.sessionTitleService.deferIdleNotification(sessionId);
  ctx.logger.info("deferring parent idle notification - child sessions still running", {
    sessionId,
  });
  return true;
}

export async function handleSessionIdle(
  event: EventSessionIdle | EventSessionStatus,
  ctx: EventHandlerContext,
): Promise<void> {
  const sessionId = event.properties.sessionID;
  ctx.sessionTitleService.setSessionStatus(sessionId, "idle");
  const parentID = await resolveParentID(sessionId, ctx);
  if (typeof parentID === "string") {
    ctx.logger.info("suppressing child session idle notification", { sessionId, parentID });
    await flushDeferredParentIfReady(parentID, ctx);
    return;
  }
  if (parentID === undefined) {
    ctx.logger.warn("session parentID unknown; sending idle notification", { sessionId });
  }

  if (await deferParentIdleIfDescendantsRunning(sessionId, ctx)) {
    return;
  }

  await sleep(ctx.idleRecheckDelayMs ?? ROOT_IDLE_RECHECK_DELAY_MS);

  if (ctx.sessionTitleService.getSessionStatus(sessionId) !== "idle") {
    ctx.logger.info("idle notification skipped - session resumed during recheck delay", {
      sessionId,
    });
    return;
  }

  if (await deferParentIdleIfDescendantsRunning(sessionId, ctx)) {
    return;
  }

  await sendIdleNotification(sessionId, ctx);
}

export async function handleSessionStatus(
  event: EventSessionStatus,
  ctx: EventHandlerContext,
): Promise<void> {
  const sessionId = event.properties.sessionID;
  const statusType = event.properties.status.type;
  ctx.sessionTitleService.setSessionStatus(sessionId, statusType);
  if (statusType === "idle") {
    await handleSessionIdle(event, ctx);
  }
}
