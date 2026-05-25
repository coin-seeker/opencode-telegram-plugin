import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface PendingStartWorkState {
  sessionID: string;
  serverUrl?: string;
  title?: string;
  sentAt: number;
  expiresAt: number;
  telegramMessageId: number;
}

export interface PendingStartWorkStoreOptions {
  tokenHash: string;
  baseDir?: string;
}

export interface PendingStartWorkStore {
  dir: string;
  savePending(shortHash: string, data: PendingStartWorkState): Promise<void>;
  loadPending(shortHash: string): Promise<PendingStartWorkState | undefined>;
  deletePending(shortHash: string): Promise<void>;
  sweepExpired(): Promise<PendingStartWorkState[]>;
}

function hasCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function pendingFilePath(dir: string, shortHash: string): string {
  return join(dir, `${shortHash}.json`);
}

function parsePending(text: string): PendingStartWorkState {
  const parsed = JSON.parse(text) as PendingStartWorkState;
  if (typeof parsed.sessionID !== "string")
    throw new Error("Invalid pending start-work: sessionID");
  if (parsed.serverUrl !== undefined && typeof parsed.serverUrl !== "string")
    throw new Error("Invalid pending start-work: serverUrl");
  if (parsed.title !== undefined && typeof parsed.title !== "string")
    throw new Error("Invalid pending start-work: title");
  if (typeof parsed.sentAt !== "number") throw new Error("Invalid pending start-work: sentAt");
  if (typeof parsed.expiresAt !== "number")
    throw new Error("Invalid pending start-work: expiresAt");
  if (typeof parsed.telegramMessageId !== "number")
    throw new Error("Invalid pending start-work: telegramMessageId");
  return parsed;
}

async function listPendingFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode(err, "ENOENT")) return [];
    throw err;
  }
}

function shortHashFromFileName(fileName: string): string {
  return fileName.slice(0, -".json".length);
}

export function createPendingStartWorkStore(
  opts: PendingStartWorkStoreOptions,
): PendingStartWorkStore {
  const dir =
    opts.baseDir ?? join(tmpdir(), `opencoder-telegram-pending-start-work-${opts.tokenHash}`);

  return {
    dir,
    async savePending(shortHash, data) {
      const filePath = pendingFilePath(dir, shortHash);
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
      await rename(tmpPath, filePath);
    },
    async loadPending(shortHash) {
      try {
        return parsePending(await readFile(pendingFilePath(dir, shortHash), "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode(err, "ENOENT")) return undefined;
        throw err;
      }
    },
    async deletePending(shortHash) {
      try {
        await unlink(pendingFilePath(dir, shortHash));
      } catch (err) {
        if (!(err instanceof Error) || !hasCode(err, "ENOENT")) throw err;
      }
    },
    async sweepExpired() {
      const expired: PendingStartWorkState[] = [];
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data && data.expiresAt < Date.now()) {
          expired.push(data);
          await this.deletePending(shortHash);
        }
      }
      return expired;
    },
  };
}

export function createStartWorkShortHash(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("base64url").slice(0, 10);
}
