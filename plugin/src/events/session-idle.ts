import type { EventSessionIdle, EventSessionStatus } from "@opencode-ai/sdk";
import { DEFAULT_IDLE_SETTLE_DELAY_MS } from "../config.js";
import { shouldSuppressIdle } from "../lib/abort-tracker.js";
import { claimOnce } from "../lib/claim.js";
import {
  normalizeMessages,
  normalizeStatusMap,
  type OpenCodeMessageEnvelope,
  type OpenCodeStatusEntry,
} from "../lib/opencode-http.js";
import { isPlanSessionAgent } from "../lib/plan-agent.js";
import { registryEntryFromSession } from "../lib/session-registry.js";
import { createPendingStartWork, planCompleteMessage, startWorkShortHash } from "./start-work.js";
import type { EventHandlerContext } from "./types.js";

const DEFERRED_PARENT_CONFIRM_DELAY_MS = 2_500;
const PLAN_COMPLETION_MESSAGE_LIMIT = 5;
const START_WORK_COMMAND_RE = /(?:^|[\s`"'(])\/?start[_-]work(?:$|[\s`"').,!?])/i;

const deferredConfirmTimers = new Map<string, NodeJS.Timeout>();
const idleSettleTimers = new Map<string, NodeJS.Timeout>();

export function agentFinishedMessage(title: string | null, agent: string | undefined): string {
  const base = title ? `Agent has finished: ${title}` : "Agent has finished.";
  return agent ? `${base} (${agent})` : base;
}

function selectPlanSessionAgent(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(isPlanSessionAgent) ?? candidates.find((agent) => agent !== undefined);
}

function extractTextFromParts(parts: OpenCodeMessageEnvelope["parts"]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") pieces.push(part.text);
  }
  return pieces.join(" ");
}

function findLatestAssistantMessage(
  messages: Array<OpenCodeMessageEnvelope>,
): OpenCodeMessageEnvelope | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.info.role === "assistant") return message;
  }
  return undefined;
}

export function hasStartWorkCommandInstruction(text: string): boolean {
  return START_WORK_COMMAND_RE.test(text);
}

async function latestAssistantText(
  sessionId: string,
  ctx: EventHandlerContext,
): Promise<string | undefined> {
  try {
    const result = await ctx.client.session.messages({
      path: { id: sessionId },
      query: { limit: PLAN_COMPLETION_MESSAGE_LIMIT },
    });
    const message = findLatestAssistantMessage(normalizeMessages(result.data));
    return message ? extractTextFromParts(message.parts) : undefined;
  } catch (err) {
    ctx.logger.warn("plan completion message lookup failed", { sessionId, error: String(err) });
    return undefined;
  }
}

async function shouldSendPlanCompletion(
  sessionId: string,
  ctx: EventHandlerContext,
): Promise<boolean> {
  const text = await latestAssistantText(sessionId, ctx);
  if (text !== undefined && hasStartWorkCommandInstruction(text)) return true;
  ctx.logger.info("skipping plan completion notice - no start-work instruction", { sessionId });
  return false;
}

async function fetchSessionStatusMap(
  ctx: EventHandlerContext,
): Promise<Record<string, OpenCodeStatusEntry> | undefined> {
  try {
    const result = await ctx.client.session.status();
    return normalizeStatusMap(result.data);
  } catch (err) {
    ctx.logger.warn("session status map fetch failed", { error: String(err) });
    return undefined;
  }
}

type SessionStatusValue = "busy" | "idle" | "retry";

// Prefer a non-idle signal from either source so a stale or missing live "idle" never erases a
// locally observed busy/retry that already invalidated the current settle epoch.
function reconcileStatus(
  live: SessionStatusValue | undefined,
  cached: SessionStatusValue | undefined,
): SessionStatusValue | undefined {
  if (live === "busy" || live === "retry") return live;
  if (cached === "busy" || cached === "retry") return cached;
  return live ?? cached;
}

