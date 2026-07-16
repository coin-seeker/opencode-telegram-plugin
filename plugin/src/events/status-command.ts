import type { TelegramBotManager } from "../bot.js";
import { escapeHtml, stripCodeFences, truncateForTelegram } from "../lib/html-escape.js";
import {
  getRemoteMessages,
  getRemoteSession,
  getRemoteStatusMap,
  isDifferentServerUrl,
  normalizeMessages,
  normalizeOpenCodeServerUrl,
  normalizeSession,
  normalizeStatusMap,
  type OpenCodeFetcher,
  type OpenCodeMessageEnvelope,
  type OpenCodeSessionData,
} from "../lib/opencode-http.js";
import { isPlanSessionAgent } from "../lib/plan-agent.js";
import { checkPlanReadiness, type PlanReadinessResult } from "../lib/plan-readiness.js";
import type { SnapshotStore } from "../lib/session-snapshot.js";
import type { OpencodeClient } from "./types.js";

export type StatusDispatcher = (ctx: {
  chatId: number;
  userId: number;
  bot: TelegramBotManager;
  args: string[];
}) => Promise<void>;

type StatusLogData = Record<string, string | number | boolean | null | undefined>;

interface StatusLogger {
  info(msg: string, data?: StatusLogData): void;
  error(msg: string, data?: StatusLogData): void;
}

interface StatusSessionTitleService {
  getServerUrl(id: string): string | undefined;
}

export interface StatusDispatcherDeps {
  snapshotStore: SnapshotStore;
  sessionTitleService: StatusSessionTitleService;
  client: OpencodeClient;
  logger: StatusLogger;
  serverUrl?: string;
  opencodeFetch?: OpenCodeFetcher;
}

const SNIPPET_MAX_CHARS = 80;
const MESSAGES_LIMIT = 10;
const EMPTY_MESSAGE = "메시지 없음";

function resolveProjectRoot(session: { directory: string }): string {
  if (!session.directory) throw new Error("session directory missing");
  return session.directory;
}

function extractTextFromParts(parts: OpenCodeMessageEnvelope["parts"]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      pieces.push(part.text);
    }
  }
  return pieces.join(" ");
}

function buildSnippet(envelope: OpenCodeMessageEnvelope | undefined): string {
  if (!envelope) return EMPTY_MESSAGE;
  try {
    const raw = extractTextFromParts(envelope.parts);
    const cleaned = stripCodeFences(raw);
    const truncated = truncateForTelegram(cleaned, SNIPPET_MAX_CHARS);
    if (!truncated) return EMPTY_MESSAGE;
    return escapeHtml(truncated);
  } catch {
    return EMPTY_MESSAGE;
  }
}

function findLastByRole(
  messages: Array<OpenCodeMessageEnvelope>,
  role: "user" | "assistant",
): OpenCodeMessageEnvelope | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.info.role === role) return msg;
  }
  return undefined;
}

function planReadinessKorean(result: PlanReadinessResult): string {
  if (result.ready) {
    return `${result.completed}/${result.total} (${result.planName})`;
  }
  switch (result.reason) {
    case "no-omo-dir":
      return "`.omo/` 없음";
    case "no-plans":
      return "plan 파일 없음";
    case "plan-empty":
      return "체크박스 없음";
    case "all-plans-complete": {
      const match = result.detail.match(/(\d+)\/(\d+)/);
      if (match) return `${match[1]}/${match[2]} 완료`;
      return "완료";
    }
    case "no-session-plan":
      return "세션 연결 plan 없음";
  }
}

function planLine(result: PlanReadinessResult): string {
  if (result.ready) {
    return `<b>플랜 진행도</b>: ${result.completed}/${result.total} (${escapeHtml(result.planName)})`;
  }
  return `<b>플랜 상태</b>: ${planReadinessKorean(result)}`;
}

function boulderLine(result: PlanReadinessResult): string {
  return result.boulderActive === true ? "<b>Boulder</b>: 활성" : "<b>Boulder</b>: 없음";
}

