import type { Session } from "@opencode-ai/sdk";
import type { SessionWithAgent } from "../lib/sdk-augmentation";

export type SessionStatusType = "busy" | "idle" | "retry";

interface SessionInfoCacheEntry {
  title: string | null;
  parentID: string | null | undefined;
  agent?: string;
  status?: SessionStatusType;
  idleNotificationPending: boolean;
  idleSettleStartedAt?: number;
  idleNotificationSentAt?: number;
  lastSeenAt: number;
  serverUrl?: string;
}

function agentFromSession(info: Session): string | undefined {
  const candidate = info as SessionWithAgent;
  return typeof candidate.agent === "string" ? candidate.agent : undefined;
}

export class SessionTitleService {
  private sessions: Map<string, SessionInfoCacheEntry> = new Map();

  setSessionInfo(info: Session): void {
    const existing = this.sessions.get(info.id);
    this.sessions.set(info.id, {
      title: info.title || null,
      parentID: info.parentID ?? null,
      agent: agentFromSession(info) ?? existing?.agent,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false,
      idleSettleStartedAt: existing?.idleSettleStartedAt,
      idleNotificationSentAt: existing?.idleNotificationSentAt,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl,
    });
  }

  setSessionTitle(sessionId: string, title: string): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false,
      idleSettleStartedAt: existing?.idleSettleStartedAt,
      idleNotificationSentAt: existing?.idleNotificationSentAt,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl,
    });
  }

  setSessionAgent(sessionId: string, agent: string): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false,
      idleSettleStartedAt: existing?.idleSettleStartedAt,
      idleNotificationSentAt: existing?.idleNotificationSentAt,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl,
    });
  }

  setSessionStatus(sessionId: string, status: SessionStatusType): void {
    const existing = this.sessions.get(sessionId);
    // Resume (busy/retry) restarts the settle window so a fresh one must elapse before notifying.
    const resumed = status !== "idle";
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status,
      idleNotificationPending: resumed ? false : (existing?.idleNotificationPending ?? false),
      idleSettleStartedAt: resumed ? undefined : existing?.idleSettleStartedAt,
      idleNotificationSentAt: resumed ? undefined : existing?.idleNotificationSentAt,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl,
    });
  }

  setServerUrl(sessionId: string, serverUrl: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing?.serverUrl) return;

    const lastSeenAt = existing?.lastSeenAt ?? Date.now();
    this.sessions.set(sessionId, {
      ...(existing ?? {
        title: null,
        parentID: undefined,
        idleNotificationPending: false,
        lastSeenAt,
      }),
      lastSeenAt,
      serverUrl,
    });
  }

  getServerUrl(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.serverUrl;
  }

  getRootSessionsByRecency(limit: number): Array<{
    sessionId: string;
    title: string | null;
    agent: string | undefined;
    status: SessionStatusType | undefined;
    serverUrl: string | undefined;
  }> {
    const results: Array<{
      sessionId: string;
      title: string | null;
      agent: string | undefined;
      status: SessionStatusType | undefined;
      serverUrl: string | undefined;
    }> = [];

    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.parentID !== null) continue;
      results.push({
        sessionId,
        title: entry.title,
        agent: entry.agent,
        status: entry.status,
        serverUrl: entry.serverUrl,
      });
    }

    results.sort((a, b) => {
      const lastSeenA = this.sessions.get(a.sessionId)?.lastSeenAt ?? 0;
      const lastSeenB = this.sessions.get(b.sessionId)?.lastSeenAt ?? 0;
      return lastSeenB - lastSeenA;
    });

    return results.slice(0, limit);
  }

  getSessionTitle(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.title ?? null;
  }

  getParentID(sessionId: string): string | null | undefined {
    return this.sessions.get(sessionId)?.parentID;
  }

  getSessionAgent(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agent;
  }

  getSessionStatus(sessionId: string): SessionStatusType | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  getRootAncestorId(sessionId: string): string | undefined {
    let current = sessionId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parentID = this.sessions.get(current)?.parentID;
      if (parentID === null) return current;
      if (typeof parentID !== "string") return undefined;
      current = parentID;
    }
    return undefined;
  }

  hasUnfinishedDescendants(parentID: string): boolean {
    for (const [sessionID, session] of this.sessions.entries()) {
      if (session.parentID !== parentID) continue;
      if (session.status !== "idle") return true;
      if (this.hasUnfinishedDescendants(sessionID)) return true;
    }
    return false;
  }

  deferIdleNotification(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status: existing?.status ?? "idle",
      idleNotificationPending: true,
      idleSettleStartedAt: existing?.idleSettleStartedAt,
      idleNotificationSentAt: existing?.idleNotificationSentAt,
      lastSeenAt: existing?.lastSeenAt ?? Date.now(),
      serverUrl: existing?.serverUrl,
    });
  }

  hasDeferredIdleNotification(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.idleNotificationPending ?? false;
  }

  clearDeferredIdleNotification(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.set(sessionId, {
      ...existing,
      idleNotificationPending: false,
    });
  }

  private ensureEntry(sessionId: string): SessionInfoCacheEntry {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionInfoCacheEntry = {
      title: null,
      parentID: undefined,
      idleNotificationPending: false,
      lastSeenAt: Date.now(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  beginIdleSettle(sessionId: string, now: number = Date.now()): number {
    const entry = this.ensureEntry(sessionId);
    if (entry.idleSettleStartedAt === undefined) entry.idleSettleStartedAt = now;
    return entry.idleSettleStartedAt;
  }

  remainingIdleSettleMs(sessionId: string, delayMs: number, now: number = Date.now()): number {
    const startedAt = this.sessions.get(sessionId)?.idleSettleStartedAt;
    if (startedAt === undefined) return delayMs;
    return Math.max(0, delayMs - (now - startedAt));
  }

  clearIdleSettle(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.idleSettleStartedAt = undefined;
    existing.idleNotificationSentAt = undefined;
  }

  markIdleNotificationSent(sessionId: string, now: number = Date.now()): void {
    this.ensureEntry(sessionId).idleNotificationSentAt = now;
  }

  hasIdleNotificationSent(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.idleNotificationSentAt !== undefined;
  }
}
