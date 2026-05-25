import type { TelegramStartWorkDispatcher } from "../bot.js";
import { createStartWorkShortHash, type PendingStartWorkState } from "../lib/pending-start-work.js";
import type { EventHandlerContext } from "./types.js";

const CALLBACK_RE = /^sw:([^:]+)$/;
const START_WORK_COMMAND = "start-work";
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
      if (pending.expiresAt < Date.now()) {
        await expirePending(ctx, shortHash, pending, messageId);
        return;
      }

      try {
        await ctx.runSessionCommand(pending.sessionID, START_WORK_COMMAND, pending.serverUrl);
        const label = pending.title ?? pending.sessionID;
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `▶️ Sent /start-work to opencode.\n\nSession: ${label}`,
        );
        ctx.logger.info("start-work command sent", { sessionID: pending.sessionID });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          "⚠️ Failed to send /start-work to opencode",
        );
        ctx.logger.error("failed to send start-work command", {
          sessionID: pending.sessionID,
          error: String(err),
        });
      } finally {
        await ctx.pendingStartWorks.deletePending(shortHash);
      }
    },
  };
}
