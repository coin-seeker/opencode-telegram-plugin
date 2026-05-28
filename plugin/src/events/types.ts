import type { PluginInput } from "@opencode-ai/plugin";
import type { TelegramBotManager } from "../bot.js";
import type { Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { PendingPermissionStore, PermissionReply } from "../lib/pending-permissions.js";
import type { PendingQuestionStore, QuestionAnswer } from "../lib/pending-questions.js";
import type { PendingStartWorkStore } from "../lib/pending-start-work.js";
import type { SessionRegistryStore } from "../lib/session-registry.js";
import type { StateStore } from "../lib/state-store.js";
import type { SessionTitleService } from "../services/session-title-service.js";

export type { QuestionAnswer } from "../lib/pending-questions.js";

export type OpencodeClient = PluginInput["client"];

export interface EventHandlerContext {
  client: OpencodeClient;
  bot: TelegramBotManager;
  sessionTitleService: SessionTitleService;
  stateStore: StateStore;
  config: Config;
  logger: Logger;
  claimsDir: string;
  pluginDir: string;
  serverUrl: URL;
  tokenHash: string;
  pendingQuestions: PendingQuestionStore;
  pendingPermissions: PendingPermissionStore;
  pendingStartWorks: PendingStartWorkStore;
  sessionRegistry: SessionRegistryStore;
  idleRecheckDelayMs?: number;
  replyToQuestion(requestID: string, answers: QuestionAnswer[], serverUrl?: string): Promise<void>;
  replyToPermission(
    requestID: string,
    sessionID: string,
    reply: PermissionReply,
    endpoint: "request" | "session",
    serverUrl?: string,
  ): Promise<void>;
  runSessionCommand(sessionID: string, command: string, serverUrl?: string): Promise<void>;
}
