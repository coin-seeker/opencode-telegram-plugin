import type { Session } from "@opencode-ai/sdk";

interface SessionInfoCacheEntry {
  title: string | null;
  parentID: string | null;
}

export class SessionTitleService {
  private sessions: Map<string, SessionInfoCacheEntry> = new Map();

  setSessionInfo(info: Session): void {
    this.sessions.set(info.id, {
      title: info.title || null,
      parentID: info.parentID ?? null,
    });
  }

  setSessionTitle(sessionId: string, title: string): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title,
      parentID: existing?.parentID ?? null,
    });
  }

  getSessionTitle(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.title ?? null;
  }

  getParentID(sessionId: string): string | null | undefined {
    return this.sessions.get(sessionId)?.parentID;
  }
}
