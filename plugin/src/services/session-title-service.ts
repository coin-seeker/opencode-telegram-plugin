import type { Session } from "@opencode-ai/sdk";
import type { SessionWithAgent } from "../lib/sdk-augmentation";

export type SessionStatusType = "busy" | "idle" | "retry";

interface SessionInfoCacheEntry {
  title: string | null;
  parentID: string | null | undefined;
  agent?: string;
  status?: SessionStatusType;
  idleNotificationPending: boolean;
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
    });
  }

  setSessionStatus(sessionId: string, status: SessionStatusType): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status,
      idleNotificationPending:
        status === "idle" ? (existing?.idleNotificationPending ?? false) : false,
    });
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
}
