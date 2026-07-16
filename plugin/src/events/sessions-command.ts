import type { Session } from "@opencode-ai/sdk";
import type { TelegramBotManager } from "../bot.js";
import { escapeHtml, truncateForTelegram } from "../lib/html-escape.js";
import {
  getRemoteSessions,
  getRemoteStatusMap,
  isDifferentServerUrl,
  normalizeOpenCodeServerUrl,
  type OpenCodeFetcher,
  type OpenCodeSessionListItem,
} from "../lib/opencode-http.js";
import type { SessionWithAgent } from "../lib/sdk-augmentation.js";
import {
  registryEntryFromSession,
  type SessionRegistryEntry,
  type SessionRegistryStore,
} from "../lib/session-registry.js";
import type { SnapshotEntry, SnapshotStore } from "../lib/session-snapshot.js";
import type { SessionStatusType } from "../services/session-title-service.js";
import type { OpencodeClient } from "./types.js";

export type SessionsDispatcher = (ctx: {
  chatId: number;
  userId: number;
  bot: TelegramBotManager;
}) => Promise<void>;

interface SessionsRecord {
  sessionId: string;
  title: string;
  agent: string | undefined;
  status: SessionStatusType;
  serverUrl: string;
  updatedAt: number;
}

interface SessionsLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

interface SessionsDispatcherDeps {
  client: OpencodeClient;
  sessionTitleService: {
    setSessionInfo(info: Session): void;
    setServerUrl(sessionId: string, serverUrl: string): void;
    setSessionStatus(sessionId: string, status: SessionStatusType): void;
  };
  sessionRegistry: SessionRegistryStore;
  snapshotStore: SnapshotStore;
  serverUrl: string;
  logger: SessionsLogger;
  opencodeFetch?: OpenCodeFetcher;
}

const MAX_BODY_CHARS = 3900;
const MAX_TITLE_CHARS = 55;
const MAX_SESSIONS = 20;

function agentFromSession(session: Session): string | undefined {
  const candidate: SessionWithAgent = session;
  return typeof candidate.agent === "string" ? candidate.agent : undefined;
}

function isRootSession(session: Session): boolean {
  return session.parentID === undefined || session.parentID === null;
}

function isRootRegistryEntry(entry: SessionRegistryEntry): boolean {
  return entry.parentID === null;
}

function isRootRemoteSession(session: OpenCodeSessionListItem): boolean {
  return session.parentID === undefined || session.parentID === null;
}

function addRegistryRecord(
  combined: Map<string, SessionsRecord>,
  entry: SessionRegistryEntry,
  status?: SessionStatusType,
): void {
  combined.set(entry.sessionId, {
    sessionId: entry.sessionId,
    title: entry.title,
    agent: entry.agent,
    status: status ?? entry.status ?? "idle",
    serverUrl: entry.serverUrl,
    updatedAt: entry.updatedAt,
  });
}

async function addRemoteServerRecords(
  combined: Map<string, SessionsRecord>,
  serverUrl: string,
  deps: SessionsDispatcherDeps,
): Promise<void> {
  const [remoteSessions, remoteStatusMap] = await Promise.all([
    getRemoteSessions(serverUrl, deps.opencodeFetch),
    getRemoteStatusMap(serverUrl, deps.opencodeFetch),
  ]);
  for (const session of remoteSessions.filter(isRootRemoteSession)) {
    const status = remoteStatusMap[session.id]?.type ?? "idle";
    combined.set(session.id, {
      sessionId: session.id,
      title: session.title,
      agent: session.agent,
      status,
      serverUrl,
      updatedAt: session.time.updated,
    });
    await deps.sessionRegistry.upsertSession({
      sessionId: session.id,
      title: session.title,
      parentID: session.parentID ?? null,
      agent: session.agent,
      status,
      serverUrl,
      updatedAt: session.time.updated,
    });
  }
}

export function createSessionsDispatcher(deps: SessionsDispatcherDeps): SessionsDispatcher {
  return async ({ chatId, bot }) => {
    let sessions: SessionsRecord[];
    try {
      const [listResult, statusResult] = await Promise.all([
        deps.client.session.list(),
        deps.client.session.status(),
      ]);
      const statusMap = statusResult.data ?? {};
      for (const session of listResult.data ?? []) {
        deps.sessionTitleService.setSessionInfo(session);
        deps.sessionTitleService.setServerUrl(session.id, deps.serverUrl);
        const status = statusMap[session.id]?.type ?? "idle";
        await deps.sessionRegistry.upsertSession(
          registryEntryFromSession(session, deps.serverUrl, status),
        );
        if (status !== undefined) deps.sessionTitleService.setSessionStatus(session.id, status);
      }

      const registrySessions = await deps.sessionRegistry.listSessions();
      const combined = new Map<string, SessionsRecord>();
      const remoteServerUrls = new Set<string>();
      for (const entry of registrySessions.filter(isRootRegistryEntry)) {
        const serverUrl = normalizeOpenCodeServerUrl(entry.serverUrl);
        if (!serverUrl) continue;
        if (isDifferentServerUrl(serverUrl, deps.serverUrl)) {
          remoteServerUrls.add(serverUrl);
          continue;
        }
        addRegistryRecord(combined, { ...entry, serverUrl }, statusMap[entry.sessionId]?.type);
      }
      for (const serverUrl of remoteServerUrls) {
        try {
          await addRemoteServerRecords(combined, serverUrl, deps);
        } catch (err) {
          deps.logger.error("sessions remote server refresh failed", {
            serverUrl,
            error: String(err),
          });
        }
      }
      for (const session of (listResult.data ?? []).filter(isRootSession)) {
        combined.set(session.id, {
          sessionId: session.id,
          title: session.title,
          agent: agentFromSession(session),
          status: statusMap[session.id]?.type ?? "idle",
          serverUrl: deps.serverUrl,
          updatedAt: session.time.updated,
        });
      }

      sessions = [...combined.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SESSIONS);
    } catch (err) {
      await bot.sendMessage("세션 목록을 불러오지 못했습니다.", { parse_mode: "HTML" });
      deps.logger.error("sessions list failed", { chatId, error: String(err) });
      return;
    }

    if (sessions.length === 0) {
      await bot.sendMessage("세션이 없습니다.", { parse_mode: "HTML" });
      return;
    }

    const capturedAt = Date.now();
    const entries: SnapshotEntry[] = sessions.map((session, i) => {
      const entry: SnapshotEntry = {
        index: i + 1,
        sessionId: session.sessionId,
        title: session.title,
        capturedAt,
      };
      if (session.agent !== undefined) entry.agent = session.agent;
      entry.status = session.status;
      if (session.serverUrl !== undefined) entry.serverUrl = session.serverUrl;
      return entry;
    });

    await deps.snapshotStore.saveSnapshot(chatId, entries);

    const lines = entries.map((entry) => {
      const agent = entry.agent ? escapeHtml(entry.agent) : "?";
      const title = truncateForTelegram(escapeHtml(entry.title), MAX_TITLE_CHARS);
      const status = ` — ${escapeHtml(entry.status ?? "idle")}`;
      return `${entry.index}. [${agent}] ${title}${status}`;
    });

    let body = lines.join("\n");
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "…";
    }

    const text = `📋 <b>최근 세션 (top ${entries.length})</b>\n\n${body}\n\n<i>/status N 또는 /start_work N 으로 조작</i>`;
    await bot.sendMessage(text, { parse_mode: "HTML" });
    deps.logger.info("sessions listed", { chatId, count: entries.length });
  };
}
