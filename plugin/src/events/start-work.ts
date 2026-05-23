import type { TelegramStartWorkDispatcher } from "../bot.js";
import type { EventHandlerContext } from "./types.js";

const CALLBACK_RE = /^sw:(.+)$/;
const START_WORK_COMMAND = "start-work";

export function startWorkCallbackData(sessionID: string): string | undefined {
  const data = `sw:${encodeURIComponent(sessionID)}`;
  return Buffer.byteLength(data, "utf8") <= 64 ? data : undefined;
}

export function startWorkKeyboard(
  sessionID: string,
): Array<Array<{ text: string; callback_data: string }>> | undefined {
  const callbackData = startWorkCallbackData(sessionID);
  if (!callbackData) return undefined;
  return [[{ text: "▶️ Run /start-work", callback_data: callbackData }]];
}

export function createStartWorkDispatcher(ctx: EventHandlerContext): TelegramStartWorkDispatcher {
  return {
    async handleCallbackQuery(data, messageId) {
      const match = CALLBACK_RE.exec(data);
      if (!match) return;

      const sessionID = decodeURIComponent(match[1]);
      try {
        await ctx.runSessionCommand(sessionID, START_WORK_COMMAND);
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `▶️ Sent /start-work to opencode.\n\nSession: ${sessionID}`,
        );
        ctx.logger.info("start-work command sent", { sessionID });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `⚠️ Failed to send /start-work to opencode.\n\nSession: ${sessionID}`,
        );
        ctx.logger.error("failed to send start-work command", { sessionID, error: String(err) });
      }
    },
  };
}
