import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type PermissionReply = "once" | "always" | "reject";

export interface PendingPermissionState {
  requestID: string;
  sessionID: string;
  title: string;
  permission: string;
  patterns: string[];
  always: string[];
  sentAt: number;
  expiresAt: number;
  telegramMessageId: number;
  endpoint: "request" | "session";
}

export interface PendingPermissionStoreOptions {
  tokenHash: string;
  baseDir?: string;
}

export interface PendingPermissionStore {
  dir: string;
  savePending(shortHash: string, data: PendingPermissionState): Promise<void>;
  loadPending(shortHash: string): Promise<PendingPermissionState | undefined>;
  deletePending(shortHash: string): Promise<void>;
  findByRequestID(requestID: string): Promise<{ shortHash: string; data: PendingPermissionState } | undefined>;
  sweepExpired(): Promise<PendingPermissionState[]>;
}

function hasCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function pendingFilePath(dir: string, shortHash: string): string {
  return join(dir, `${shortHash}.json`);
}

function parsePending(text: string): PendingPermissionState {
  const parsed = JSON.parse(text) as PendingPermissionState;
  if (typeof parsed.requestID !== "string") throw new Error("Invalid pending permission: requestID");
  if (typeof parsed.sessionID !== "string") throw new Error("Invalid pending permission: sessionID");
  if (typeof parsed.title !== "string") throw new Error("Invalid pending permission: title");
  if (typeof parsed.permission !== "string") throw new Error("Invalid pending permission: permission");
  if (!Array.isArray(parsed.patterns)) throw new Error("Invalid pending permission: patterns");
  if (!Array.isArray(parsed.always)) throw new Error("Invalid pending permission: always");
  if (parsed.endpoint !== "request" && parsed.endpoint !== "session") throw new Error("Invalid pending permission: endpoint");
  return parsed;
}

async function listPendingFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode(err, "ENOENT")) return [];
    throw err;
  }
}

function shortHashFromFileName(fileName: string): string {
  return fileName.slice(0, -".json".length);
}

export function createPendingPermissionStore(opts: PendingPermissionStoreOptions): PendingPermissionStore {
  const dir = opts.baseDir ?? join(tmpdir(), `opencoder-telegram-pending-permissions-${opts.tokenHash}`);

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
    async findByRequestID(requestID) {
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data?.requestID === requestID) return { shortHash, data };
      }
      return undefined;
    },
    async sweepExpired() {
      const expired: PendingPermissionState[] = [];
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

export function createPermissionShortHash(requestID: string): string {
  return createHash("sha256").update(requestID).digest("base64url").slice(0, 10);
}
