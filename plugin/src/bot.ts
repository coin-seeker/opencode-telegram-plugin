import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { Bot, GrammyError } from "grammy";
import type { Config } from "./config.js";
import type { Logger } from "./lib/logger.js";
import { questionText } from "./lib/question-format.js";
import type { StateStore } from "./lib/state-store.js";

type SendMessageOptions = Parameters<Bot["api"]["sendMessage"]>[2];
type EditMessageOptions = Parameters<Bot["api"]["editMessageText"]>[3];

export interface TelegramQuestionDispatcher {
  handleCallbackQuery(
    data: string,
    messageId: number,
    chatId: number,
    userId: number,
  ): Promise<void>;
  handleTextReply(
    text: string,
    chatId: number,
    userId: number,
    replyToMessageId: number,
  ): Promise<void>;
}

export interface TelegramPermissionDispatcher {
  handleCallbackQuery(data: string, messageId: number): Promise<void>;
}

export interface TelegramBotManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(text: string, options?: SendMessageOptions): Promise<{ message_id: number }>;
  sendQuestionWithKeyboard(
    question: QuestionInfo,
    callbackData: string[],
  ): Promise<{ message_id: number }>;
  editMessage(messageId: number, text: string): Promise<void>;
  editMessageText(messageId: number, text: string, options?: EditMessageOptions): Promise<void>;
  editMessageRemoveKeyboard(messageId: number, finalText: string): Promise<void>;
  replyWithForceReply(text: string, placeholder: string): Promise<{ message_id: number }>;
  deleteMessage(messageId: number): Promise<void>;
  getActiveChatId(): Promise<number | undefined>;
  setQuestionDispatcher(dispatcher: TelegramQuestionDispatcher): void;
  setPermissionDispatcher(dispatcher: TelegramPermissionDispatcher): void;
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
  let questionDispatcher: TelegramQuestionDispatcher | undefined;
  let permissionDispatcher: TelegramPermissionDispatcher | undefined;

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
          await ctx.reply(
            `✅ Chat connected!\n\nYour chat_id: ${newChatId}\n\nThis chat is now active for OpenCode notifications.`,
          );
        }
      }
      await next();
    });

    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError && e.error_code === 409) {
        logger.info("polling conflict (409) - another process took over", {
          description: e.description,
        });
      } else {
        logger.error("bot error", { error: String(e) });
      }
    });

    bot.callbackQuery(/^q:([^:]+):(\d+):(\d+|c|d)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (
        !questionDispatcher ||
        messageId === undefined ||
        chatId === undefined ||
        userId === undefined
      )
        return;
      await questionDispatcher.handleCallbackQuery(data, messageId, chatId, userId);
    });

    bot.callbackQuery(/^p:([^:]+):(o|a|r)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      if (!permissionDispatcher || messageId === undefined) return;
      await permissionDispatcher.handleCallbackQuery(data, messageId);
    });

    bot.on("message:text", async (ctx) => {
      const replyToMessageId = ctx.message.reply_to_message?.message_id;
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;
      if (!questionDispatcher || replyToMessageId === undefined || userId === undefined) return;
      await questionDispatcher.handleTextReply(ctx.message.text, chatId, userId, replyToMessageId);
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
    async sendQuestionWithKeyboard(question, callbackData) {
      const inlineKeyboard = question.options.map((option, index) => [
        {
          text: option.label,
          callback_data: callbackData[index] ?? "",
        },
      ]);
      if (callbackData[question.options.length]) {
        inlineKeyboard.push([
          { text: "✏️ Custom answer", callback_data: callbackData[question.options.length] },
        ]);
      }
      return this.sendMessage(questionText(question), {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    },
    async editMessage(messageId: number, text: string) {
      const chatId = await requireChatId("editMessage");
      await bot.api.editMessageText(chatId, messageId, text);
    },
    async editMessageText(messageId: number, text: string, options?: EditMessageOptions) {
      const chatId = await requireChatId("editMessageText");
      await bot.api.editMessageText(chatId, messageId, text, options);
    },
    async editMessageRemoveKeyboard(messageId: number, finalText: string) {
      await this.editMessageText(messageId, finalText, { reply_markup: { inline_keyboard: [] } });
    },
    async replyWithForceReply(text: string, placeholder: string) {
      return this.sendMessage(text, {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: placeholder,
        },
      });
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
    setQuestionDispatcher(dispatcher) {
      questionDispatcher = dispatcher;
    },
    setPermissionDispatcher(dispatcher) {
      permissionDispatcher = dispatcher;
    },
  };
}
