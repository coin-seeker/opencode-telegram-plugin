import type { Logger } from "./lib/logger.js";

export const SERVICE_NAME = "TelegramRemote";

export interface Config {
  botToken: string;
  allowedUserIds: number[];
  chatId?: number;
}

export interface LoadConfigOptions {
  logger: Logger;
  env: NodeJS.ProcessEnv;
}

function parseAllowedUserIds(value: string | undefined): number[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => !Number.isNaN(id));
}

export function loadConfig(opts: LoadConfigOptions): Config {
  const { logger, env } = opts;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const allowedUserIdsStr = env.TELEGRAM_ALLOWED_USER_IDS;
  const chatIdStr = env.TELEGRAM_CHAT_ID;

  if (!botToken || botToken.trim() === "") {
    logger.error("missing TELEGRAM_BOT_TOKEN");
    throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  }

  const allowedUserIds = parseAllowedUserIds(allowedUserIdsStr);
  if (allowedUserIds.length === 0) {
    logger.error("missing or invalid TELEGRAM_ALLOWED_USER_IDS");
    throw new Error("Missing or invalid TELEGRAM_ALLOWED_USER_IDS");
  }

  let chatId: number | undefined;
  if (chatIdStr && chatIdStr.trim() !== "") {
    const parsed = Number.parseInt(chatIdStr.trim(), 10);
    if (!Number.isNaN(parsed)) {
      chatId = parsed;
    }
  }

  logger.info("config loaded", { allowedUserCount: allowedUserIds.length, hasChatId: chatId !== undefined });

  return {
    botToken,
    allowedUserIds,
    chatId,
  };
}
