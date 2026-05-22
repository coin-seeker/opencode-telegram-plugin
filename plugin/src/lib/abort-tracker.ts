const ABORT_TTL_MS = 5_000;

const sessionAborts = new Map<string, number>();
let lastGlobalAbortAt = 0;

export function noteAbort(sessionID: string | undefined): void {
  const now = Date.now();
  if (sessionID) {
    sessionAborts.set(sessionID, now);
    return;
  }
  lastGlobalAbortAt = now;
}

export function shouldSuppressIdle(sessionID: string): boolean {
  const now = Date.now();
  const sessionAbortAt = sessionAborts.get(sessionID) ?? 0;
  const abortAt = Math.max(sessionAbortAt, lastGlobalAbortAt);
  if (abortAt === 0) return false;

  if (now - abortAt <= ABORT_TTL_MS) {
    sessionAborts.delete(sessionID);
    if (abortAt === lastGlobalAbortAt) lastGlobalAbortAt = 0;
    return true;
  }

  sessionAborts.delete(sessionID);
  if (now - lastGlobalAbortAt > ABORT_TTL_MS) lastGlobalAbortAt = 0;
  return false;
}

export function resetAbortTrackerForTest(): void {
  sessionAborts.clear();
  lastGlobalAbortAt = 0;
}
