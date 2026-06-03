import type { TelegramBotManager } from "../bot.js";
import type { OpencodeClient } from "../events/types.js";
import { escapeHtml } from "../lib/html-escape.js";
import {
  getRemoteSession,
  getRemoteStatusMap,
  isDifferentServerUrl,
  normalizeOpenCodeServerUrl,
  type OpenCodeFetcher,
} from "../lib/opencode-http.js";
import { createStartWorkShortHash, type PendingStartWorkStore } from "../lib/pending-start-work.js";
import { isPlanSessionAgent } from "../lib/plan-agent.js";
import type { PlanReadinessResult } from "../lib/plan-readiness.js";
import { checkPlanReadiness, recheckSessionIdle } from "../lib/plan-readiness.js";
import type { SnapshotStore } from "../lib/session-snapshot.js";

export type StartWorkCommandDispatcher = (ctx: {
  chatId: number;
  userId: number;
  bot: TelegramBotManager;
  args: string[];
}) => Promise<void>;

type PlanReadinessFailureReason = Exclude<PlanReadinessResult, { ready: true }>["reason"];

interface HttpStatusError extends Error {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
  };
}

interface StartWorkSession {
  directory: string;
  agent?: string;
}

function agentFromSession(session: StartWorkSession): string | undefined {
  return session.agent;
}

function resolveProjectRoot(session: StartWorkSession): string {
  return session.directory;
}

function selectPlanSessionAgent(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(isPlanSessionAgent) ?? candidates.find((agent) => agent !== undefined);
}

function readinessMessage(reason: PlanReadinessFailureReason): string {
  switch (reason) {
    case "no-omo-dir":
      return ".omo/ 디렉토리가 없습니다. plan 작성이 선행되어야 합니다";
    case "no-plans":
      return ".omo/plans/ 에 plan 파일이 없습니다";
    case "plan-empty":
      return "plan 파일에 체크박스가 없습니다 (헤더만 존재)";
    case "all-plans-complete":
      return "plan 의 모든 task 가 완료되었습니다. 새 plan 작성 필요";
    case "no-session-plan":
      return "해당 세션과 연결된 plan 이 없습니다";
  }
}

function isSessionNotFoundError(err: Error): boolean {
  const httpError = err as HttpStatusError;
  return (
    httpError.status === 404 ||
    httpError.statusCode === 404 ||
    httpError.response?.status === 404 ||
    err.message.includes("404")
  );
}

async function sendHtml(bot: TelegramBotManager, text: string): Promise<void> {
  await bot.sendMessage(text, { parse_mode: "HTML" });
}

async function sendPlain(bot: TelegramBotManager, text: string): Promise<void> {
  await bot.sendMessage(text);
}

function pendingMessageIds(pending: {
  telegramMessageId: number;
  telegramMessageIds?: number[];
}): number[] {
  return [...new Set([...(pending.telegramMessageIds ?? [pending.telegramMessageId])])];
}

async function consumeInlineStartWorkButtons(
  bot: TelegramBotManager,
  pendingStartWorks: PendingStartWorkStore | undefined,
  sessionId: string,
  logger: { error(msg: string, data?: Record<string, unknown>): void },
): Promise<void> {
  if (!pendingStartWorks) return;
  const shortHash = createStartWorkShortHash(sessionId);
  const pending = await pendingStartWorks.loadPending(shortHash);
  if (!pending) return;
  if (pending.expiresAt < Date.now()) {
    await pendingStartWorks.deletePending(shortHash);
    return;
  }

  await pendingStartWorks.savePending(shortHash, {
    ...pending,
    status: "consumed",
    handledAt: Date.now(),
  });

  for (const messageId of pendingMessageIds(pending)) {
    try {
      await bot.editMessageRemoveKeyboard(
        messageId,
        "This /start-work request was already handled. Use /start_work <number> from /sessions.",
      );
    } catch (err) {
      logger.error("failed to clear start-work keyboard after command dispatch", {
        sessionId,
        messageId,
        error: String(err),
      });
    }
  }
}

