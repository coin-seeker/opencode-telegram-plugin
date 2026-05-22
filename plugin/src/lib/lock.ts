import { open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";

export interface LockHandle {
  readonly path: string;
  readonly acquiredAt: Date;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  lockPath: string;
  ttlMs?: number;
  pid?: number;
}

export type LockResult =
  | { acquired: true; handle: LockHandle }
  | { acquired: false; reason: string; ownerPid?: number };

interface LockFileData {
  pid: number;
  hostname: string;
  createdAt: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function hasCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function parseLockData(text: string): LockFileData | null {
  try {
    const parsed = JSON.parse(text) as Partial<LockFileData>;
    if (typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.createdAt === "string") {
      return { pid: parsed.pid, hostname: parsed.hostname, createdAt: parsed.createdAt };
    }
  } catch {
    return null;
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && hasCode(err, "ESRCH")) return false;
    return true;
  }
}

async function createLock(lockPath: string, pid: number): Promise<LockHandle> {
  const file = await open(lockPath, "wx");
  const acquiredAt = new Date();
  const data: LockFileData = { pid, hostname: hostname(), createdAt: acquiredAt.toISOString() };
  try {
    await file.writeFile(JSON.stringify(data), "utf8");
  } finally {
    await file.close();
  }
  let released = false;
  return {
    path: lockPath,
    acquiredAt,
    async release() {
      if (released) return;
      released = true;
      try {
        await unlink(lockPath);
      } catch {
        // idempotent release
      }
    },
  };
}

async function inspectExisting(lockPath: string, ttlMs: number): Promise<{ stale: boolean; ownerPid?: number; reason: string }> {
  let ownerPid: number | undefined;
  let dead = false;
  try {
    const text = await readFile(lockPath, "utf8");
    const data = parseLockData(text);
    if (data) {
      ownerPid = data.pid;
      dead = !isPidAlive(data.pid);
    }
  } catch {
    return { stale: true, reason: "unreadable lock" };
  }

  try {
    const fileStat = await stat(lockPath);
    const expired = Date.now() - fileStat.mtimeMs > ttlMs;
    if (dead) return { stale: true, ownerPid, reason: "dead owner" };
    if (expired) return { stale: true, ownerPid, reason: "expired lock" };
    return { stale: false, ownerPid, reason: "lock held" };
  } catch {
    return { stale: true, ownerPid, reason: "missing lock" };
  }
}

export async function acquireLock(opts: AcquireLockOptions): Promise<LockResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const pid = opts.pid ?? process.pid;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { acquired: true, handle: await createLock(opts.lockPath, pid) };
    } catch (err) {
      if (!(err instanceof Error) || !hasCode(err, "EEXIST")) {
        return { acquired: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const existing = await inspectExisting(opts.lockPath, ttlMs);
      if (!existing.stale || attempt === 1) {
        return { acquired: false, reason: existing.reason, ownerPid: existing.ownerPid };
      }
      try {
        await unlink(opts.lockPath);
      } catch {
        return { acquired: false, reason: "failed to remove stale lock", ownerPid: existing.ownerPid };
      }
    }
  }
  return { acquired: false, reason: "lock acquisition failed" };
}
