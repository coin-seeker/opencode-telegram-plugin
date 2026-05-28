import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface SnapshotEntry {
  index: number;
  sessionId: string;
  title: string;
  agent?: string;
  status?: string;
  serverUrl?: string;
  capturedAt: number;
}

interface SnapshotFile {
  version: 1;
  chatId: number;
  createdAt: number;
  entries: SnapshotEntry[];
}

export interface SnapshotLogger {
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface SnapshotStoreOptions {
  configDir: string;
  tokenHash: string;
  logger: SnapshotLogger;
}

export interface SnapshotStore {
  saveSnapshot(chatId: number, entries: SnapshotEntry[]): Promise<void>;
  loadSnapshot(chatId: number): Promise<SnapshotEntry[] | null>;
  snapshotFilePath(chatId: number): string;
}

function hasCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function isSnapshotFile(value: unknown): value is SnapshotFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.chatId !== "number") return false;
  if (typeof v.createdAt !== "number") return false;
  if (!Array.isArray(v.entries)) return false;
  for (const entry of v.entries) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.index !== "number") return false;
    if (typeof e.sessionId !== "string") return false;
    if (typeof e.title !== "string") return false;
    if (typeof e.capturedAt !== "number") return false;
    if (e.agent !== undefined && typeof e.agent !== "string") return false;
    if (e.status !== undefined && typeof e.status !== "string") return false;
    if (e.serverUrl !== undefined && typeof e.serverUrl !== "string") return false;
  }
  return true;
}

function normalizeEntry(entry: SnapshotEntry): SnapshotEntry {
  const out: SnapshotEntry = {
    index: entry.index,
    sessionId: entry.sessionId,
    title: entry.title,
    capturedAt: entry.capturedAt,
  };
  if (entry.agent !== undefined) out.agent = entry.agent;
  if (entry.status !== undefined) out.status = entry.status;
  if (entry.serverUrl !== undefined) out.serverUrl = entry.serverUrl;
  return out;
}

export function createSnapshotStore(opts: SnapshotStoreOptions): SnapshotStore {
  const { configDir, tokenHash, logger } = opts;
  const snapshotsDir = join(configDir, "snapshots");
  const writeLocks = new Map<number, Promise<void>>();

  function snapshotFilePath(chatId: number): string {
    return join(snapshotsDir, `${tokenHash}-${chatId}.json`);
  }

  async function performSave(
    chatId: number,
    entries: SnapshotEntry[],
  ): Promise<void> {
    const filePath = snapshotFilePath(chatId);
    const parent = dirname(filePath);
    await mkdir(parent, { recursive: true });
    try {
      await chmod(parent, 0o700);
    } catch (err) {
      logger.error("snapshot: failed to chmod parent dir", {
        path: parent,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const payload: SnapshotFile = {
      version: 1,
      chatId,
      createdAt: Date.now(),
      entries: entries.map(normalizeEntry),
    };
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename(tmpPath, filePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
    await chmod(filePath, 0o600);
  }

  async function saveSnapshot(
    chatId: number,
    entries: SnapshotEntry[],
  ): Promise<void> {
    const prev = writeLocks.get(chatId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => performSave(chatId, entries));
    const tracked = next.catch(() => undefined);
    writeLocks.set(chatId, tracked);
    try {
      await next;
    } finally {
      if (writeLocks.get(chatId) === tracked) {
        writeLocks.delete(chatId);
      }
    }
  }

  async function loadSnapshot(chatId: number): Promise<SnapshotEntry[] | null> {
    const filePath = snapshotFilePath(chatId);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      if (hasCode(err, "ENOENT")) return null;
      logger.error("snapshot: failed to read file", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error("snapshot: corrupted JSON", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!isSnapshotFile(parsed)) {
      logger.error("snapshot: invalid shape", { path: filePath });
      return null;
    }
    if (parsed.createdAt + TTL_MS < Date.now()) {
      try {
        await unlink(filePath);
      } catch (err) {
        if (!hasCode(err, "ENOENT")) {
          logger.error("snapshot: failed to unlink expired file", {
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return null;
    }
    return parsed.entries.map(normalizeEntry);
  }

  return { saveSnapshot, loadSnapshot, snapshotFilePath };
}