function statusForHydratedSession(
  sessionId: string,
  ctx: EventHandlerContext,
  statusMap: Record<string, OpenCodeStatusEntry> | undefined,
): SessionStatusValue | undefined {
  if (statusMap === undefined) return ctx.sessionTitleService.getSessionStatus(sessionId);
  // Descendants: the live status map is authoritative. A finished child legitimately drops off the
  // map, so a missing entry means idle (matching OpenCode's status endpoint). Falling back to a
  // cached busy here would defer the parent forever when no child idle event arrives.
  return statusMap[sessionId]?.type ?? "idle";
}

function refreshSessionStatus(
  sessionId: string,
  ctx: EventHandlerContext,
  statusMap: Record<string, OpenCodeStatusEntry> | undefined,
): SessionStatusValue | undefined {
  const status = statusForHydratedSession(sessionId, ctx, statusMap);
  if (status !== undefined) ctx.sessionTitleService.setSessionStatus(sessionId, status);
  return status;
}

function refreshRootSessionStatus(
  sessionId: string,
  ctx: EventHandlerContext,
  statusMap: Record<string, OpenCodeStatusEntry> | undefined,
): SessionStatusValue | undefined {
  const status = reconcileStatus(
    statusMap?.[sessionId]?.type,
    ctx.sessionTitleService.getSessionStatus(sessionId),
  );
  if (status !== undefined) ctx.sessionTitleService.setSessionStatus(sessionId, status);
  return status;
}

async function resolveSessionAgent(
  sessionId: string,
  ctx: EventHandlerContext,
): Promise<string | undefined> {
  const candidates: Array<string | undefined> = [
    ctx.sessionTitleService.getSessionAgent(sessionId),
  ];

  try {
    const registryEntry = (await ctx.sessionRegistry.listSessions()).find(
      (entry) => entry.sessionId === sessionId,
    );
    candidates.push(registryEntry?.agent);
  } catch (err) {
    ctx.logger.warn("session registry agent lookup failed", { sessionId, error: String(err) });
  }

  try {
    const result = await ctx.client.session.get({ path: { id: sessionId } });
    if (result.data) {
      ctx.sessionTitleService.setSessionInfo(result.data);
      candidates.push(ctx.sessionTitleService.getSessionAgent(sessionId));
    }
  } catch (err) {
    ctx.logger.warn("session agent live lookup failed", { sessionId, error: String(err) });
  }

  const agent = selectPlanSessionAgent(candidates);
  if (agent !== undefined) ctx.sessionTitleService.setSessionAgent(sessionId, agent);
  return agent;
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
  statusMap: Record<string, OpenCodeStatusEntry> | undefined,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(sessionId)) return;
  seen.add(sessionId);

  try {
    const result = await ctx.client.session.children({ path: { id: sessionId } });
    for (const child of result.data ?? []) {
      ctx.sessionTitleService.setSessionInfo(child);
      const childStatus = refreshSessionStatus(child.id, ctx, statusMap);
      await ctx.sessionRegistry.upsertSession(
        registryEntryFromSession(child, ctx.serverUrl.href, childStatus),
      );
      await hydrateDescendants(child.id, ctx, statusMap, seen);
    }
  } catch (err) {
    ctx.logger.warn("session children fetch failed", { sessionId, error: String(err) });
  }
}

