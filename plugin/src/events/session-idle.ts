import type { EventSessionIdle, EventSessionStatus } from "@opencode-ai/sdk";
import { shouldSuppressIdle } from "../lib/abort-tracker.js";
import { claimOnce } from "../lib/claim.js";
import { isPlanSessionAgent } from "../lib/plan-agent.js";
import { registryEntryFromSession } from "../lib/session-registry.js";
import { createPendingStartWork, planCompleteMessage, startWorkShortHash } from "./start-work.js";
import type { EventHandlerContext } from "./types.js";

const ROOT_IDLE_RECHECK_DELAY_MS = 2_500;
const DEFERRED_PARENT_CONFIRM_DELAY_MS = 2_500;

const deferredConfirmTimers = new Map<string, NodeJS.Timeout>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function agentFinishedMessage(title: string | null, agent: string | undefined): string {
  const base = title ? `Agent has finished: ${title}` : "Agent has finished.";
  return agent ? `${base} (${agent})` : base;
}

function cancelDeferredParentConfirm(sessionId: string): void {
  const timer = deferredConfirmTimers.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  deferredConfirmTimers.delete(sessionId);
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
      await ctx.sessionRegistry.upsertSession(
        registryEntryFromSession(
          result.data,
          ctx.serverUrl.href,
          ctx.sessionTitleService.getSessionStatus(sessionId),
        ),
      );
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
      await ctx.sessionRegistry.upsertSession(
        registryEntryFromSession(
          child,
          ctx.serverUrl.href,
          ctx.sessionTitleService.getSessionStatus(child.id),
        ),
      );
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
  const agent = ctx.sessionTitleService.getSessionAgent(sessionId);
  const isPlanSession = isPlanSessionAgent(agent);
  const text = isPlanSession ? planCompleteMessage(title) : agentFinishedMessage(title, agent);
  try {
    if (isPlanSession) {
      const shortHash = startWorkShortHash(sessionId);
      const pending = await ctx.pendingStartWorks.loadPending(shortHash);
      if (pending && pending.expiresAt >= Date.now()) {
        ctx.logger.info("plan completion notice already sent - skipping duplicate", { sessionId });
        return;
      }
      if (pending) await ctx.pendingStartWorks.deletePending(shortHash);
      const message = await ctx.bot.sendMessage(text);
      const sentAt = Date.now();
      await ctx.pendingStartWorks.savePending(shortHash, {
        ...createPendingStartWork(sessionId, title, ctx.serverUrl.href, message.message_id),
        status: "consumed",
        handledAt: sentAt,
      });
    } else {
      await ctx.bot.sendMessage(text);
    }
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
  const parentStatus = ctx.sessionTitleService.getSessionStatus(parentID);
  if (parentStatus !== "idle") {
    if (parentStatus !== undefined) {
      cancelDeferredParentConfirm(parentID);
      ctx.sessionTitleService.clearDeferredIdleNotification(parentID);
      ctx.logger.info("clearing deferred parent idle notification - parent resumed", {
        sessionId: parentID,
      });
    }
    return;
  }
  scheduleDeferredParentConfirm(parentID, ctx);
}

function scheduleDeferredParentConfirm(parentID: string, ctx: EventHandlerContext): void {
  if (deferredConfirmTimers.has(parentID)) return;
  const delay = ctx.deferredConfirmDelayMs ?? DEFERRED_PARENT_CONFIRM_DELAY_MS;
  // A foreground parent emits busy/retry within this window and cancels the timer;
  // a background parent stays idle, so the deferred completion is sent after the delay.
  const timer = setTimeout(() => {
    deferredConfirmTimers.delete(parentID);
    void confirmDeferredParentIdle(parentID, ctx);
  }, delay);
  timer.unref?.();
  deferredConfirmTimers.set(parentID, timer);
  ctx.logger.info("parent idle and descendants finished - confirming deferred notification", {
    sessionId: parentID,
  });
}

async function confirmDeferredParentIdle(
  parentID: string,
  ctx: EventHandlerContext,
): Promise<void> {
  if (!ctx.sessionTitleService.hasDeferredIdleNotification(parentID)) return;
  if (ctx.sessionTitleService.getSessionStatus(parentID) !== "idle") {
    ctx.sessionTitleService.clearDeferredIdleNotification(parentID);
    ctx.logger.info("clearing deferred parent idle notification - parent resumed during confirm", {
      sessionId: parentID,
    });
    return;
  }
  await hydrateDescendants(parentID, ctx);
  if (ctx.sessionTitleService.hasUnfinishedDescendants(parentID)) {
    ctx.logger.info("keeping deferred parent idle notification - descendants active again", {
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
  const parentID = await resolveParentID(sessionId, ctx);
  ctx.sessionTitleService.setSessionStatus(sessionId, "idle");
  await ctx.sessionRegistry.updateSession(sessionId, { status: "idle", updatedAt: Date.now() });
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
  const previousStatus = ctx.sessionTitleService.getSessionStatus(sessionId);
  ctx.sessionTitleService.setSessionStatus(sessionId, statusType);
  if (statusType === "idle") {
    await handleSessionIdle(event, ctx);
    return;
  }
  // Write only on status transition: busy/retry events flood at ~50/s while an agent
  // works, and awaiting a registry write per event backs up OpenCode's awaited event
  // delivery and freezes the TUI. Do not persist every busy event.
  if (previousStatus !== statusType) {
    await ctx.sessionRegistry.updateSession(sessionId, {
      status: statusType,
      updatedAt: Date.now(),
    });
  }
}