export function createStatusDispatcher(deps: StatusDispatcherDeps): StatusDispatcher {
  return async ({ chatId, bot, args }) => {
    const rawN = args[0];
    if (rawN === undefined || rawN === "") {
      await bot.sendMessage("사용법: /status &lt;번호&gt;. 먼저 /sessions 로 목록 확인", {
        parse_mode: "HTML",
      });
      return;
    }
    const n = Number(rawN);
    if (Number.isNaN(n)) {
      await bot.sendMessage(`잘못된 입력: ${escapeHtml(rawN)}은 숫자여야 합니다`, {
        parse_mode: "HTML",
      });
      return;
    }

    const snapshot = await deps.snapshotStore.loadSnapshot(chatId);
    if (!snapshot) {
      await bot.sendMessage("세션 목록이 없습니다. 먼저 /sessions 를 실행하세요.", {
        parse_mode: "HTML",
      });
      return;
    }

    const entry = snapshot.find((e) => e.index === n);
    if (!entry) {
      await bot.sendMessage(`${n}번 세션 없음. 현재 목록 크기: ${snapshot.length}`, {
        parse_mode: "HTML",
      });
      return;
    }

    const rawSourceServerUrl =
      entry.serverUrl ?? deps.sessionTitleService.getServerUrl(entry.sessionId);
    const sourceServerUrl = normalizeOpenCodeServerUrl(rawSourceServerUrl);
    if (rawSourceServerUrl && !sourceServerUrl) {
      await bot.sendMessage("세션 서버 정보가 유효하지 않습니다. /sessions 재실행 필요", {
        parse_mode: "HTML",
      });
      deps.logger.error("status invalid server url", { chatId, sessionId: entry.sessionId });
      return;
    }
    const useRemoteServer = isDifferentServerUrl(sourceServerUrl, deps.serverUrl);
    let session: OpenCodeSessionData | undefined;
    let responseStatus: number | undefined;
    let sessionStatus = "idle";
    let messages: OpenCodeMessageEnvelope[] = [];

    if (sourceServerUrl && useRemoteServer) {
      try {
        const getResult = await getRemoteSession(
          sourceServerUrl,
          entry.sessionId,
          deps.opencodeFetch,
        );
        session = getResult.data;
        responseStatus = getResult.response.status;
        if (!session || responseStatus === 404) {
          await bot.sendMessage("세션이 더 이상 존재하지 않습니다. /sessions 재실행 필요", {
            parse_mode: "HTML",
          });
          return;
        }
        const [statusMap, remoteMessages] = await Promise.all([
          getRemoteStatusMap(sourceServerUrl, deps.opencodeFetch),
          getRemoteMessages(sourceServerUrl, entry.sessionId, MESSAGES_LIMIT, deps.opencodeFetch),
        ]);
        sessionStatus = statusMap[entry.sessionId]?.type ?? "idle";
        messages = remoteMessages;
      } catch (err) {
        await bot.sendMessage("세션 상태를 불러오지 못했습니다. /sessions 재실행 필요", {
          parse_mode: "HTML",
        });
        deps.logger.error("status remote lookup failed", {
          chatId,
          sessionId: entry.sessionId,
          error: String(err),
        });
        return;
      }
    } else {
      const [getResult, statusResult, messagesResult] = await Promise.all([
        deps.client.session.get({ path: { id: entry.sessionId } }),
        deps.client.session.status(),
        deps.client.session.messages({
          path: { id: entry.sessionId },
          query: { limit: MESSAGES_LIMIT },
        }),
      ]);
      session = normalizeSession(getResult.data);
      responseStatus = getResult.response?.status;
      const statusMap = normalizeStatusMap(statusResult.data);
      sessionStatus = statusMap[entry.sessionId]?.type ?? "idle";
      messages = normalizeMessages(messagesResult.data);
    }

    if (!session || responseStatus === 404) {
      await bot.sendMessage("세션이 더 이상 존재하지 않습니다. /sessions 재실행 필요", {
        parse_mode: "HTML",
      });
      return;
    }

    const projectRoot = resolveProjectRoot(session);
    const rawTitle = session.title ?? entry.title;
    const rawAgent = entry.agent ?? session.agent;
    const planReady = await checkPlanReadiness({
      projectRoot,
      sessionId: entry.sessionId,
      planHint: rawTitle,
      allowLatestFallback: isPlanSessionAgent(rawAgent),
    });

    const userSnippet = buildSnippet(findLastByRole(messages, "user"));
    const assistantSnippet = buildSnippet(findLastByRole(messages, "assistant"));

    const title = escapeHtml(rawTitle ?? "");
    const agent = rawAgent ? escapeHtml(rawAgent) : "?";

    const text = [
      `📊 <b>세션 #${n}</b>: ${title}`,
      ``,
      `<b>에이전트</b>: ${agent}`,
      `<b>상태</b>: ${escapeHtml(sessionStatus)}`,
      ``,
      `<b>마지막 메시지</b>`,
      `유저: ${userSnippet}`,
      `에이전트: ${assistantSnippet}`,
      ``,
      planLine(planReady),
      boulderLine(planReady),
    ].join("\n");

    await bot.sendMessage(text, { parse_mode: "HTML" });
    deps.logger.info("status shown", {
      chatId,
      sessionId: entry.sessionId,
      snapshotIndex: n,
    });
  };
}
