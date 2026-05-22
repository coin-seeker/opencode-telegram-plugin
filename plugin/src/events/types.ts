import type { PluginInput } from "@opencode-ai/plugin";
import type { TelegramBotManager } from "../bot.js";
import type { Config } from "../config.js";
import type { SessionTitleService } from "../services/session-title-service.js";
import type { Logger } from "../lib/logger.js";
import type { StateStore } from "../lib/state-store.js";

export type OpencodeClient = PluginInput["client"];

export interface EventHandlerContext {
  client: OpencodeClient;
  bot: TelegramBotManager;
  sessionTitleService: SessionTitleService;
  stateStore: StateStore;
  config: Config;
  logger: Logger;
  claimsDir: string;
}
