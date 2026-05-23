import type { TelegramStartWorkDispatcher } from "../bot.js";
import type { EventHandlerContext } from "./types.js";

const CALLBACK_RE = /^sw:(.+)$/;
const START_WORK_COMMAND = "start-work";
const START_WORK_RE = /(?:^|[\s`])\/start-work(?:\s+([^\n`]+))?/g;

export interface StartWorkCommandInfo {
  sessionID: string;
  arguments: string;
}

export class StartWorkCommandStore {
  private commands = new Map<string, string>();

  updateFromText(sessionID: string, text: string): StartWorkCommandInfo | undefined {
    const command = extractStartWorkCommand(sessionID, text);
    if (!command) return undefined;
    this.commands.set(sessionID, command.arguments);
    return command;
  }

  get(sessionID: string): StartWorkCommandInfo | undefined {
    const args = this.commands.get(sessionID);
    if (args === undefined) return undefined;
    return { sessionID, arguments: args };
  }

  delete(sessionID: string): void {
    this.commands.delete(sessionID);
  }
}

export function extractStartWorkCommand(sessionID: string, text: string): StartWorkCommandInfo | undefined {
  let latestArgs: string | undefined;
  for (const match of text.matchAll(START_WORK_RE)) {
    const args = (match[1] ?? "").trim();
    if (args) latestArgs = args;
  }
  if (latestArgs === undefined) return undefined;
  return { sessionID, arguments: latestArgs };
}

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
      const command = ctx.startWorkCommands.get(sessionID);
      if (!command) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `⚠️ No /start-work command was detected for this session.\n\nSession: ${sessionID}`,
        );
        return;
      }

      try {
        await ctx.runSessionCommand(sessionID, START_WORK_COMMAND, command.arguments);
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `▶️ Sent /start-work ${command.arguments} to opencode.\n\nSession: ${sessionID}`,
        );
        ctx.startWorkCommands.delete(sessionID);
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
