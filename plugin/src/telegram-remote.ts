import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event, EventMessageUpdated } from "@opencode-ai/sdk";
import { createTelegramBot } from "./bot.js";
import { loadConfig } from "./config.js";
import {
  createHelpDispatcher,
  createPermissionDispatcher,
  createQuestionDispatcher,
  createSessionsDispatcher,
  createStartWorkCommandDispatcher,
  createStartWorkDispatcher,
  createStatusDispatcher,
  handlePermissionAsked,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleQuestionAsked,
  handleQuestionReplied,
  handleSessionCreated,
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionUpdated,
  isEventPermissionAsked,
  isEventPermissionReplied,
  isEventQuestionAsked,
  isEventQuestionReplied,
  isEventSessionError,
} from "./events/index.js";
import type { EventHandlerContext } from "./events/types.js";
import { loadPluginEnv } from "./lib/env-loader.js";
import { acquireLock } from "./lib/lock.js";
import { createLogger } from "./lib/logger.js";
import { normalizeOpenCodeServerUrl } from "./lib/opencode-http.js";
import { createPendingPermissionStore, type PermissionReply } from "./lib/pending-permissions.js";
import { createPendingQuestionStore, type QuestionAnswer } from "./lib/pending-questions.js";
import { createPendingStartWorkStore } from "./lib/pending-start-work.js";
import { createSessionRegistryStore } from "./lib/session-registry.js";
import { createSnapshotStore } from "./lib/session-snapshot.js";
import { createStateStore } from "./lib/state-store.js";
import { SessionTitleService } from "./services/session-title-service.js";

const pluginDir = dirname(fileURLToPath(import.meta.url));

type OpencodePostBody =
  | { answers: QuestionAnswer[] }
  | { reply: PermissionReply }
  | { response: PermissionReply }
  | { command: string; arguments: string };

interface InternalOpencodeHttpClient {
  post(options: {
    url: string;
    body: OpencodePostBody;
    headers: { "Content-Type": string };
    throwOnError: true;
  }): Promise<{ data?: boolean }>;
}

type OpencodeClientWithInternalHttp = PluginInput["client"] & {
  _client: InternalOpencodeHttpClient;
};

