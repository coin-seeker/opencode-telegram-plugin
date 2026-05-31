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

function parseInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseAllowedUserIds(value: string | undefined): number[] | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const tokens = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (tokens.length === 0) return undefined;
  const parsed: number[] = [];
  for (const token of tokens) {
    const id = parseInteger(token);
    if (id === undefined) return undefined;
    parsed.push(id);
  }
  return parsed;
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
  if (allowedUserIds === undefined) {
    logger.error("missing or invalid TELEGRAM_ALLOWED_USER_IDS");
    throw new Error("Missing or invalid TELEGRAM_ALLOWED_USER_IDS");
  }

  let chatId: number | undefined;
  if (chatIdStr && chatIdStr.trim() !== "") {
    const parsed = parseInteger(chatIdStr.trim());
    if (parsed === undefined) {
      logger.error("invalid TELEGRAM_CHAT_ID");
      throw new Error("Invalid TELEGRAM_CHAT_ID");
    }
    chatId = parsed;
  }

  logger.info("config loaded", {
    allowedUserCount: allowedUserIds.length,
    hasChatId: chatId !== undefined,
  });

  return {
    botToken,
    allowedUserIds,
    chatId,
  };
}
