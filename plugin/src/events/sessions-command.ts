import type { Session } from "@opencode-ai/sdk";
import type { TelegramBotManager } from "../bot.js";
import { escapeHtml, truncateForTelegram } from "../lib/html-escape.js";
import type { SessionWithAgent } from "../lib/sdk-augmentation.js";
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
  status: SessionStatusType | undefined;
  serverUrl: string;
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
  snapshotStore: SnapshotStore;
  serverUrl: string;
  logger: SessionsLogger;
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

export function createSessionsDispatcher(
  deps: SessionsDispatcherDeps,
): SessionsDispatcher {
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
        const status = statusMap[session.id]?.type;
        if (status !== undefined) deps.sessionTitleService.setSessionStatus(session.id, status);
      }

      sessions = (listResult.data ?? [])
        .filter(isRootSession)
        .sort((a, b) => b.time.updated - a.time.updated)
        .slice(0, MAX_SESSIONS)
        .map((session) => ({
          sessionId: session.id,
          title: session.title,
          agent: agentFromSession(session),
          status: statusMap[session.id]?.type,
          serverUrl: deps.serverUrl,
        }));
    } catch (err) {
      await bot.sendMessage("세션 목록을 불러오지 못했습니다.", { parse_mode: "HTML" });
      deps.logger.error("sessions list failed", { chatId, error: String(err) });
      return;
    }

    if (sessions.length === 0) {
      await bot.sendMessage("활성 세션이 없습니다.", { parse_mode: "HTML" });
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
      if (session.status !== undefined) entry.status = session.status;
      if (session.serverUrl !== undefined) entry.serverUrl = session.serverUrl;
      return entry;
    });

    await deps.snapshotStore.saveSnapshot(chatId, entries);

    const lines = entries.map((entry) => {
      const agent = entry.agent ? escapeHtml(entry.agent) : "?";
      const title = truncateForTelegram(escapeHtml(entry.title), MAX_TITLE_CHARS);
      const status = entry.status ?? "unknown";
      return `${entry.index}. [${agent}] ${title} — ${status}`;
    });

    let body = lines.join("\n");
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "…";
    }

    const text = `<b>활성 세션 (top ${entries.length})</b>\n${body}\n\n<i>/status N 또는 /start_work N 으로 조작</i>`;
    await bot.sendMessage(text, { parse_mode: "HTML" });
    deps.logger.info("sessions listed", { chatId, count: entries.length });
  };
}
