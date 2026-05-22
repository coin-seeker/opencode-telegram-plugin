import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "./lib/logger.js";
import { acquireLock } from "./lib/lock.js";
import { createStateStore } from "./lib/state-store.js";
import { loadPluginEnv } from "./lib/env-loader.js";
import { loadConfig } from "./config.js";
import { createTelegramBot } from "./bot.js";
import { SessionTitleService } from "./services/session-title-service.js";
import { handlePermissionUpdated, handleSessionIdle, handleSessionUpdated } from "./events/index.js";
import type { EventHandlerContext } from "./events/types.js";

const pluginDir = dirname(fileURLToPath(import.meta.url));

export const TelegramRemote: Plugin = async (input: PluginInput) => {
  const logger = createLogger({ namespace: "telegram" });
  try {
    const envResult = loadPluginEnv({ pluginDir });
    logger.info("env loaded", { from: envResult.loadedFrom });

    const config = loadConfig({ logger, env: process.env });
    const stateStore = createStateStore();
    const initialState = await stateStore.read();
    const tokenHash = createHash("sha256").update(config.botToken).digest("hex").slice(0, 16);
    const lockPath = join(tmpdir(), `opencoder-telegram-${tokenHash}.lock`);
    const claimsDir = join(tmpdir(), `opencoder-telegram-claims-${tokenHash}`);
    const lockResult = await acquireLock({ lockPath });
    const isLeader = lockResult.acquired;

    logger.info(
      `lock ${isLeader ? "acquired - leader mode" : "held by other - pass-through mode"}`,
      isLeader ? {} : { reason: lockResult.reason },
    );

    const sessionTitleService = new SessionTitleService();
    const bot = createTelegramBot({
      config,
      stateStore,
      logger,
      initialChatId: initialState.chatId ?? config.chatId,
      polling: isLeader,
    });

    if (isLeader) {
      bot.start().catch((err) => {
        logger.error("bot polling stopped", { error: String(err) });
      });
    }

    const cleanup = async (): Promise<void> => {
      try {
        await bot.stop();
      } catch {
        // best-effort shutdown
      }
      if (lockResult.acquired) {
        await lockResult.handle.release();
      }
      await logger.close();
    };

    process.once("SIGINT", () => {
      void cleanup().then(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void cleanup().then(() => process.exit(0));
    });
    process.once("beforeExit", () => {
      void cleanup();
    });

    const ctx: EventHandlerContext = {
      client: input.client,
      bot,
      sessionTitleService,
      stateStore,
      config,
      logger,
      claimsDir,
    };

    return {
      event: async ({ event }: { event: Event }) => {
        switch (event.type) {
          case "session.idle":
            return handleSessionIdle(event, ctx);
          case "session.status":
            // opencode emits session.status with status.type === "idle" instead of session.idle
            if (event.properties.status.type === "idle") {
              return handleSessionIdle(event, ctx);
            }
            return;
          case "session.updated":
            return handleSessionUpdated(event, ctx);
          case "permission.updated":
            return handlePermissionUpdated(event, ctx);
        }
      },
    };
  } catch (err) {
    logger.error("plugin initialization failed", { error: err instanceof Error ? err.message : String(err) });
    await logger.close();
    return { event: async () => {} };
  }
};

export const id = "opencoder-telegram-remote";
export const server = TelegramRemote;
export default { id, server: TelegramRemote };
