export class SessionTitleService {
  private sessionTitles: Map<string, string> = new Map();

  setSessionTitle(sessionId: string, title: string): void {
    this.sessionTitles.set(sessionId, title);
  }

  getSessionTitle(sessionId: string): string | null {
    return this.sessionTitles.get(sessionId) ?? null;
  }
}
