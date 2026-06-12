import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { Bot, GrammyError } from "grammy";
import type { Config } from "./config.js";
import type { HelpDispatcher } from "./events/help-command.js";
import type { SessionsDispatcher } from "./events/sessions-command.js";
import type { StartWorkCommandDispatcher } from "./events/start-work-command.js";
import type { StatusDispatcher } from "./events/status-command.js";
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

export interface TelegramStartWorkDispatcher {
  handleCallbackQuery(data: string, messageId: number): Promise<void>;
}

export interface TelegramBotManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  isPolling(): boolean;
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
  setStartWorkDispatcher(dispatcher: TelegramStartWorkDispatcher): void;
  setSessionsDispatcher(dispatcher: SessionsDispatcher): void;
  setStatusDispatcher(dispatcher: StatusDispatcher): void;
  setStartWorkCommandDispatcher(dispatcher: StartWorkCommandDispatcher): void;
  setHelpDispatcher(dispatcher: HelpDispatcher): void;
}

export interface CreateBotOptions {
  config: Config;
  stateStore: StateStore;
  logger: Logger;
  initialChatId?: number;
}

export function createTelegramBot(opts: CreateBotOptions): TelegramBotManager {
  const { config, stateStore, logger } = opts;
  const bot = new Bot(config.botToken);
  let activeChatId: number | undefined = opts.initialChatId;
  let pollingActive = false;
  let questionDispatcher: TelegramQuestionDispatcher | undefined;
  let permissionDispatcher: TelegramPermissionDispatcher | undefined;
  let startWorkDispatcher: TelegramStartWorkDispatcher | undefined;
  let sessionsDispatcher: SessionsDispatcher | undefined;
  let statusDispatcher: StatusDispatcher | undefined;
  let startWorkCommandDispatcher: StartWorkCommandDispatcher | undefined;
  let helpDispatcher: HelpDispatcher | undefined;
  let managerObj: TelegramBotManager;

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

  bot.callbackQuery(/^sw:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!startWorkDispatcher || messageId === undefined) return;
    await startWorkDispatcher.handleCallbackQuery(data, messageId);
  });

  bot.command("sessions", async (ctx) => {
    if (!sessionsDispatcher) return;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;
    await sessionsDispatcher({ chatId, userId, bot: managerObj });
  });

  bot.command("status", async (ctx) => {
    if (!statusDispatcher) return;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    await statusDispatcher({ chatId, userId, bot: managerObj, args });
  });

  bot.command("start_work", async (ctx) => {
    if (!startWorkCommandDispatcher) return;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    await startWorkCommandDispatcher({ chatId, userId, bot: managerObj, args });
  });

  bot.command("help", async (ctx) => {
    if (!helpDispatcher) return;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;
    await helpDispatcher({ chatId, userId, bot: managerObj });
  });

  bot.on("message:text", async (ctx) => {
    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (!questionDispatcher || replyToMessageId === undefined || userId === undefined) return;
    await questionDispatcher.handleTextReply(ctx.message.text, chatId, userId, replyToMessageId);
  });

  const requireChatId = async (action: string): Promise<number> => {
    if (activeChatId) return activeChatId;
    const state = await stateStore.read();
    if (state.chatId) {
      activeChatId = state.chatId;
      return state.chatId;
    }
    throw new Error(`No active chat for ${action}. Send any message to the bot first.`);
  };

  managerObj = {
    async start() {
      if (pollingActive) return;
      pollingActive = true;
      try {
        await bot.api.setMyCommands([
          { command: "sessions", description: "활성 세션 목록 (top 20)" },
          { command: "status", description: "세션 상태 조회 (/status N)" },
          { command: "start_work", description: "plan-ready 세션 실행 (/start_work N)" },
          { command: "help", description: "명령 도움말" },
        ]);
      } catch (err) {
        logger.warn("setMyCommands failed", { error: String(err) });
      }
      try {
        // Keep pending updates: button taps and replies sent while no leader was polling
        // (leader handover, OpenCode restart) must still be delivered to the next leader.
        await bot.start({
          onStart: () => {
            logger.info("polling started");
          },
        });
      } catch (err) {
        pollingActive = false;
        throw err;
      }
    },
    async stop() {
      if (!pollingActive) return;
      pollingActive = false;
      try {
        await bot.stop();
      } catch (err) {
        logger.warn("bot.stop() error", { error: String(err) });
      }
    },
    isPolling() {
      return pollingActive;
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
    setStartWorkDispatcher(dispatcher) {
      startWorkDispatcher = dispatcher;
    },
    setSessionsDispatcher(dispatcher) {
      sessionsDispatcher = dispatcher;
    },
    setStatusDispatcher(dispatcher) {
      statusDispatcher = dispatcher;
    },
    setStartWorkCommandDispatcher(dispatcher) {
      startWorkCommandDispatcher = dispatcher;
    },
    setHelpDispatcher(dispatcher) {
      helpDispatcher = dispatcher;
    },
  };
  return managerObj;
}
