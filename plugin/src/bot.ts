import { Bot, GrammyError } from "grammy";
import type { Config } from "./config.js";
import type { Logger } from "./lib/logger.js";
import type { StateStore } from "./lib/state-store.js";

type SendMessageOptions = Parameters<Bot["api"]["sendMessage"]>[2];

export interface TelegramBotManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(text: string, options?: SendMessageOptions): Promise<{ message_id: number }>;
  editMessage(messageId: number, text: string): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  getActiveChatId(): Promise<number | undefined>;
}

export interface CreateBotOptions {
  config: Config;
  stateStore: StateStore;
  logger: Logger;
  initialChatId?: number;
  polling: boolean;
}

export function createTelegramBot(opts: CreateBotOptions): TelegramBotManager {
  const { config, stateStore, logger, polling } = opts;
  const bot = new Bot(config.botToken);
  let activeChatId: number | undefined = opts.initialChatId;

  if (polling) {
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !config.allowedUserIds.includes(userId)) {
        logger.warn("unauthorized access attempt", { userId });
        return;
      }
      if (ctx.chat?.type !== "private") return;
      if (ctx.chat?.id) {
        const newChatId = ctx.chat.id;
        if (activeChatId !== newChatId) {
          activeChatId = newChatId;
          await stateStore.write({ chatId: newChatId, discoveredBy: process.pid });
          logger.info("chat_id discovered", { chatId: newChatId });
          await ctx.reply(`✅ Chat connected!\n\nYour chat_id: ${newChatId}\n\nThis chat is now active for OpenCode notifications.`);
        }
      }
      await next();
    });

    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError && e.error_code === 409) {
        logger.info("polling conflict (409) - another process took over", { description: e.description });
      } else {
        logger.error("bot error", { error: String(e) });
      }
    });
  }

  const requireChatId = async (action: string): Promise<number> => {
    if (activeChatId) return activeChatId;
    const state = await stateStore.read();
    if (state.chatId) {
      activeChatId = state.chatId;
      return state.chatId;
    }
    throw new Error(`No active chat for ${action}. Send any message to the bot first.`);
  };

  return {
    async start() {
      if (!polling) {
        logger.info("pass-through mode - skipping bot.start()");
        return;
      }
      await bot.start({
        drop_pending_updates: true,
        onStart: () => {
          logger.info("polling started");
        },
      });
    },
    async stop() {
      if (polling) {
        try {
          await bot.stop();
        } catch (err) {
          logger.warn("bot.stop() error", { error: String(err) });
        }
      }
    },
    async sendMessage(text, options) {
      const chatId = await requireChatId("sendMessage");
      const result = await bot.api.sendMessage(chatId, text, options);
      return { message_id: result.message_id };
    },
    async editMessage(messageId: number, text: string) {
      const chatId = await requireChatId("editMessage");
      await bot.api.editMessageText(chatId, messageId, text);
    },
    async deleteMessage(messageId: number) {
      const chatId = await requireChatId("deleteMessage");
      await bot.api.deleteMessage(chatId, messageId);
    },
    async getActiveChatId() {
      if (activeChatId) return activeChatId;
      const state = await stateStore.read();
      return state.chatId;
    },
  };
}
