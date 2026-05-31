import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "@opencode-ai/sdk";
import type { SessionStatusType } from "../services/session-title-service.js";
import { normalizeOpenCodeServerUrl } from "./opencode-http.js";
import type { SessionWithAgent } from "./sdk-augmentation.js";

export interface SessionRegistryEntry {
  sessionId: string;
  title: string;
  parentID: string | null;
  agent?: string;
  status?: SessionStatusType;
  serverUrl: string;
  updatedAt: number;
}

export interface SessionRegistryLogger {
  error(msg: string, data?: Record<string, unknown>): void;
}

interface SessionRegistryFile {
  version: 1;
  entry: SessionRegistryEntry;
}

export interface SessionRegistryStore {
  upsertSession(entry: SessionRegistryEntry): Promise<void>;
  updateSession(
    sessionId: string,
    patch: Partial<Omit<SessionRegistryEntry, "sessionId">>,
  ): Promise<void>;
  listSessions(): Promise<SessionRegistryEntry[]>;
}

interface SessionRegistryStoreOptions {
  configDir: string;
  tokenHash: string;
  logger: SessionRegistryLogger;
}

function filenameForSession(sessionId: string): string {
  return `${Buffer.from(sessionId).toString("base64url")}.json`;
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function normalizeEntry(entry: SessionRegistryEntry): SessionRegistryEntry {
  const serverUrl = normalizeOpenCodeServerUrl(entry.serverUrl);
  if (!serverUrl) throw new Error("invalid registry serverUrl");
  const out: SessionRegistryEntry = {
    sessionId: entry.sessionId,
    title: entry.title,
    parentID: entry.parentID,
    serverUrl,
    updatedAt: entry.updatedAt,
  };
  if (entry.agent !== undefined) out.agent = entry.agent;
  if (entry.status !== undefined) out.status = entry.status;
  return out;
}

function isRegistryFile(value: unknown): value is SessionRegistryFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  if (file.version !== 1) return false;
  const entry = file.entry;
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.sessionId !== "string") return false;
  if (typeof e.title !== "string") return false;
  if (e.parentID !== null && typeof e.parentID !== "string") return false;
  if (e.agent !== undefined && typeof e.agent !== "string") return false;
  if (
    e.status !== undefined &&
    e.status !== "idle" &&
    e.status !== "busy" &&
    e.status !== "retry"
  ) {
    return false;
  }
  if (typeof e.serverUrl !== "string") return false;
  if (!normalizeOpenCodeServerUrl(e.serverUrl)) return false;
  if (typeof e.updatedAt !== "number") return false;
  return true;
}

function agentFromSession(session: Session): string | undefined {
  const candidate: SessionWithAgent = session;
  return typeof candidate.agent === "string" ? candidate.agent : undefined;
}

export function registryEntryFromSession(
  session: Session,
  serverUrl: string,
  status?: SessionStatusType,
): SessionRegistryEntry {
  const entry: SessionRegistryEntry = {
    sessionId: session.id,
    title: session.title,
    parentID: session.parentID ?? null,
    serverUrl,
    updatedAt: session.time.updated,
  };
  const agent = agentFromSession(session);
  if (agent !== undefined) entry.agent = agent;
  if (status !== undefined) entry.status = status;
  return entry;
}

export function createSessionRegistryStore(
  opts: SessionRegistryStoreOptions,
): SessionRegistryStore {
  const registryDir = join(opts.configDir, "session-registry", opts.tokenHash);

  function filePath(sessionId: string): string {
    return join(registryDir, filenameForSession(sessionId));
  }

  async function readEntry(sessionId: string): Promise<SessionRegistryEntry | null> {
    let text: string;
    try {
      text = await readFile(filePath(sessionId), "utf8");
    } catch (err) {
      if (hasCode(err, "ENOENT")) return null;
      opts.logger.error("session-registry: failed to read file", {
        sessionId,
        error: String(err),
      });
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRegistryFile(parsed)) return null;
      return normalizeEntry(parsed.entry);
    } catch (err) {
      opts.logger.error("session-registry: corrupted JSON", { sessionId, error: String(err) });
      return null;
    }
  }

  async function writeEntry(entry: SessionRegistryEntry): Promise<void> {
    await mkdir(registryDir, { recursive: true });
    try {
      await chmod(registryDir, 0o700);
    } catch (err) {
      opts.logger.error("session-registry: failed to chmod dir", { error: String(err) });
    }
    const payload: SessionRegistryFile = { version: 1, entry: normalizeEntry(entry) };
    const target = filePath(entry.sessionId);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename(tmp, target);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {}
      throw err;
    }
    await chmod(target, 0o600);
  }

  async function upsertSession(entry: SessionRegistryEntry): Promise<void> {
    const existing = await readEntry(entry.sessionId);
    await writeEntry({
      ...existing,
      ...entry,
      agent: entry.agent ?? existing?.agent,
      status: entry.status ?? existing?.status,
    });
  }

  async function updateSession(
    sessionId: string,
    patch: Partial<Omit<SessionRegistryEntry, "sessionId">>,
  ): Promise<void> {
    const existing = await readEntry(sessionId);
    if (!existing) return;
    await writeEntry({
      ...existing,
      ...patch,
      sessionId,
      title: patch.title ?? existing.title,
      parentID: patch.parentID === undefined ? existing.parentID : patch.parentID,
      serverUrl: patch.serverUrl ?? existing.serverUrl,
      updatedAt: patch.updatedAt ?? Date.now(),
    });
  }

  async function listSessions(): Promise<SessionRegistryEntry[]> {
    let names: string[];
    try {
      names = await readdir(registryDir);
    } catch (err) {
      if (hasCode(err, "ENOENT")) return [];
      opts.logger.error("session-registry: failed to list dir", { error: String(err) });
      return [];
    }

    const entries: SessionRegistryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let text: string;
      try {
        text = await readFile(join(registryDir, name), "utf8");
      } catch (err) {
        opts.logger.error("session-registry: failed to read listed file", {
          file: name,
          error: String(err),
        });
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRegistryFile(parsed)) entries.push(normalizeEntry(parsed.entry));
      } catch (err) {
        opts.logger.error("session-registry: corrupted listed file", {
          file: name,
          error: String(err),
        });
      }
    }
    return entries;
  }

  return { upsertSession, updateSession, listSessions };
}