export function createStartWorkCommandDispatcher(deps: {
  snapshotStore: SnapshotStore;
  sessionTitleService: {
    getServerUrl(id: string): string | undefined;
    getSessionAgent(id: string): string | undefined;
  };
  client: OpencodeClient;
  serverUrl?: string;
  pendingStartWorks?: PendingStartWorkStore;
  opencodeFetch?: OpenCodeFetcher;
  runSessionCommand: (sessionId: string, command: string, serverUrl?: string) => Promise<void>;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}): StartWorkCommandDispatcher {
  return async ({ chatId, bot, args }) => {
    const rawIndex = args[0]?.trim();
    if (!rawIndex) {
      await sendPlain(bot, "사용법: /start_work <번호>. 먼저 /sessions 로 목록 확인");
      return;
    }

    const index = Number(rawIndex);
    if (Number.isNaN(index)) {
      await sendPlain(bot, `잘못된 입력: ${rawIndex}은 숫자여야 합니다`);
      return;
    }

    const snapshot = await deps.snapshotStore.loadSnapshot(chatId);
    if (snapshot === null) {
      await sendPlain(bot, "세션 목록이 없습니다. 먼저 /sessions 실행");
      return;
    }

    const entry = snapshot.find((candidate) => candidate.index === index);
    if (!entry) {
      await sendPlain(bot, `${index}번 세션 없음 (목록 크기: ${snapshot.length})`);
      return;
    }

    const sessionId = entry.sessionId;
    const rawSourceServerUrl = entry.serverUrl ?? deps.sessionTitleService.getServerUrl(sessionId);
    const sourceServerUrl = normalizeOpenCodeServerUrl(rawSourceServerUrl);
    if (rawSourceServerUrl && !sourceServerUrl) {
      await sendPlain(bot, "세션 서버 정보가 유효하지 않습니다. /sessions 재실행 필요");
      deps.logger.error("start-work invalid server url", { sessionId });
      return;
    }
    const useRemoteServer = isDifferentServerUrl(sourceServerUrl, deps.serverUrl);
    let session: StartWorkSession;
    try {
      if (sourceServerUrl && useRemoteServer) {
        const result = await getRemoteSession(sourceServerUrl, sessionId, deps.opencodeFetch);
        if (!result.data || result.response.status === 404) {
          await sendPlain(bot, "세션이 더 이상 존재하지 않습니다");
          return;
        }
        session = result.data;
      } else {
        const result = await deps.client.session.get({ path: { id: sessionId } });
        if (!result.data) {
          await sendPlain(bot, "세션이 더 이상 존재하지 않습니다");
          return;
        }
        session = result.data;
      }
    } catch (err) {
      if (err instanceof Error && isSessionNotFoundError(err)) {
        await sendPlain(bot, "세션이 더 이상 존재하지 않습니다");
        return;
      }
      await sendPlain(bot, "세션 확인 실패. /sessions 재실행 필요");
      deps.logger.error("start-work session lookup failed", { sessionId, error: String(err) });
      return;
    }

    const agent = selectPlanSessionAgent([
      deps.sessionTitleService.getSessionAgent(sessionId),
      entry.agent,
      agentFromSession(session),
    ]);
    if (!isPlanSessionAgent(agent)) {
      await sendPlain(
        bot,
        `${index}번 세션의 에이전트는 plan builder 가 아닙니다 (현재: ${agent ?? "unknown"}). /start_work 는 plan 세션에서만 가능합니다`,
      );
      return;
    }

    let idle: boolean;
    try {
      idle =
        sourceServerUrl && useRemoteServer
          ? ((await getRemoteStatusMap(sourceServerUrl, deps.opencodeFetch))[sessionId]?.type ??
              "idle") === "idle"
          : await recheckSessionIdle(deps.client, sessionId);
    } catch (err) {
      await sendPlain(bot, "세션 상태 확인 실패. /sessions 재실행 필요");
      deps.logger.error("start-work idle recheck failed", { sessionId, error: String(err) });
      return;
    }
    if (!idle) {
      await sendPlain(bot, `${index}번 세션이 idle 상태가 아닙니다. 작업 완료를 기다리세요`);
      return;
    }

    const readiness = await checkPlanReadiness({ projectRoot: resolveProjectRoot(session) });
    if (!readiness.ready) {
      await sendPlain(bot, readinessMessage(readiness.reason));
      return;
    }

    try {
      await deps.runSessionCommand(sessionId, "start-work", sourceServerUrl);
      await consumeInlineStartWorkButtons(bot, deps.pendingStartWorks, sessionId, deps.logger);
      await sendHtml(
        bot,
        `${index}번 세션에 opencode /start-work 슬래시 커맨드 전송 완료. (${escapeHtml(entry.title)})`,
      );
      deps.logger.info("start-work dispatched", { chatId, sessionId, index });
    } catch (err) {
      await sendHtml(bot, "opencode /start-work 전송 실패");
      deps.logger.error("start-work dispatch failed", { sessionId, error: String(err) });
    }
  };
}