async function sendIdleNotification(sessionId: string, ctx: EventHandlerContext): Promise<boolean> {
  if (shouldSuppressIdle(sessionId)) {
    ctx.logger.info("idle suppressed - session was aborted", { sessionId });
    return false;
  }

  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const agent = await resolveSessionAgent(sessionId, ctx);
  const isPlanSession = isPlanSessionAgent(agent);
  if (isPlanSession && !(await shouldSendPlanCompletion(sessionId, ctx))) return false;

  // resolveSessionAgent / shouldSendPlanCompletion above issue async API calls during which the
  // session can resume OR spawn a new descendant; re-verify FULL eligibility (root idle AND no
  // unfinished descendants) before claiming/sending, since the downgrade hook cannot fire once the
  // settle timer has already been consumed.
  const preSendStatusMap = await fetchSessionStatusMap(ctx);
  if (refreshRootSessionStatus(sessionId, ctx, preSendStatusMap) !== "idle") {
    ctx.sessionTitleService.clearIdleSettle(sessionId);
    ctx.logger.info("idle notification aborted - session resumed before send", { sessionId });
    return false;
  }
  await hydrateDescendants(sessionId, ctx, preSendStatusMap);
  if (ctx.sessionTitleService.hasUnfinishedDescendants(sessionId)) {
    ctx.sessionTitleService.clearIdleSettle(sessionId);
    await deferParentIdleIfDescendantsRunning(sessionId, ctx, preSendStatusMap);
    ctx.logger.info("idle notification aborted - descendant active before send", { sessionId });
    return false;
  }

  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `session.idle:${sessionId}`,
    ttlMs: 5000,
  });
  if (!claimed) return false;

  const text = isPlanSession ? planCompleteMessage(title) : agentFinishedMessage(title, agent);
  try {
    if (isPlanSession) {
      const shortHash = startWorkShortHash(sessionId);
      const pending = await ctx.pendingStartWorks.loadPending(shortHash);
      if (pending && pending.expiresAt >= Date.now()) {
        ctx.logger.info("plan completion notice already sent - skipping duplicate", { sessionId });
        return false;
      }
      if (pending) await ctx.pendingStartWorks.deletePending(shortHash);
      const message = await ctx.bot.sendMessage(text);
      // The Telegram send already happened; a bookkeeping failure here must NOT make the caller
      // treat the notification as unsent (which would risk a duplicate on a later idle epoch).
      try {
        await ctx.pendingStartWorks.savePending(shortHash, {
          ...createPendingStartWork(sessionId, title, ctx.serverUrl.href, message.message_id),
          status: "consumed",
          handledAt: Date.now(),
        });
      } catch (saveErr) {
        ctx.logger.warn("plan completion bookkeeping failed after send", {
          sessionId,
          error: String(saveErr),
        });
      }
    } else {
      await ctx.bot.sendMessage(text);
    }
    ctx.sessionTitleService.clearDeferredIdleNotification(sessionId);
    ctx.logger.info("idle notification sent", { sessionId, title, agent, isPlanSession });
    return true;
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
    return false;
  }
}

function idleSettleDelayMs(ctx: EventHandlerContext): number {
  return ctx.idleSettleDelayMs ?? DEFAULT_IDLE_SETTLE_DELAY_MS;
}

export function cancelSettledIdleNotification(sessionId: string): void {
  const timer = idleSettleTimers.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  idleSettleTimers.delete(sessionId);
}

function armSettleTimer(sessionId: string, ctx: EventHandlerContext, delayMs: number): void {
  const timer = setTimeout(() => {
    idleSettleTimers.delete(sessionId);
    void confirmSettledIdleNotification(sessionId, ctx);
  }, delayMs);
  timer.unref?.();
  idleSettleTimers.set(sessionId, timer);
  ctx.logger.info("idle settle window armed", { sessionId, delayMs });
}

function scheduleSettledIdleNotification(sessionId: string, ctx: EventHandlerContext): void {
  ctx.sessionTitleService.beginIdleSettle(sessionId);
  if (idleSettleTimers.has(sessionId)) return;
  armSettleTimer(
    sessionId,
    ctx,
    ctx.sessionTitleService.remainingIdleSettleMs(sessionId, idleSettleDelayMs(ctx)),
  );
}

async function confirmSettledIdleNotification(
  sessionId: string,
  ctx: EventHandlerContext,
): Promise<void> {
  const statusMap = await fetchSessionStatusMap(ctx);
  if (refreshRootSessionStatus(sessionId, ctx, statusMap) !== "idle") {
    ctx.sessionTitleService.clearIdleSettle(sessionId);
    ctx.logger.info("idle settle aborted - session resumed", { sessionId });
    return;
  }

  await hydrateDescendants(sessionId, ctx, statusMap);
  if (ctx.sessionTitleService.hasUnfinishedDescendants(sessionId)) {
    ctx.sessionTitleService.clearIdleSettle(sessionId);
    await deferParentIdleIfDescendantsRunning(sessionId, ctx, statusMap);
    ctx.logger.info("idle settle deferred - descendants active again", { sessionId });
    return;
  }

  ctx.sessionTitleService.beginIdleSettle(sessionId);
  const remaining = ctx.sessionTitleService.remainingIdleSettleMs(
    sessionId,
    idleSettleDelayMs(ctx),
  );
  if (remaining > 0) {
    armSettleTimer(sessionId, ctx, remaining);
    return;
  }

  if (ctx.sessionTitleService.hasIdleNotificationSent(sessionId)) {
    ctx.logger.info("idle settle skipped - already notified this idle epoch", { sessionId });
    return;
  }

  if (await sendIdleNotification(sessionId, ctx)) {
    ctx.sessionTitleService.markIdleNotificationSent(sessionId);
  }
}

