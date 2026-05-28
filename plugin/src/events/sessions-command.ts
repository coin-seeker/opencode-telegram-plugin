import type { TelegramBotManager } from "../bot.js";
import { escapeHtml, truncateForTelegram } from "../lib/html-escape.js";
import type { SnapshotEntry, SnapshotStore } from "../lib/session-snapshot.js";

export type SessionsDispatcher = (ctx: {
  chatId: number;
  userId: number;
  bot: TelegramBotManager;
}) => Promise<void>;

interface SessionsRecord {
  sessionId: string;
  title: string | null;
  agent: string | undefined;
  status: string | undefined;
  serverUrl: string | undefined;
}

interface SessionsLogger {
  info(msg: string, data?: Record<string, unknown>): void;
}

interface SessionsDispatcherDeps {
  sessionTitleService: {
    getRootSessionsByRecency(limit: number): SessionsRecord[];
  };
  snapshotStore: SnapshotStore;
  logger: SessionsLogger;
}

const MAX_BODY_CHARS = 3900;
const MAX_TITLE_CHARS = 55;
const MAX_SESSIONS = 20;

export function createSessionsDispatcher(
  deps: SessionsDispatcherDeps,
): SessionsDispatcher {
  return async ({ chatId, bot }) => {
    const sessions = deps.sessionTitleService.getRootSessionsByRecency(MAX_SESSIONS);
    if (sessions.length === 0) {
      await bot.sendMessage("활성 세션이 없습니다.", { parse_mode: "HTML" });
      return;
    }

    const capturedAt = Date.now();
    const entries: SnapshotEntry[] = sessions.map((session, i) => {
      const entry: SnapshotEntry = {
        index: i + 1,
        sessionId: session.sessionId,
        title: session.title ?? "",
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
