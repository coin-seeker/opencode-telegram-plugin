import type { SessionStatusType } from "../services/session-title-service.js";

export type OpenCodeFetcher = (input: URL, init?: RequestInit) => Promise<Response>;

export interface OpenCodeSessionData {
  id?: string;
  directory: string;
  title?: string;
  parentID?: string | null;
  agent?: string;
}

export interface OpenCodeSessionListItem {
  id: string;
  title: string;
  parentID?: string | null;
  agent?: string;
  time: { updated: number };
}

export interface OpenCodeMessagePart {
  type: string;
  text?: string;
}

export interface OpenCodeMessageEnvelope {
  info: { role: string };
  parts: OpenCodeMessagePart[];
}

export interface OpenCodeStatusEntry {
  type: SessionStatusType;
}

export interface OpenCodeHttpResult<T> {
  data: T | undefined;
  response: { status: number };
}

const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function isStatusType(value: unknown): value is SessionStatusType {
  return value === "idle" || value === "busy" || value === "retry";
}

export function normalizeOpenCodeServerUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    if (url.search || url.hash) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    if (!ALLOWED_HOSTNAMES.has(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function requireOpenCodeServerUrl(serverUrl: string): string {
  const normalized = normalizeOpenCodeServerUrl(serverUrl);
  if (!normalized) throw new Error("Invalid OpenCode server URL");
  return normalized;
}

function endpoint(serverUrl: string, path: string): URL {
  return new URL(path, requireOpenCodeServerUrl(serverUrl));
}

export function isDifferentServerUrl(sourceServerUrl: string | undefined, currentServerUrl: string | undefined): boolean {
  const source = normalizeOpenCodeServerUrl(sourceServerUrl);
  const current = normalizeOpenCodeServerUrl(currentServerUrl);
  if (!source || !current) return false;
  return source !== current;
}

export function normalizeSession(value: unknown): OpenCodeSessionData | undefined {
  const record = asRecord(value);
  if (!record || typeof record.directory !== "string") return undefined;
  const session: OpenCodeSessionData = { directory: record.directory };
  if (typeof record.id === "string") session.id = record.id;
  if (typeof record.title === "string") session.title = record.title;
  if (typeof record.parentID === "string" || record.parentID === null) {
    session.parentID = record.parentID;
  }
  if (typeof record.agent === "string") session.agent = record.agent;
  return session;
}

export function normalizeSessionList(value: unknown): OpenCodeSessionListItem[] {
  if (!Array.isArray(value)) return [];
  const sessions: OpenCodeSessionListItem[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const time = asRecord(record?.time);
    if (!record) continue;
    if (typeof record.id !== "string") continue;
    if (typeof record.title !== "string") continue;
    if (!time || typeof time.updated !== "number") continue;
    const session: OpenCodeSessionListItem = {
      id: record.id,
      title: record.title,
      time: { updated: time.updated },
    };
    if (typeof record.parentID === "string" || record.parentID === null) {
      session.parentID = record.parentID;
    }
    if (typeof record.agent === "string") session.agent = record.agent;
    sessions.push(session);
  }
  return sessions;
}

export function normalizeStatusMap(value: unknown): Record<string, OpenCodeStatusEntry> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, OpenCodeStatusEntry> = {};
  for (const [sessionId, rawStatus] of Object.entries(record)) {
    const status = asRecord(rawStatus);
    if (status && isStatusType(status.type)) out[sessionId] = { type: status.type };
  }
  return out;
}

export function normalizeMessages(value: unknown): OpenCodeMessageEnvelope[] {
  if (!Array.isArray(value)) return [];
  const messages: OpenCodeMessageEnvelope[] = [];
  for (const rawMessage of value) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    if (!message || !info || typeof info.role !== "string" || !Array.isArray(message.parts)) continue;
    const parts: OpenCodeMessagePart[] = [];
    for (const rawPart of message.parts) {
      const part = asRecord(rawPart);
      if (!part || typeof part.type !== "string") continue;
      const normalized: OpenCodeMessagePart = { type: part.type };
      if (typeof part.text === "string") normalized.text = part.text;
      parts.push(normalized);
    }
    messages.push({ info: { role: info.role }, parts });
  }
  return messages;
}

async function fetchJson(serverUrl: string, path: string, fetcher: OpenCodeFetcher): Promise<OpenCodeHttpResult<unknown>> {
  const response = await fetcher(endpoint(serverUrl, path), { redirect: "error" });
  if (response.status === 404) return { data: undefined, response: { status: response.status } };
  if (!response.ok) {
    throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
  }
  return { data: await response.json(), response: { status: response.status } };
}

export async function getRemoteSession(
  serverUrl: string,
  sessionId: string,
  fetcher: OpenCodeFetcher = fetch,
): Promise<OpenCodeHttpResult<OpenCodeSessionData>> {
  const result = await fetchJson(serverUrl, `/session/${encodeURIComponent(sessionId)}`, fetcher);
  return { data: normalizeSession(result.data), response: result.response };
}

export async function getRemoteStatusMap(
  serverUrl: string,
  fetcher: OpenCodeFetcher = fetch,
): Promise<Record<string, OpenCodeStatusEntry>> {
  const result = await fetchJson(serverUrl, "/session/status", fetcher);
  return normalizeStatusMap(result.data);
}

export async function getRemoteSessions(
  serverUrl: string,
  fetcher: OpenCodeFetcher = fetch,
): Promise<OpenCodeSessionListItem[]> {
  const result = await fetchJson(serverUrl, "/session", fetcher);
  return normalizeSessionList(result.data);
}

export async function getRemoteMessages(
  serverUrl: string,
  sessionId: string,
  limit: number,
  fetcher: OpenCodeFetcher = fetch,
): Promise<OpenCodeMessageEnvelope[]> {
  const url = endpoint(serverUrl, `/session/${encodeURIComponent(sessionId)}/message`);
  url.searchParams.set("limit", String(limit));
  const response = await fetcher(url, { redirect: "error" });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
  }
  return normalizeMessages(await response.json());
}