function downgradeRootSettleToDeferred(rootId: string, ctx: EventHandlerContext): void {
  cancelSettledIdleNotification(rootId);
  ctx.sessionTitleService.clearIdleSettle(rootId);
  ctx.sessionTitleService.deferIdleNotification(rootId);
  scheduleDeferredParentConfirm(rootId, ctx);
  ctx.logger.info("root settle downgraded to deferred - descendant became active", {
    sessionId: rootId,
  });
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
  const timer = setTimeout(() => {
    deferredConfirmTimers.delete(parentID);
    void confirmDeferredParentIdle(parentID, ctx);
  }, delay);
  timer.unref?.();
  deferredConfirmTimers.set(parentID, timer);
  ctx.logger.info("deferred parent idle confirmation scheduled", {
    sessionId: parentID,
  });
}

async function confirmDeferredParentIdle(
  parentID: string,
  ctx: EventHandlerContext,
): Promise<void> {
  if (!ctx.sessionTitleService.hasDeferredIdleNotification(parentID)) return;
  const statusMap = await fetchSessionStatusMap(ctx);
  if (refreshRootSessionStatus(parentID, ctx, statusMap) !== "idle") {
    ctx.sessionTitleService.clearDeferredIdleNotification(parentID);
    ctx.logger.info("clearing deferred parent idle notification - parent resumed during confirm", {
      sessionId: parentID,
    });
    return;
  }
  await hydrateDescendants(parentID, ctx, statusMap);
  if (ctx.sessionTitleService.hasUnfinishedDescendants(parentID)) {
    ctx.logger.info("keeping deferred parent idle notification - descendants active again", {
      sessionId: parentID,
    });
    scheduleDeferredParentConfirm(parentID, ctx);
    return;
  }
  ctx.logger.info("deferred parent reached idle settle window", { sessionId: parentID });
  scheduleSettledIdleNotification(parentID, ctx);
}

async function deferParentIdleIfDescendantsRunning(
  sessionId: string,
  ctx: EventHandlerContext,
  statusMap?: Record<string, OpenCodeStatusEntry>,
): Promise<boolean> {
  const effectiveStatusMap = statusMap ?? (await fetchSessionStatusMap(ctx));
  await hydrateDescendants(sessionId, ctx, effectiveStatusMap);
  if (!ctx.sessionTitleService.hasUnfinishedDescendants(sessionId)) return false;
  ctx.sessionTitleService.deferIdleNotification(sessionId);
  scheduleDeferredParentConfirm(sessionId, ctx);
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

  scheduleSettledIdleNotification(sessionId, ctx);
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
    cancelSettledIdleNotification(sessionId);
    const parentID = ctx.sessionTitleService.getParentID(sessionId);
    if (typeof parentID === "string") {
      const rootId = ctx.sessionTitleService.getRootAncestorId(sessionId);
      if (
        rootId !== undefined &&
        ctx.sessionTitleService.getSessionStatus(rootId) === "idle" &&
        idleSettleTimers.has(rootId)
      ) {
        downgradeRootSettleToDeferred(rootId, ctx);
      }
    }
    await ctx.sessionRegistry.updateSession(sessionId, {
      status: statusType,
      updatedAt: Date.now(),
    });
  }
}

export function resetSessionIdleTimersForTest(): void {
  for (const timer of idleSettleTimers.values()) clearTimeout(timer);
  idleSettleTimers.clear();
  for (const timer of deferredConfirmTimers.values()) clearTimeout(timer);
  deferredConfirmTimers.clear();
}