async function postToServer(
  serverUrl: string,
  path: string,
  body: OpencodePostBody,
): Promise<void> {
  const safeServerUrl = normalizeOpenCodeServerUrl(serverUrl);
  if (!safeServerUrl) throw new Error("Invalid OpenCode server URL");
  const url = new URL(path, safeServerUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (response.ok) return;

  throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
}

function getSessionAgentFromMessage(
  event: EventMessageUpdated,
): { sessionID: string; agent: string } | undefined {
  const info = event.properties.info;
  if (info.role !== "user") return undefined;
  return { sessionID: info.sessionID, agent: info.agent };
}

function getSessionAgentFromNextStep(event: {
  type: string;
  properties?: Record<string, unknown>;
}): { sessionID: string; agent: string } | undefined {
  if (event.type !== "session.next.step.started") return undefined;
  const props = event.properties;
  if (!props) return undefined;
  if (typeof props.sessionID !== "string") return undefined;
  if (typeof props.agent !== "string") return undefined;
  return { sessionID: props.sessionID, agent: props.agent };
}

export const TelegramRemote: Plugin = async (input: PluginInput) => {
  const logger = createLogger({ namespace: "telegram" });
  try {
    const envResult = loadPluginEnv({ pluginDir });
    logger.info("env loaded", { from: envResult.loadedFrom });

    const config = loadConfig({ logger, env: process.env });
    const stateStore = createStateStore();
    const initialState = await stateStore.read();
    const tokenHash = createHash("sha256").update(config.botToken).digest("hex").slice(0, 16);
    const configDir = join(homedir(), ".config/opencode/telegram-remote");
    const snapshotStore = createSnapshotStore({ configDir, tokenHash, logger });
    const sessionRegistry = createSessionRegistryStore({ configDir, tokenHash, logger });
    const lockPath = join(tmpdir(), `opencoder-telegram-${tokenHash}.lock`);
    const claimsDir = join(tmpdir(), `opencoder-telegram-claims-${tokenHash}`);
    const pendingQuestions = createPendingQuestionStore({ tokenHash });
    const pendingPermissions = createPendingPermissionStore({ tokenHash });
    const pendingStartWorks = createPendingStartWorkStore({ tokenHash });
    const lockResult = await acquireLock({ lockPath });
    const isLeader = lockResult.acquired;

    logger.info(
      `lock ${isLeader ? "acquired - leader mode" : "held by other - pass-through mode"}`,
      isLeader ? {} : { reason: lockResult.reason },
    );
    logger.info("server url", {
      url: input.serverUrl.toString(),
      href: input.serverUrl.href,
      origin: input.serverUrl.origin,
    });

    const sessionTitleService = new SessionTitleService();
    const client = input.client as OpencodeClientWithInternalHttp;
    const replyToQuestion = async (
      requestID: string,
      answers: QuestionAnswer[],
      serverUrl = input.serverUrl.href,
    ): Promise<void> => {
      const path = `/question/${encodeURIComponent(requestID)}/reply`;
      if (serverUrl !== input.serverUrl.href) {
        await postToServer(serverUrl, path, { answers });
        return;
      }
      await client._client.post({
        url: path,
        headers: { "Content-Type": "application/json" },
        body: { answers },
        throwOnError: true,
      });
    };
    const replyToPermission = async (
      requestID: string,
      sessionID: string,
      reply: PermissionReply,
      endpoint: "request" | "session",
      serverUrl = input.serverUrl.href,
    ): Promise<void> => {
      if (endpoint === "request") {
        const path = `/permission/${encodeURIComponent(requestID)}/reply`;
        if (serverUrl !== input.serverUrl.href) {
          await postToServer(serverUrl, path, { reply });
          return;
        }
        await client._client.post({
          url: path,
          headers: { "Content-Type": "application/json" },
          body: { reply },
          throwOnError: true,
        });
        return;
      }
      const path = `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}`;
      if (serverUrl !== input.serverUrl.href) {
        await postToServer(serverUrl, path, { response: reply });
        return;
      }
      await client._client.post({
        url: path,
        headers: { "Content-Type": "application/json" },
        body: { response: reply },
        throwOnError: true,
      });
    };
    const runSessionCommand = async (
      sessionID: string,
      command: string,
      serverUrl = input.serverUrl.href,
    ): Promise<void> => {
      const path = `/session/${encodeURIComponent(sessionID)}/command`;
      const body = { command, arguments: "" };
      if (serverUrl !== input.serverUrl.href) {
        await postToServer(serverUrl, path, body);
        return;
      }
      await input.client.session.command({
        path: { id: sessionID },
        body,
        throwOnError: true,
      });
    };
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
      pluginDir,
      serverUrl: input.serverUrl,
      tokenHash,
      pendingQuestions,
      pendingPermissions,
      pendingStartWorks,
      sessionRegistry,
      replyToQuestion,
      replyToPermission,
      runSessionCommand,
    };

    if (isLeader) {
      bot.setQuestionDispatcher(createQuestionDispatcher(ctx));
      bot.setPermissionDispatcher(createPermissionDispatcher(ctx));
      bot.setStartWorkDispatcher(createStartWorkDispatcher(ctx));
      bot.setSessionsDispatcher(createSessionsDispatcher({
        client: input.client,
        sessionTitleService,
        sessionRegistry,
        snapshotStore,
        serverUrl: input.serverUrl.href,
        logger,
      }));
      bot.setStatusDispatcher(createStatusDispatcher({
        snapshotStore,
        sessionTitleService,
        client: input.client,
        logger,
        serverUrl: input.serverUrl.href,
      }));
      bot.setStartWorkCommandDispatcher(createStartWorkCommandDispatcher({
        snapshotStore,
        sessionTitleService,
        client: input.client,
        serverUrl: input.serverUrl.href,
        runSessionCommand,
        logger,
      }));
      bot.setHelpDispatcher(createHelpDispatcher({ logger }));
    }

    return {
      event: async ({ event }: { event: Event }) => {
        const extEvent = event as { type: string; properties?: Record<string, unknown> };
        switch (event.type) {
          case "session.idle":
            return handleSessionIdle(event, ctx);
          case "session.status":
            logger.info("session.status received", { statusType: event.properties.status.type });
            return handleSessionStatus(event, ctx);
          case "session.created":
            ctx.sessionTitleService.setServerUrl(event.properties.info.id, input.serverUrl.href);
            return handleSessionCreated(event, ctx);
          case "session.updated":
            ctx.sessionTitleService.setServerUrl(event.properties.info.id, input.serverUrl.href);
            return handleSessionUpdated(event, ctx);
          case "message.updated": {
            const messageAgent = getSessionAgentFromMessage(event);
            if (messageAgent) {
              ctx.sessionTitleService.setSessionAgent(messageAgent.sessionID, messageAgent.agent);
              ctx.sessionTitleService.setServerUrl(messageAgent.sessionID, input.serverUrl.href);
              await ctx.sessionRegistry.updateSession(messageAgent.sessionID, {
                agent: messageAgent.agent,
                serverUrl: input.serverUrl.href,
                updatedAt: Date.now(),
              });
            }
            return;
          }
          case "permission.updated":
            return handlePermissionUpdated(event, ctx);
          default: {
            const stepAgent = getSessionAgentFromNextStep(extEvent);
            if (stepAgent) {
              ctx.sessionTitleService.setSessionAgent(stepAgent.sessionID, stepAgent.agent);
              ctx.sessionTitleService.setServerUrl(stepAgent.sessionID, input.serverUrl.href);
              await ctx.sessionRegistry.updateSession(stepAgent.sessionID, {
                agent: stepAgent.agent,
                serverUrl: input.serverUrl.href,
                updatedAt: Date.now(),
              });
              return;
            }
            if (isEventPermissionAsked(extEvent)) {
              if (!isLeader) return;
              return handlePermissionAsked(extEvent, ctx);
            }
            if (isEventSessionError(extEvent)) {
              return handleSessionError(extEvent, ctx);
            }
            if (isEventQuestionAsked(extEvent)) {
              if (!isLeader) return;
              return handleQuestionAsked(extEvent, ctx);
            }
            if (isEventQuestionReplied(extEvent)) {
              return handleQuestionReplied(extEvent, ctx);
            }
            if (isEventPermissionReplied(extEvent)) {
              return handlePermissionReplied(extEvent, ctx);
            }
            return;
          }
        }
      },
    };
  } catch (err) {
    logger.error("plugin initialization failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await logger.close();
    return { event: async () => {} };
  }
};

export const id = "opencoder-telegram-remote";
export const server = TelegramRemote;
export default { id, server: TelegramRemote };
