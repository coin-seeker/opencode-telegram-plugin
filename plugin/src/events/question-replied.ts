import type { EventQuestionReplied } from "@opencode-ai/sdk/v2";
import { claimOnce } from "../lib/claim.js";
import { field, notice } from "../lib/message-format.js";
import type { PendingQuestionState } from "../lib/pending-questions.js";
import { discardCustomAnswerPrompt } from "./question-asked.js";
import type { EventHandlerContext } from "./types.js";

// question.replied can beat handleQuestionAsked's slow Telegram send (pending is saved only AFTER
// the send), especially across processes sharing one OpenCode server. Retry the lookup so the
// question message is still cleaned up once the pending file lands.
const DEFAULT_RETRY_DELAYS_MS = [0, 500, 1_500, 3_000, 5_000];

export interface HandleQuestionRepliedOptions {
  retryDelaysMs?: number[];
}

export function isEventQuestionReplied(event: {
  type: string;
  properties?: Record<string, unknown>;
}): event is EventQuestionReplied {
  if (event.type !== "question.replied") return false;
  const props = event.properties;
  return Boolean(
    props && typeof props.requestID === "string" && typeof props.sessionID === "string",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function answeredInOpencodeText(pending: PendingQuestionState): string {
  const header = pending.questions[0]?.header;
  return notice(
    "✅",
    "답변 완료",
    ...(header ? [field("질문", header)] : []),
    "OpenCode에서 직접 답변했어요.",
  );
}

async function findPendingWithRetry(
  ctx: EventHandlerContext,
  requestID: string,
  sessionID: string,
  retryDelaysMs: number[],
): Promise<{ shortHash: string; data: PendingQuestionState } | undefined> {
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await sleep(delayMs);
    const found = await ctx.pendingQuestions.findByRequestID(
      requestID,
      sessionID,
      ctx.serverUrl.href,
    );
    if (found) return found;
  }
  return undefined;
}

export async function handleQuestionReplied(
  event: EventQuestionReplied,
  ctx: EventHandlerContext,
  opts: HandleQuestionRepliedOptions = {},
): Promise<void> {
  const { requestID, sessionID } = event.properties;
  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `question.replied:${ctx.serverUrl.href}:${sessionID}:${requestID}`,
    ttlMs: 30_000,
  });
  if (!claimed) return;

  const found = await findPendingWithRetry(
    ctx,
    requestID,
    sessionID,
    opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  if (!found) {
    ctx.logger.info("question.replied no pending match", { requestID, sessionID });
    return;
  }

  const messageId = found.data.telegramMessageIds[0];
  const finalText = answeredInOpencodeText(found.data);
  try {
    await discardCustomAnswerPrompt(ctx, found.data);
    await ctx.bot.editMessageRemoveKeyboard(messageId, finalText);
  } catch (err) {
    ctx.logger.error("failed to edit externally answered question", {
      error: String(err),
      requestID,
    });
    // Editing can fail permanently (message older than 48h, deleted, rate-limited). Fall back to a
    // fresh message so the stale question never silently lingers as "unanswered".
    try {
      await ctx.bot.sendMessage(finalText);
    } catch (sendErr) {
      ctx.logger.error("failed to send answered-question fallback notice", {
        error: String(sendErr),
        requestID,
      });
    }
  } finally {
    await ctx.pendingQuestions.deletePending(found.shortHash);
  }
}
