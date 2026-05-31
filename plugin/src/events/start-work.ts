import type { TelegramStartWorkDispatcher } from "../bot.js";
import { createStartWorkShortHash, type PendingStartWorkState } from "../lib/pending-start-work.js";
import type { EventHandlerContext } from "./types.js";

const CALLBACK_RE = /^sw:([^:]+)$/;
const START_WORK_EXPIRY_MS = 24 * 60 * 60_000;

export function startWorkKeyboard(
  shortHash: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const callbackData = `sw:${shortHash}`;
  if (Buffer.byteLength(callbackData, "utf8") > 64)
    throw new Error("Telegram callback_data exceeds 64 bytes");
  return [[{ text: "▶️ Run /start-work", callback_data: callbackData }]];
}

export function planCompleteMessage(title: string | null): string {
  return title ? `plan 작성이 끝났어요.\n\n${title}` : "plan 작성이 끝났어요.";
}

export function createPendingStartWork(
  sessionID: string,
  title: string | null,
  serverUrl: string,
  telegramMessageId: number,
): PendingStartWorkState {
  const sentAt = Date.now();
  return {
    sessionID,
    serverUrl,
    title: title ?? undefined,
    sentAt,
    expiresAt: sentAt + START_WORK_EXPIRY_MS,
    telegramMessageId,
    telegramMessageIds: [telegramMessageId],
    status: "pending",
  };
}

export function startWorkShortHash(sessionID: string): string {
  return createStartWorkShortHash(sessionID);
}

async function expirePending(
  ctx: EventHandlerContext,
  shortHash: string,
  pending: PendingStartWorkState,
  messageId: number,
): Promise<void> {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "⏱ /start-work request expired");
  await ctx.pendingStartWorks.deletePending(shortHash);
  ctx.logger.info("pending start-work expired", { sessionID: pending.sessionID });
}

const START_WORK_BUTTON_DISABLED_MESSAGE =
  "This /start-work button is no longer used. Use /sessions and /start_work <number> instead.";

function messageIdsFor(pending: PendingStartWorkState, currentMessageId: number): number[] {
  return [
    ...new Set([...(pending.telegramMessageIds ?? [pending.telegramMessageId]), currentMessageId]),
  ];
}

async function editDuplicateMessages(
  ctx: EventHandlerContext,
  pending: PendingStartWorkState,
  currentMessageId: number,
): Promise<void> {
  for (const messageId of messageIdsFor(pending, currentMessageId)) {
    if (messageId === currentMessageId) continue;
    try {
      await ctx.bot.editMessageRemoveKeyboard(messageId, START_WORK_BUTTON_DISABLED_MESSAGE);
    } catch (err) {
      ctx.logger.warn("failed to clear duplicate start-work keyboard", {
        messageId,
        error: String(err),
      });
    }
  }
}

async function consumePending(
  ctx: EventHandlerContext,
  shortHash: string,
  pending: PendingStartWorkState,
  messageId: number,
): Promise<void> {
  await ctx.pendingStartWorks.savePending(shortHash, {
    ...pending,
    telegramMessageId: messageId,
    telegramMessageIds: messageIdsFor(pending, messageId),
    status: "consumed",
    handledAt: Date.now(),
  });
}

export function createStartWorkDispatcher(ctx: EventHandlerContext): TelegramStartWorkDispatcher {
  return {
    async handleCallbackQuery(data, messageId) {
      const match = CALLBACK_RE.exec(data);
      if (!match) return;

      const shortHash = match[1];
      const pending = await ctx.pendingStartWorks.loadPending(shortHash);
      if (!pending) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "This /start-work request has expired.");
        return;
      }
      if (pending.status === "consumed") {
        await ctx.bot.editMessageRemoveKeyboard(messageId, START_WORK_BUTTON_DISABLED_MESSAGE);
        return;
      }
      if (pending.expiresAt < Date.now()) {
        await expirePending(ctx, shortHash, pending, messageId);
        return;
      }

      await consumePending(ctx, shortHash, pending, messageId);
      await ctx.bot.editMessageRemoveKeyboard(messageId, START_WORK_BUTTON_DISABLED_MESSAGE);
      await editDuplicateMessages(ctx, pending, messageId);
      ctx.logger.info("legacy start-work button disabled", { sessionID: pending.sessionID });
    },
  };
}
