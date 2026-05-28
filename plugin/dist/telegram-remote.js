/**
 * OpenCoder Telegram Remote Plugin
 * https://github.com/coin-seeker/opencode-telegram-plugin
 */

// src/telegram-remote.ts
import { createHash as createHash5 } from "crypto";
import { homedir as homedir3, tmpdir as tmpdir5 } from "os";
import { dirname as dirname6, join as join10 } from "path";
import { fileURLToPath } from "url";

// src/bot.ts
import { Bot, GrammyError } from "grammy";

// src/lib/question-format.ts
function optionDescriptionText(question) {
  const options = question.options.map((option, index) => {
    const description = option.description.trim();
    return description ? `${index + 1}. ${option.label}
\uC124\uBA85: ${description}` : `${index + 1}. ${option.label}`;
  });
  return options.length > 0 ? `

Options:

${options.join("\n\n")}` : "";
}
function questionText(question, progress) {
  const title = question.header || "Question";
  const header = progress ? `\u2753 ${progress} \xB7 ${title}` : `\u2753 ${title}`;
  return `${header}

${question.question}${optionDescriptionText(question)}`;
}
function pendingQuestionText(questions, questionIndex) {
  const question = questions[questionIndex];
  const progress = questions.length > 1 ? `Question ${questionIndex + 1}/${questions.length}` : void 0;
  return questionText(question, progress);
}

// src/bot.ts
function createTelegramBot(opts) {
  const { config, stateStore, logger, polling } = opts;
  const bot = new Bot(config.botToken);
  let activeChatId = opts.initialChatId;
  let questionDispatcher;
  let permissionDispatcher;
  let startWorkDispatcher;
  let sessionsDispatcher;
  let statusDispatcher;
  let startWorkCommandDispatcher;
  let helpDispatcher;
  let managerObj;
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
            `\u2705 Chat connected!

Your chat_id: ${newChatId}

This chat is now active for OpenCode notifications.`
          );
        }
      }
      await next();
    });
    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError && e.error_code === 409) {
        logger.info("polling conflict (409) - another process took over", {
          description: e.description
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
      if (!questionDispatcher || messageId === void 0 || chatId === void 0 || userId === void 0)
        return;
      await questionDispatcher.handleCallbackQuery(data, messageId, chatId, userId);
    });
    bot.callbackQuery(/^p:([^:]+):(o|a|r)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      if (!permissionDispatcher || messageId === void 0) return;
      await permissionDispatcher.handleCallbackQuery(data, messageId);
    });
    bot.callbackQuery(/^sw:([^:]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      if (!startWorkDispatcher || messageId === void 0) return;
      await startWorkDispatcher.handleCallbackQuery(data, messageId);
    });
    bot.command("sessions", async (ctx) => {
      if (!sessionsDispatcher) return;
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (chatId === void 0 || userId === void 0) return;
      await sessionsDispatcher({ chatId, userId, bot: managerObj });
    });
    bot.command("status", async (ctx) => {
      if (!statusDispatcher) return;
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (chatId === void 0 || userId === void 0) return;
      const args = ctx.match.trim().split(/\s+/).filter(Boolean);
      await statusDispatcher({ chatId, userId, bot: managerObj, args });
    });
    bot.command("start_work", async (ctx) => {
      if (!startWorkCommandDispatcher) return;
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (chatId === void 0 || userId === void 0) return;
      const args = ctx.match.trim().split(/\s+/).filter(Boolean);
      await startWorkCommandDispatcher({ chatId, userId, bot: managerObj, args });
    });
    bot.command("help", async (ctx) => {
      if (!helpDispatcher) return;
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (chatId === void 0 || userId === void 0) return;
      await helpDispatcher({ chatId, userId, bot: managerObj });
    });
    bot.on("message:text", async (ctx) => {
      const replyToMessageId = ctx.message.reply_to_message?.message_id;
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;
      if (!questionDispatcher || replyToMessageId === void 0 || userId === void 0) return;
      await questionDispatcher.handleTextReply(ctx.message.text, chatId, userId, replyToMessageId);
    });
  }
  const requireChatId = async (action) => {
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
      if (!polling) {
        logger.info("pass-through mode - skipping bot.start()");
        return;
      }
      try {
        await bot.api.setMyCommands([
          { command: "sessions", description: "\uD65C\uC131 \uC138\uC158 \uBAA9\uB85D (top 20)" },
          { command: "status", description: "\uC138\uC158 \uC0C1\uD0DC \uC870\uD68C (/status N)" },
          { command: "start_work", description: "plan-ready \uC138\uC158 \uC2E4\uD589 (/start_work N)" },
          { command: "help", description: "\uBA85\uB839 \uB3C4\uC6C0\uB9D0" }
        ]);
      } catch (err) {
        logger.warn("setMyCommands failed", { error: String(err) });
      }
      await bot.start({
        drop_pending_updates: true,
        onStart: () => {
          logger.info("polling started");
        }
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
          callback_data: callbackData[index] ?? ""
        }
      ]);
      if (callbackData[question.options.length]) {
        inlineKeyboard.push([
          { text: "\u270F\uFE0F Custom answer", callback_data: callbackData[question.options.length] }
        ]);
      }
      return this.sendMessage(questionText(question), {
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    },
    async editMessage(messageId, text) {
      const chatId = await requireChatId("editMessage");
      await bot.api.editMessageText(chatId, messageId, text);
    },
    async editMessageText(messageId, text, options) {
      const chatId = await requireChatId("editMessageText");
      await bot.api.editMessageText(chatId, messageId, text, options);
    },
    async editMessageRemoveKeyboard(messageId, finalText) {
      await this.editMessageText(messageId, finalText, { reply_markup: { inline_keyboard: [] } });
    },
    async replyWithForceReply(text, placeholder) {
      return this.sendMessage(text, {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: placeholder
        }
      });
    },
    async deleteMessage(messageId) {
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
    }
  };
  return managerObj;
}

// src/config.ts
function parseAllowedUserIds(value) {
  if (!value || value.trim() === "") {
    return [];
  }
  return value.split(",").map((id2) => id2.trim()).filter((id2) => id2 !== "").map((id2) => Number.parseInt(id2, 10)).filter((id2) => !Number.isNaN(id2));
}
function loadConfig(opts) {
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
  let chatId;
  if (chatIdStr && chatIdStr.trim() !== "") {
    const parsed = Number.parseInt(chatIdStr.trim(), 10);
    if (!Number.isNaN(parsed)) {
      chatId = parsed;
    }
  }
  logger.info("config loaded", { allowedUserCount: allowedUserIds.length, hasChatId: chatId !== void 0 });
  return {
    botToken,
    allowedUserIds,
    chatId
  };
}

// src/lib/claim.ts
import { mkdir, open, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
var DEFAULT_TTL_MS = 6e4;
var sweptDirs = /* @__PURE__ */ new Set();
function hasCode(err, code) {
  return "code" in err && err.code === code;
}
function claimPath(claimsDir, key) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(claimsDir, `${hash}.claim`);
}
async function sweep(claimsDir, ttlMs) {
  if (sweptDirs.has(claimsDir)) return;
  sweptDirs.add(claimsDir);
  try {
    const entries = await readdir(claimsDir, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".claim")).map(async (entry) => {
      const filePath = join(claimsDir, entry.name);
      try {
        const fileStat = await stat(filePath);
        if (Date.now() - fileStat.mtimeMs > ttlMs * 2) {
          await unlink(filePath);
        }
      } catch {
      }
    }));
  } catch {
  }
}
async function createClaim(filePath) {
  const file = await open(filePath, "wx");
  try {
    await file.writeFile((/* @__PURE__ */ new Date()).toISOString(), "utf8");
  } finally {
    await file.close();
  }
  return true;
}
async function claimOnce(opts) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  await mkdir(opts.claimsDir, { recursive: true });
  await sweep(opts.claimsDir, ttlMs);
  const filePath = claimPath(opts.claimsDir, opts.key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createClaim(filePath);
    } catch (err) {
      if (!(err instanceof Error) || !hasCode(err, "EEXIST")) throw err;
      try {
        const fileStat = await stat(filePath);
        if (Date.now() - fileStat.mtimeMs <= ttlMs || attempt === 1) return false;
        await unlink(filePath);
      } catch (statErr) {
        if (statErr instanceof Error && hasCode(statErr, "ENOENT")) continue;
        return false;
      }
    }
  }
  return false;
}

// src/lib/pending-permissions.ts
import { createHash as createHash2 } from "crypto";
import { mkdir as mkdir2, readFile, readdir as readdir2, rename, unlink as unlink2, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join as join2 } from "path";
function hasCode2(err, code) {
  return "code" in err && err.code === code;
}
function pendingFilePath(dir, shortHash) {
  return join2(dir, `${shortHash}.json`);
}
function parsePending(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.requestID !== "string") throw new Error("Invalid pending permission: requestID");
  if (typeof parsed.sessionID !== "string") throw new Error("Invalid pending permission: sessionID");
  if (typeof parsed.title !== "string") throw new Error("Invalid pending permission: title");
  if (typeof parsed.permission !== "string") throw new Error("Invalid pending permission: permission");
  if (!Array.isArray(parsed.patterns)) throw new Error("Invalid pending permission: patterns");
  if (!Array.isArray(parsed.always)) throw new Error("Invalid pending permission: always");
  if (parsed.endpoint !== "request" && parsed.endpoint !== "session") throw new Error("Invalid pending permission: endpoint");
  return parsed;
}
async function listPendingFiles(dir) {
  try {
    const entries = await readdir2(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode2(err, "ENOENT")) return [];
    throw err;
  }
}
function shortHashFromFileName(fileName) {
  return fileName.slice(0, -".json".length);
}
function createPendingPermissionStore(opts) {
  const dir = opts.baseDir ?? join2(tmpdir(), `opencoder-telegram-pending-permissions-${opts.tokenHash}`);
  return {
    dir,
    async savePending(shortHash, data) {
      const filePath = pendingFilePath(dir, shortHash);
      await mkdir2(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
      await rename(tmpPath, filePath);
    },
    async loadPending(shortHash) {
      try {
        return parsePending(await readFile(pendingFilePath(dir, shortHash), "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode2(err, "ENOENT")) return void 0;
        throw err;
      }
    },
    async deletePending(shortHash) {
      try {
        await unlink2(pendingFilePath(dir, shortHash));
      } catch (err) {
        if (!(err instanceof Error) || !hasCode2(err, "ENOENT")) throw err;
      }
    },
    async findByRequestID(requestID) {
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data?.requestID === requestID) return { shortHash, data };
      }
      return void 0;
    },
    async sweepExpired() {
      const expired = [];
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data && data.expiresAt < Date.now()) {
          expired.push(data);
          await this.deletePending(shortHash);
        }
      }
      return expired;
    }
  };
}
function createPermissionShortHash(requestID) {
  return createHash2("sha256").update(requestID).digest("base64url").slice(0, 10);
}

// src/events/permission-updated.ts
var PERMISSION_EXPIRY_MS = 5 * 6e4;
var CALLBACK_RE = /^p:([^:]+):(o|a|r)$/;
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isEventPermissionAsked(event) {
  if (event.type !== "permission.asked") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.id !== "string") return false;
  if (typeof props.sessionID !== "string") return false;
  if (typeof props.permission !== "string") return false;
  if (!isStringArray(props.patterns)) return false;
  if (!isStringArray(props.always)) return false;
  return true;
}
function buildCallbackData(shortHash, reply) {
  const data = `p:${shortHash}:${reply}`;
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}
function normalizeUpdated(permission) {
  const pattern = permission.pattern === void 0 ? [] : Array.isArray(permission.pattern) ? permission.pattern : [permission.pattern];
  return {
    requestID: permission.id,
    sessionID: permission.sessionID,
    title: permission.title,
    permission: permission.type,
    patterns: pattern,
    always: [],
    endpoint: "session",
    claimKey: `permission.updated:${permission.id}`
  };
}
function normalizeAsked(permission) {
  return {
    requestID: permission.id,
    sessionID: permission.sessionID,
    title: permission.patterns.join(", ") || permission.permission,
    permission: permission.permission,
    patterns: permission.patterns,
    always: permission.always,
    endpoint: "request",
    claimKey: `permission.asked:${permission.id}`
  };
}
function permissionMessage(permission, sessionTitle) {
  const titleLine = sessionTitle ? `\u{1F4CB} ${sessionTitle}` : `Session: ${permission.sessionID}`;
  const patterns = permission.patterns.length > 0 ? `
Patterns: ${permission.patterns.join(", ")}` : "";
  const always = permission.always.length > 0 ? `
Always options: ${permission.always.join(", ")}` : "";
  return `\u2753 Permission requested

${titleLine}

Permission: ${permission.permission}
Detail: ${permission.title}${patterns}${always}`;
}
function permissionKeyboard(shortHash) {
  return [
    [{ text: "\u2705 Allow once", callback_data: buildCallbackData(shortHash, "o") }],
    [{ text: "\u267B\uFE0F Always allow", callback_data: buildCallbackData(shortHash, "a") }],
    [{ text: "\u274C Reject", callback_data: buildCallbackData(shortHash, "r") }]
  ];
}
function replyFromSelection(selection) {
  if (selection === "o") return "once";
  if (selection === "a") return "always";
  if (selection === "r") return "reject";
  return void 0;
}
function replyLabel(reply) {
  if (reply === "once") return "Allowed once";
  if (reply === "always") return "Always allowed";
  return "Rejected";
}
async function handleNormalizedPermission(permission, ctx) {
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: permission.claimKey });
  if (!claimed) return;
  const shortHash = createPermissionShortHash(permission.requestID);
  const sentAt = Date.now();
  const rawSessionTitle = ctx.sessionTitleService.getSessionTitle(permission.sessionID);
  const sessionTitle = rawSessionTitle === null ? void 0 : rawSessionTitle;
  try {
    const message = await ctx.bot.sendMessage(permissionMessage(permission, sessionTitle), {
      reply_markup: { inline_keyboard: permissionKeyboard(shortHash) }
    });
    const pending = {
      requestID: permission.requestID,
      sessionID: permission.sessionID,
      serverUrl: ctx.serverUrl.href,
      title: permission.title,
      permission: permission.permission,
      patterns: permission.patterns,
      always: permission.always,
      sentAt,
      expiresAt: sentAt + PERMISSION_EXPIRY_MS,
      telegramMessageId: message.message_id,
      endpoint: permission.endpoint
    };
    await ctx.pendingPermissions.savePending(shortHash, pending);
  } catch (err) {
    ctx.logger.error("failed to send permission notification", { error: String(err) });
  }
}
async function expirePending(ctx, shortHash, pending, messageId) {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "\u23F1 Permission request expired");
  await ctx.pendingPermissions.deletePending(shortHash);
  ctx.logger.info("pending permission expired", { requestID: pending.requestID });
}
async function handlePermissionUpdated(event, ctx) {
  await handleNormalizedPermission(normalizeUpdated(event.properties), ctx);
}
async function handlePermissionAsked(event, ctx) {
  await handleNormalizedPermission(normalizeAsked(event.properties), ctx);
}
function isEventPermissionReplied(event) {
  if (event.type !== "permission.replied") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.sessionID !== "string") return false;
  const hasId = typeof props.permissionID === "string" || typeof props.requestID === "string";
  return hasId;
}
function externalReplyLabel(value) {
  if (value === "once") return "Allowed once in opencode";
  if (value === "always") return "Always allowed in opencode";
  if (value === "reject") return "Rejected in opencode";
  return "Already answered in opencode";
}
async function handlePermissionReplied(event, ctx) {
  const requestID = event.properties.requestID ?? event.properties.permissionID;
  if (!requestID) return;
  const found = await ctx.pendingPermissions.findByRequestID(requestID);
  if (!found) return;
  const label = externalReplyLabel(event.properties.reply ?? event.properties.response);
  try {
    await ctx.bot.editMessageRemoveKeyboard(
      found.data.telegramMessageId,
      `\u2705 ${label}

${found.data.permission}: ${found.data.title}`
    );
    ctx.logger.info("permission externally replied - cleared pending", {
      requestID,
      sessionID: event.properties.sessionID
    });
  } catch (err) {
    ctx.logger.error("failed to edit externally replied permission", {
      error: String(err),
      requestID
    });
  } finally {
    await ctx.pendingPermissions.deletePending(found.shortHash);
  }
}
function createPermissionDispatcher(ctx) {
  return {
    async handleCallbackQuery(data, messageId) {
      const match = CALLBACK_RE.exec(data);
      if (!match) return;
      const shortHash = match[1];
      const reply = replyFromSelection(match[2]);
      if (!reply) return;
      const pending = await ctx.pendingPermissions.loadPending(shortHash);
      if (!pending) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "This permission request has expired.");
        return;
      }
      if (pending.expiresAt < Date.now()) {
        await expirePending(ctx, shortHash, pending, messageId);
        return;
      }
      try {
        await ctx.replyToPermission(
          pending.requestID,
          pending.sessionID,
          reply,
          pending.endpoint,
          pending.serverUrl
        );
        await ctx.bot.editMessageRemoveKeyboard(messageId, `\u2705 Permission ${replyLabel(reply)}

${pending.permission}: ${pending.title}`);
        ctx.logger.info("permission reply sent", { requestID: pending.requestID, sessionID: pending.sessionID, reply });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "\u26A0\uFE0F Failed to send permission reply to opencode");
        ctx.logger.error("failed to send permission reply", { error: String(err), requestID: pending.requestID });
      } finally {
        await ctx.pendingPermissions.deletePending(shortHash);
      }
    }
  };
}

// src/lib/pending-questions.ts
import { createHash as createHash3 } from "crypto";
import { mkdir as mkdir3, readFile as readFile2, readdir as readdir3, rename as rename2, unlink as unlink3, writeFile as writeFile2 } from "fs/promises";
import { tmpdir as tmpdir2 } from "os";
import { dirname as dirname2, join as join3 } from "path";
function hasCode3(err, code) {
  return "code" in err && err.code === code;
}
function pendingFilePath2(dir, shortHash) {
  return join3(dir, `${shortHash}.json`);
}
function parsePending2(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.requestID !== "string") throw new Error("Invalid pending question: requestID");
  if (typeof parsed.sessionID !== "string") throw new Error("Invalid pending question: sessionID");
  if (!Array.isArray(parsed.questions)) throw new Error("Invalid pending question: questions");
  if (!Array.isArray(parsed.telegramMessageIds)) throw new Error("Invalid pending question: telegramMessageIds");
  if (!Array.isArray(parsed.answersInProgress)) throw new Error("Invalid pending question: answersInProgress");
  parsed.answersInProgress = parsed.answersInProgress.map((answer) => answer ?? null);
  return parsed;
}
async function listPendingFiles2(dir) {
  try {
    const entries = await readdir3(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode3(err, "ENOENT")) return [];
    throw err;
  }
}
function shortHashFromFileName2(fileName) {
  return fileName.slice(0, -".json".length);
}
function createPendingQuestionStore(opts) {
  const dir = opts.baseDir ?? join3(tmpdir2(), `opencoder-telegram-pending-questions-${opts.tokenHash}`);
  return {
    dir,
    async savePending(shortHash, data) {
      const filePath = pendingFilePath2(dir, shortHash);
      await mkdir3(dirname2(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile2(tmpPath, JSON.stringify(data, null, 2), "utf8");
      await rename2(tmpPath, filePath);
    },
    async loadPending(shortHash) {
      try {
        return parsePending2(await readFile2(pendingFilePath2(dir, shortHash), "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode3(err, "ENOENT")) return void 0;
        throw err;
      }
    },
    async deletePending(shortHash) {
      try {
        await unlink3(pendingFilePath2(dir, shortHash));
      } catch (err) {
        if (!(err instanceof Error) || !hasCode3(err, "ENOENT")) throw err;
      }
    },
    async sweepExpired() {
      const expired = [];
      for (const fileName of await listPendingFiles2(dir)) {
        const shortHash = shortHashFromFileName2(fileName);
        const data = await this.loadPending(shortHash);
        if (data && data.expiresAt < Date.now()) {
          expired.push(data);
          await this.deletePending(shortHash);
        }
      }
      return expired;
    },
    async findByRequestID(requestID) {
      for (const fileName of await listPendingFiles2(dir)) {
        const shortHash = shortHashFromFileName2(fileName);
        const data = await this.loadPending(shortHash);
        if (data?.requestID === requestID) return { shortHash, data };
      }
      return void 0;
    },
    async findAwaitingCustom(chatId, userId) {
      for (const fileName of await listPendingFiles2(dir)) {
        const shortHash = shortHashFromFileName2(fileName);
        const data = await this.loadPending(shortHash);
        const awaiting = data?.awaitingCustomFor;
        if (awaiting && awaiting.chatId === chatId && awaiting.userId === userId) return { shortHash, data };
      }
      return void 0;
    }
  };
}
function createQuestionShortHash(requestID) {
  return createHash3("sha256").update(requestID).digest("base64url").slice(0, 10);
}

// src/events/question-asked.ts
var QUESTION_EXPIRY_MS = 5 * 6e4;
var CALLBACK_RE2 = /^q:([^:]+):(\d+):(\d+|c|d)$/;
function isQuestionOption(value) {
  return typeof value.label === "string" && typeof value.description === "string";
}
function isQuestionInfo(value) {
  if (typeof value.question !== "string") return false;
  if (typeof value.header !== "string") return false;
  if (!Array.isArray(value.options)) return false;
  return value.options.every(
    (option) => typeof option === "object" && option !== null && isQuestionOption(option)
  );
}
function isEventQuestionAsked(event) {
  if (event.type !== "question.asked") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.id !== "string") return false;
  if (typeof props.sessionID !== "string") return false;
  if (!Array.isArray(props.questions)) return false;
  return props.questions.every(
    (question) => typeof question === "object" && question !== null && isQuestionInfo(question)
  );
}
function buildCallbackData2(shortHash, questionIndex, optionIndex) {
  const data = `q:${shortHash}:${questionIndex}:${optionIndex}`;
  if (Buffer.byteLength(data, "utf8") > 64)
    throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}
function callbackDataForQuestion(shortHash, questionIndex, question) {
  const data = question.options.map(
    (_, optionIndex) => buildCallbackData2(shortHash, questionIndex, optionIndex)
  );
  if (question.custom !== false) data.push(buildCallbackData2(shortHash, questionIndex, "c"));
  return data;
}
function useSimpleQuestionKeyboard(question) {
  return question.multiple !== true;
}
function selectedAnswers(pending, questionIndex) {
  return pending.answersInProgress[questionIndex] ?? [];
}
function questionInlineKeyboard(shortHash, questionIndex, question, selected) {
  const multiple = question.multiple === true;
  const inlineKeyboard = question.options.map((option, optionIndex) => [
    {
      text: multiple && selected.includes(option.label) ? `\u2705 ${option.label}` : option.label,
      callback_data: buildCallbackData2(shortHash, questionIndex, optionIndex)
    }
  ]);
  if (question.custom !== false) {
    inlineKeyboard.push([
      { text: "\u270F\uFE0F Custom answer", callback_data: buildCallbackData2(shortHash, questionIndex, "c") }
    ]);
  }
  if (multiple) {
    inlineKeyboard.push([
      { text: "\u2705 Done", callback_data: buildCallbackData2(shortHash, questionIndex, "d") }
    ]);
  }
  return inlineKeyboard;
}
function questionPromptText(pending, questionIndex) {
  return pendingQuestionText(pending.questions, questionIndex);
}
function answerSummary(questions, answers) {
  return answers.map(
    (answer, index) => `${index + 1}. ${questions[index]?.header ?? "Question"}: ${answer.join(", ") || "(empty)"}`
  ).join("\n");
}
async function editPromptForQuestion(ctx, pending, shortHash, questionIndex) {
  const messageId = pending.telegramMessageIds[0];
  const question = pending.questions[questionIndex];
  const inlineKeyboard = questionInlineKeyboard(
    shortHash,
    questionIndex,
    question,
    selectedAnswers(pending, questionIndex)
  );
  await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), {
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
}
async function completeIfReady(ctx, pending, shortHash) {
  const nextIndex = pending.answersInProgress.findIndex((answer) => answer === null);
  if (nextIndex >= 0) {
    pending.currentQuestionIndex = nextIndex;
    await ctx.pendingQuestions.savePending(shortHash, pending);
    await editPromptForQuestion(ctx, pending, shortHash, nextIndex);
    return;
  }
  const answers = pending.answersInProgress.map((answer) => answer ?? []);
  const messageId = pending.telegramMessageIds[0];
  try {
    await ctx.replyToQuestion(pending.requestID, answers, pending.serverUrl);
    await ctx.bot.editMessageRemoveKeyboard(
      messageId,
      `\u2705 Answered:
${answerSummary(pending.questions, answers)}`
    );
    ctx.logger.info("question reply sent", {
      requestID: pending.requestID,
      sessionID: pending.sessionID
    });
  } catch (err) {
    await ctx.bot.editMessageRemoveKeyboard(messageId, "\u26A0\uFE0F Failed to send answer to opencode");
    ctx.logger.error("failed to send question reply", {
      error: String(err),
      requestID: pending.requestID
    });
  } finally {
    await ctx.pendingQuestions.deletePending(shortHash);
  }
}
async function expirePending2(ctx, shortHash, pending, messageId) {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "\u23F1 Question expired");
  await ctx.pendingQuestions.deletePending(shortHash);
  ctx.logger.info("pending question expired", { requestID: pending.requestID });
}
async function handleQuestionAsked(event, ctx) {
  const request = event.properties;
  if (request.questions.length === 0) return;
  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `question.asked:${request.id}`,
    ttlMs: 5e3
  });
  if (!claimed) return;
  const shortHash = createQuestionShortHash(request.id);
  const firstQuestion = request.questions[0];
  const sentAt = Date.now();
  const pending = {
    requestID: request.id,
    sessionID: request.sessionID,
    serverUrl: ctx.serverUrl.href,
    questions: request.questions,
    sentAt,
    expiresAt: sentAt + QUESTION_EXPIRY_MS,
    telegramMessageIds: [],
    currentQuestionIndex: 0,
    answersInProgress: request.questions.map(() => null)
  };
  try {
    const message = request.questions.length === 1 && useSimpleQuestionKeyboard(firstQuestion) ? await ctx.bot.sendQuestionWithKeyboard(
      firstQuestion,
      callbackDataForQuestion(shortHash, 0, firstQuestion)
    ) : await ctx.bot.sendMessage(questionPromptText(pending, 0), {
      reply_markup: {
        inline_keyboard: questionInlineKeyboard(shortHash, 0, firstQuestion, [])
      }
    });
    pending.telegramMessageIds = [message.message_id];
    await ctx.pendingQuestions.savePending(shortHash, pending);
    ctx.logger.info("question prompt sent", {
      requestID: request.id,
      sessionID: request.sessionID,
      count: request.questions.length
    });
  } catch (err) {
    ctx.logger.error("failed to send question prompt", {
      error: String(err),
      requestID: request.id
    });
  }
}
function createQuestionDispatcher(ctx) {
  return {
    async handleCallbackQuery(data, messageId, chatId, userId) {
      const match = CALLBACK_RE2.exec(data);
      if (!match) return;
      const shortHash = match[1];
      const questionIndex = Number(match[2]);
      const selection = match[3];
      const pending = await ctx.pendingQuestions.loadPending(shortHash);
      if (!pending) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "This question has expired.");
        return;
      }
      if (pending.expiresAt < Date.now()) {
        await expirePending2(ctx, shortHash, pending, messageId);
        return;
      }
      const question = pending.questions[questionIndex];
      if (!question) return;
      if (selection === "c") {
        if (question.multiple === true) {
          await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), {
            reply_markup: { inline_keyboard: [] }
          });
        } else {
          await ctx.bot.editMessageRemoveKeyboard(
            messageId,
            "\u270F\uFE0F Reply to the next message with your custom answer."
          );
        }
        const prompt = await ctx.bot.replyWithForceReply(
          "Type your custom answer",
          "Type your answer"
        );
        pending.awaitingCustomFor = {
          shortHash,
          questionIndex,
          chatId,
          userId,
          promptMessageId: prompt.message_id
        };
        await ctx.pendingQuestions.savePending(shortHash, pending);
        return;
      }
      if (selection === "d") {
        if (question.multiple !== true) return;
        pending.answersInProgress[questionIndex] = selectedAnswers(pending, questionIndex);
        pending.awaitingCustomFor = void 0;
        await completeIfReady(ctx, pending, shortHash);
        return;
      }
      const option = question.options[Number(selection)];
      if (!option) return;
      if (question.multiple === true) {
        const current = selectedAnswers(pending, questionIndex);
        pending.answersInProgress[questionIndex] = current.includes(option.label) ? current.filter((answer) => answer !== option.label) : [...current, option.label];
        pending.awaitingCustomFor = void 0;
        await ctx.pendingQuestions.savePending(shortHash, pending);
        await editPromptForQuestion(ctx, pending, shortHash, questionIndex);
        return;
      }
      pending.answersInProgress[questionIndex] = [option.label];
      pending.awaitingCustomFor = void 0;
      await completeIfReady(ctx, pending, shortHash);
    },
    async handleTextReply(text, chatId, userId, replyToMessageId) {
      const match = await ctx.pendingQuestions.findAwaitingCustom(chatId, userId);
      if (!match) return;
      const awaiting = match.data.awaitingCustomFor;
      if (!awaiting || awaiting.promptMessageId !== replyToMessageId) return;
      if (match.data.expiresAt < Date.now()) {
        await expirePending2(ctx, match.shortHash, match.data, match.data.telegramMessageIds[0]);
        return;
      }
      const question = match.data.questions[awaiting.questionIndex];
      if (question?.multiple === true) {
        const current = selectedAnswers(match.data, awaiting.questionIndex);
        match.data.answersInProgress[awaiting.questionIndex] = current.includes(text) ? current : [...current, text];
        match.data.awaitingCustomFor = void 0;
        await ctx.bot.sendMessage("\u2705 Custom answer added. Tap Done when finished.");
        await ctx.pendingQuestions.savePending(match.shortHash, match.data);
        await editPromptForQuestion(ctx, match.data, match.shortHash, awaiting.questionIndex);
        return;
      }
      match.data.answersInProgress[awaiting.questionIndex] = [text];
      match.data.awaitingCustomFor = void 0;
      await ctx.bot.sendMessage("\u2705 Custom answer sent.");
      await completeIfReady(ctx, match.data, match.shortHash);
    }
  };
}

// src/events/question-replied.ts
function isEventQuestionReplied(event) {
  if (event.type !== "question.replied") return false;
  const props = event.properties;
  return Boolean(props && typeof props.requestID === "string" && typeof props.sessionID === "string");
}
async function handleQuestionReplied(event, ctx) {
  const found = await ctx.pendingQuestions.findByRequestID(event.properties.requestID);
  if (!found) return;
  const messageId = found.data.telegramMessageIds[0];
  try {
    await ctx.bot.editMessageRemoveKeyboard(messageId, "\u2705 Already answered in opencode.");
  } catch (err) {
    ctx.logger.error("failed to edit externally answered question", { error: String(err), requestID: event.properties.requestID });
  } finally {
    await ctx.pendingQuestions.deletePending(found.shortHash);
  }
}

// src/lib/session-registry.ts
import { chmod, mkdir as mkdir4, readFile as readFile3, readdir as readdir4, rename as rename3, unlink as unlink4, writeFile as writeFile3 } from "fs/promises";
import { join as join4 } from "path";

// src/lib/opencode-http.ts
var ALLOWED_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
function asRecord(value) {
  if (!value || typeof value !== "object") return void 0;
  return value;
}
function isStatusType(value) {
  return value === "idle" || value === "busy" || value === "retry";
}
function normalizeOpenCodeServerUrl(value) {
  if (!value) return void 0;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
    if (url.username || url.password) return void 0;
    if (url.search || url.hash) return void 0;
    if (url.pathname !== "/" && url.pathname !== "") return void 0;
    if (!ALLOWED_HOSTNAMES.has(url.hostname)) return void 0;
    return url.href;
  } catch {
    return void 0;
  }
}
function requireOpenCodeServerUrl(serverUrl) {
  const normalized = normalizeOpenCodeServerUrl(serverUrl);
  if (!normalized) throw new Error("Invalid OpenCode server URL");
  return normalized;
}
function endpoint(serverUrl, path) {
  return new URL(path, requireOpenCodeServerUrl(serverUrl));
}
function isDifferentServerUrl(sourceServerUrl, currentServerUrl) {
  const source = normalizeOpenCodeServerUrl(sourceServerUrl);
  const current = normalizeOpenCodeServerUrl(currentServerUrl);
  if (!source || !current) return false;
  return source !== current;
}
function normalizeSession(value) {
  const record = asRecord(value);
  if (!record || typeof record.directory !== "string") return void 0;
  const session = { directory: record.directory };
  if (typeof record.id === "string") session.id = record.id;
  if (typeof record.title === "string") session.title = record.title;
  if (typeof record.parentID === "string" || record.parentID === null) {
    session.parentID = record.parentID;
  }
  if (typeof record.agent === "string") session.agent = record.agent;
  return session;
}
function normalizeSessionList(value) {
  if (!Array.isArray(value)) return [];
  const sessions = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const time = asRecord(record?.time);
    if (!record) continue;
    if (typeof record.id !== "string") continue;
    if (typeof record.title !== "string") continue;
    if (!time || typeof time.updated !== "number") continue;
    const session = {
      id: record.id,
      title: record.title,
      time: { updated: time.updated }
    };
    if (typeof record.parentID === "string" || record.parentID === null) {
      session.parentID = record.parentID;
    }
    if (typeof record.agent === "string") session.agent = record.agent;
    sessions.push(session);
  }
  return sessions;
}
function normalizeStatusMap(value) {
  const record = asRecord(value);
  if (!record) return {};
  const out = {};
  for (const [sessionId, rawStatus] of Object.entries(record)) {
    const status = asRecord(rawStatus);
    if (status && isStatusType(status.type)) out[sessionId] = { type: status.type };
  }
  return out;
}
function normalizeMessages(value) {
  if (!Array.isArray(value)) return [];
  const messages = [];
  for (const rawMessage of value) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    if (!message || !info || typeof info.role !== "string" || !Array.isArray(message.parts)) continue;
    const parts = [];
    for (const rawPart of message.parts) {
      const part = asRecord(rawPart);
      if (!part || typeof part.type !== "string") continue;
      const normalized = { type: part.type };
      if (typeof part.text === "string") normalized.text = part.text;
      parts.push(normalized);
    }
    messages.push({ info: { role: info.role }, parts });
  }
  return messages;
}
async function fetchJson(serverUrl, path, fetcher) {
  const response = await fetcher(endpoint(serverUrl, path), { redirect: "error" });
  if (response.status === 404) return { data: void 0, response: { status: response.status } };
  if (!response.ok) {
    throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
  }
  return { data: await response.json(), response: { status: response.status } };
}
async function getRemoteSession(serverUrl, sessionId, fetcher = fetch) {
  const result = await fetchJson(serverUrl, `/session/${encodeURIComponent(sessionId)}`, fetcher);
  return { data: normalizeSession(result.data), response: result.response };
}
async function getRemoteStatusMap(serverUrl, fetcher = fetch) {
  const result = await fetchJson(serverUrl, "/session/status", fetcher);
  return normalizeStatusMap(result.data);
}
async function getRemoteSessions(serverUrl, fetcher = fetch) {
  const result = await fetchJson(serverUrl, "/session", fetcher);
  return normalizeSessionList(result.data);
}
async function getRemoteMessages(serverUrl, sessionId, limit, fetcher = fetch) {
  const url = endpoint(serverUrl, `/session/${encodeURIComponent(sessionId)}/message`);
  url.searchParams.set("limit", String(limit));
  const response = await fetcher(url, { redirect: "error" });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
  }
  return normalizeMessages(await response.json());
}

// src/lib/session-registry.ts
function filenameForSession(sessionId) {
  return Buffer.from(sessionId).toString("base64url") + ".json";
}
function hasCode4(err, code) {
  return err instanceof Error && "code" in err && err.code === code;
}
function normalizeEntry(entry) {
  const serverUrl = normalizeOpenCodeServerUrl(entry.serverUrl);
  if (!serverUrl) throw new Error("invalid registry serverUrl");
  const out = {
    sessionId: entry.sessionId,
    title: entry.title,
    parentID: entry.parentID,
    serverUrl,
    updatedAt: entry.updatedAt
  };
  if (entry.agent !== void 0) out.agent = entry.agent;
  if (entry.status !== void 0) out.status = entry.status;
  return out;
}
function isRegistryFile(value) {
  if (!value || typeof value !== "object") return false;
  const file = value;
  if (file.version !== 1) return false;
  const entry = file.entry;
  if (!entry || typeof entry !== "object") return false;
  const e = entry;
  if (typeof e.sessionId !== "string") return false;
  if (typeof e.title !== "string") return false;
  if (e.parentID !== null && typeof e.parentID !== "string") return false;
  if (e.agent !== void 0 && typeof e.agent !== "string") return false;
  if (e.status !== void 0 && e.status !== "idle" && e.status !== "busy" && e.status !== "retry") {
    return false;
  }
  if (typeof e.serverUrl !== "string") return false;
  if (!normalizeOpenCodeServerUrl(e.serverUrl)) return false;
  if (typeof e.updatedAt !== "number") return false;
  return true;
}
function agentFromSession(session) {
  const candidate = session;
  return typeof candidate.agent === "string" ? candidate.agent : void 0;
}
function registryEntryFromSession(session, serverUrl, status) {
  const entry = {
    sessionId: session.id,
    title: session.title,
    parentID: session.parentID ?? null,
    serverUrl,
    updatedAt: session.time.updated
  };
  const agent = agentFromSession(session);
  if (agent !== void 0) entry.agent = agent;
  if (status !== void 0) entry.status = status;
  return entry;
}
function createSessionRegistryStore(opts) {
  const registryDir = join4(opts.configDir, "session-registry", opts.tokenHash);
  function filePath(sessionId) {
    return join4(registryDir, filenameForSession(sessionId));
  }
  async function readEntry(sessionId) {
    let text;
    try {
      text = await readFile3(filePath(sessionId), "utf8");
    } catch (err) {
      if (hasCode4(err, "ENOENT")) return null;
      opts.logger.error("session-registry: failed to read file", {
        sessionId,
        error: String(err)
      });
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (!isRegistryFile(parsed)) return null;
      return normalizeEntry(parsed.entry);
    } catch (err) {
      opts.logger.error("session-registry: corrupted JSON", { sessionId, error: String(err) });
      return null;
    }
  }
  async function writeEntry(entry) {
    await mkdir4(registryDir, { recursive: true });
    try {
      await chmod(registryDir, 448);
    } catch (err) {
      opts.logger.error("session-registry: failed to chmod dir", { error: String(err) });
    }
    const payload = { version: 1, entry: normalizeEntry(entry) };
    const target = filePath(entry.sessionId);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    await writeFile3(tmp, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename3(tmp, target);
    } catch (err) {
      try {
        await unlink4(tmp);
      } catch {
      }
      throw err;
    }
    await chmod(target, 384);
  }
  async function upsertSession(entry) {
    const existing = await readEntry(entry.sessionId);
    await writeEntry({
      ...existing,
      ...entry,
      agent: entry.agent ?? existing?.agent,
      status: entry.status ?? existing?.status
    });
  }
  async function updateSession(sessionId, patch) {
    const existing = await readEntry(sessionId);
    if (!existing) return;
    await writeEntry({
      ...existing,
      ...patch,
      sessionId,
      title: patch.title ?? existing.title,
      parentID: patch.parentID ?? existing.parentID,
      serverUrl: patch.serverUrl ?? existing.serverUrl,
      updatedAt: patch.updatedAt ?? Date.now()
    });
  }
  async function listSessions() {
    let names;
    try {
      names = await readdir4(registryDir);
    } catch (err) {
      if (hasCode4(err, "ENOENT")) return [];
      opts.logger.error("session-registry: failed to list dir", { error: String(err) });
      return [];
    }
    const entries = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let text;
      try {
        text = await readFile3(join4(registryDir, name), "utf8");
      } catch (err) {
        opts.logger.error("session-registry: failed to read listed file", {
          file: name,
          error: String(err)
        });
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        if (isRegistryFile(parsed)) entries.push(normalizeEntry(parsed.entry));
      } catch (err) {
        opts.logger.error("session-registry: corrupted listed file", {
          file: name,
          error: String(err)
        });
      }
    }
    return entries;
  }
  return { upsertSession, updateSession, listSessions };
}

// src/events/session-created.ts
async function handleSessionCreated(event, ctx) {
  const info = event.properties.info;
  ctx.sessionTitleService.setSessionInfo(info);
  await ctx.sessionRegistry.upsertSession(
    registryEntryFromSession(info, ctx.serverUrl.href, ctx.sessionTitleService.getSessionStatus(info.id))
  );
}

// src/lib/abort-tracker.ts
var ABORT_TTL_MS = 5e3;
var sessionAborts = /* @__PURE__ */ new Map();
var lastGlobalAbortAt = 0;
function noteAbort(sessionID) {
  const now = Date.now();
  if (sessionID) {
    sessionAborts.set(sessionID, now);
    return;
  }
  lastGlobalAbortAt = now;
}
function shouldSuppressIdle(sessionID) {
  const now = Date.now();
  const sessionAbortAt = sessionAborts.get(sessionID) ?? 0;
  const abortAt = Math.max(sessionAbortAt, lastGlobalAbortAt);
  if (abortAt === 0) return false;
  if (now - abortAt <= ABORT_TTL_MS) {
    sessionAborts.delete(sessionID);
    if (abortAt === lastGlobalAbortAt) lastGlobalAbortAt = 0;
    return true;
  }
  sessionAborts.delete(sessionID);
  if (now - lastGlobalAbortAt > ABORT_TTL_MS) lastGlobalAbortAt = 0;
  return false;
}

// src/events/session-error.ts
function isEventSessionError(event) {
  return event.type === "session.error";
}
async function handleSessionError(event, ctx) {
  if (event.properties.error?.name !== "MessageAbortedError") return;
  noteAbort(event.properties.sessionID);
  ctx.logger.info("session abort recorded", { sessionId: event.properties.sessionID ?? "global" });
}

// src/lib/pending-start-work.ts
import { createHash as createHash4 } from "crypto";
import { mkdir as mkdir5, readdir as readdir5, readFile as readFile4, rename as rename4, unlink as unlink5, writeFile as writeFile4 } from "fs/promises";
import { tmpdir as tmpdir3 } from "os";
import { dirname as dirname3, join as join5 } from "path";
function hasCode5(err, code) {
  return "code" in err && err.code === code;
}
function pendingFilePath3(dir, shortHash) {
  return join5(dir, `${shortHash}.json`);
}
function parsePending3(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.sessionID !== "string")
    throw new Error("Invalid pending start-work: sessionID");
  if (parsed.serverUrl !== void 0 && typeof parsed.serverUrl !== "string")
    throw new Error("Invalid pending start-work: serverUrl");
  if (parsed.title !== void 0 && typeof parsed.title !== "string")
    throw new Error("Invalid pending start-work: title");
  if (typeof parsed.sentAt !== "number") throw new Error("Invalid pending start-work: sentAt");
  if (typeof parsed.expiresAt !== "number")
    throw new Error("Invalid pending start-work: expiresAt");
  if (typeof parsed.telegramMessageId !== "number")
    throw new Error("Invalid pending start-work: telegramMessageId");
  return parsed;
}
async function listPendingFiles3(dir) {
  try {
    const entries = await readdir5(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode5(err, "ENOENT")) return [];
    throw err;
  }
}
function shortHashFromFileName3(fileName) {
  return fileName.slice(0, -".json".length);
}
function createPendingStartWorkStore(opts) {
  const dir = opts.baseDir ?? join5(tmpdir3(), `opencoder-telegram-pending-start-work-${opts.tokenHash}`);
  return {
    dir,
    async savePending(shortHash, data) {
      const filePath = pendingFilePath3(dir, shortHash);
      await mkdir5(dirname3(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile4(tmpPath, JSON.stringify(data, null, 2), "utf8");
      await rename4(tmpPath, filePath);
    },
    async loadPending(shortHash) {
      try {
        return parsePending3(await readFile4(pendingFilePath3(dir, shortHash), "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode5(err, "ENOENT")) return void 0;
        throw err;
      }
    },
    async deletePending(shortHash) {
      try {
        await unlink5(pendingFilePath3(dir, shortHash));
      } catch (err) {
        if (!(err instanceof Error) || !hasCode5(err, "ENOENT")) throw err;
      }
    },
    async sweepExpired() {
      const expired = [];
      for (const fileName of await listPendingFiles3(dir)) {
        const shortHash = shortHashFromFileName3(fileName);
        const data = await this.loadPending(shortHash);
        if (data && data.expiresAt < Date.now()) {
          expired.push(data);
          await this.deletePending(shortHash);
        }
      }
      return expired;
    }
  };
}
function createStartWorkShortHash(sessionID) {
  return createHash4("sha256").update(sessionID).digest("base64url").slice(0, 10);
}

// src/events/start-work.ts
var CALLBACK_RE3 = /^sw:([^:]+)$/;
var START_WORK_COMMAND = "start-work";
var START_WORK_EXPIRY_MS = 24 * 60 * 6e4;
function startWorkKeyboard(shortHash) {
  const callbackData = `sw:${shortHash}`;
  if (Buffer.byteLength(callbackData, "utf8") > 64)
    throw new Error("Telegram callback_data exceeds 64 bytes");
  return [[{ text: "\u25B6\uFE0F Run /start-work", callback_data: callbackData }]];
}
function planCompleteMessage(title) {
  return title ? `plan \uC791\uC131\uC774 \uB05D\uB0AC\uC5B4\uC694.

${title}` : "plan \uC791\uC131\uC774 \uB05D\uB0AC\uC5B4\uC694.";
}
function createPendingStartWork(sessionID, title, serverUrl, telegramMessageId) {
  const sentAt = Date.now();
  return {
    sessionID,
    serverUrl,
    title: title ?? void 0,
    sentAt,
    expiresAt: sentAt + START_WORK_EXPIRY_MS,
    telegramMessageId
  };
}
function startWorkShortHash(sessionID) {
  return createStartWorkShortHash(sessionID);
}
async function expirePending3(ctx, shortHash, pending, messageId) {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "\u23F1 /start-work request expired");
  await ctx.pendingStartWorks.deletePending(shortHash);
  ctx.logger.info("pending start-work expired", { sessionID: pending.sessionID });
}
function createStartWorkDispatcher(ctx) {
  return {
    async handleCallbackQuery(data, messageId) {
      const match = CALLBACK_RE3.exec(data);
      if (!match) return;
      const shortHash = match[1];
      const pending = await ctx.pendingStartWorks.loadPending(shortHash);
      if (!pending) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "This /start-work request has expired.");
        return;
      }
      if (pending.expiresAt < Date.now()) {
        await expirePending3(ctx, shortHash, pending, messageId);
        return;
      }
      try {
        await ctx.runSessionCommand(pending.sessionID, START_WORK_COMMAND, pending.serverUrl);
        const label = pending.title ?? pending.sessionID;
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `\u25B6\uFE0F Sent /start-work to opencode.

Session: ${label}`
        );
        ctx.logger.info("start-work command sent", { sessionID: pending.sessionID });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          "\u26A0\uFE0F Failed to send /start-work to opencode"
        );
        ctx.logger.error("failed to send start-work command", {
          sessionID: pending.sessionID,
          error: String(err)
        });
      } finally {
        await ctx.pendingStartWorks.deletePending(shortHash);
      }
    }
  };
}

// src/events/session-idle.ts
var ROOT_IDLE_RECHECK_DELAY_MS = 2500;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function resolveParentID(sessionId, ctx) {
  const cachedParentID = ctx.sessionTitleService.getParentID(sessionId);
  if (cachedParentID !== void 0) return cachedParentID;
  try {
    const result = await ctx.client.session.get({ path: { id: sessionId } });
    if (result.data) {
      ctx.sessionTitleService.setSessionInfo(result.data);
      await ctx.sessionRegistry.upsertSession(
        registryEntryFromSession(
          result.data,
          ctx.serverUrl.href,
          ctx.sessionTitleService.getSessionStatus(sessionId)
        )
      );
      return ctx.sessionTitleService.getParentID(sessionId);
    }
    ctx.logger.warn("session parentID cache miss fetch returned no data", { sessionId });
    return void 0;
  } catch (err) {
    ctx.logger.warn("session parentID cache miss fetch failed", { sessionId, error: String(err) });
    return void 0;
  }
}
async function hydrateDescendants(sessionId, ctx, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(sessionId)) return;
  seen.add(sessionId);
  try {
    const result = await ctx.client.session.children({ path: { id: sessionId } });
    for (const child of result.data ?? []) {
      ctx.sessionTitleService.setSessionInfo(child);
      await ctx.sessionRegistry.upsertSession(
        registryEntryFromSession(child, ctx.serverUrl.href, ctx.sessionTitleService.getSessionStatus(child.id))
      );
      await hydrateDescendants(child.id, ctx, seen);
    }
  } catch (err) {
    ctx.logger.warn("session children fetch failed", { sessionId, error: String(err) });
  }
}
async function sendIdleNotification(sessionId, ctx) {
  if (shouldSuppressIdle(sessionId)) {
    ctx.logger.info("idle suppressed - session was aborted", { sessionId });
    return;
  }
  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `session.idle:${sessionId}`,
    ttlMs: 5e3
  });
  if (!claimed) return;
  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const isPlanSession = ctx.sessionTitleService.getSessionAgent(sessionId) === "plan";
  const text = isPlanSession ? planCompleteMessage(title) : title ? `Agent has finished: ${title}` : "Agent has finished.";
  try {
    if (isPlanSession) {
      const shortHash = startWorkShortHash(sessionId);
      const message = await ctx.bot.sendMessage(text, {
        reply_markup: { inline_keyboard: startWorkKeyboard(shortHash) }
      });
      await ctx.pendingStartWorks.savePending(
        shortHash,
        createPendingStartWork(sessionId, title, ctx.serverUrl.href, message.message_id)
      );
    } else {
      await ctx.bot.sendMessage(text);
    }
    ctx.sessionTitleService.clearDeferredIdleNotification(sessionId);
    ctx.logger.info("idle notification sent", { sessionId, title });
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}
async function flushDeferredParentIfReady(parentID, ctx) {
  if (!ctx.sessionTitleService.hasDeferredIdleNotification(parentID)) return;
  if (ctx.sessionTitleService.hasUnfinishedDescendants(parentID)) return;
  const parentStatus = ctx.sessionTitleService.getSessionStatus(parentID);
  if (parentStatus === "idle") {
    ctx.logger.info("keeping deferred parent idle notification - waiting for parent to resume", {
      sessionId: parentID
    });
    return;
  }
  if (parentStatus !== void 0) {
    ctx.sessionTitleService.clearDeferredIdleNotification(parentID);
    ctx.logger.info("clearing deferred parent idle notification - parent resumed", {
      sessionId: parentID
    });
  }
}
async function deferParentIdleIfDescendantsRunning(sessionId, ctx) {
  await hydrateDescendants(sessionId, ctx);
  if (!ctx.sessionTitleService.hasUnfinishedDescendants(sessionId)) return false;
  ctx.sessionTitleService.deferIdleNotification(sessionId);
  ctx.logger.info("deferring parent idle notification - child sessions still running", {
    sessionId
  });
  return true;
}
async function handleSessionIdle(event, ctx) {
  const sessionId = event.properties.sessionID;
  const parentID = await resolveParentID(sessionId, ctx);
  ctx.sessionTitleService.setSessionStatus(sessionId, "idle");
  await ctx.sessionRegistry.updateSession(sessionId, { status: "idle", updatedAt: Date.now() });
  if (typeof parentID === "string") {
    ctx.logger.info("suppressing child session idle notification", { sessionId, parentID });
    await flushDeferredParentIfReady(parentID, ctx);
    return;
  }
  if (parentID === void 0) {
    ctx.logger.warn("session parentID unknown; sending idle notification", { sessionId });
  }
  if (await deferParentIdleIfDescendantsRunning(sessionId, ctx)) {
    return;
  }
  await sleep(ctx.idleRecheckDelayMs ?? ROOT_IDLE_RECHECK_DELAY_MS);
  if (ctx.sessionTitleService.getSessionStatus(sessionId) !== "idle") {
    ctx.logger.info("idle notification skipped - session resumed during recheck delay", {
      sessionId
    });
    return;
  }
  if (await deferParentIdleIfDescendantsRunning(sessionId, ctx)) {
    return;
  }
  await sendIdleNotification(sessionId, ctx);
}
async function handleSessionStatus(event, ctx) {
  const sessionId = event.properties.sessionID;
  const statusType = event.properties.status.type;
  ctx.sessionTitleService.setSessionStatus(sessionId, statusType);
  await ctx.sessionRegistry.updateSession(sessionId, { status: statusType, updatedAt: Date.now() });
  if (statusType === "idle") {
    await handleSessionIdle(event, ctx);
  }
}

// src/events/session-updated.ts
async function handleSessionUpdated(event, ctx) {
  const info = event.properties.info;
  ctx.sessionTitleService.setSessionInfo(info);
  await ctx.sessionRegistry.upsertSession(
    registryEntryFromSession(info, ctx.serverUrl.href, ctx.sessionTitleService.getSessionStatus(info.id))
  );
}

// src/lib/html-escape.ts
function escapeHtml(input) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function truncateForTelegram(input, maxChars, ellipsis = "\u2026") {
  const single = input.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  if (maxChars <= 0) return "";
  if (ellipsis.length >= maxChars) return ellipsis.slice(0, maxChars);
  return single.slice(0, maxChars - ellipsis.length) + ellipsis;
}
function stripCodeFences(input) {
  return input.replace(/```[^\r\n`]*\r?\n([\s\S]*?)```/g, "$1").replace(/```([\s\S]*?)```/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/\s+/g, " ").trim();
}

// src/events/sessions-command.ts
var MAX_BODY_CHARS = 3900;
var MAX_TITLE_CHARS = 55;
var MAX_SESSIONS = 20;
function agentFromSession2(session) {
  const candidate = session;
  return typeof candidate.agent === "string" ? candidate.agent : void 0;
}
function isRootSession(session) {
  return session.parentID === void 0 || session.parentID === null;
}
function isRootRegistryEntry(entry) {
  return entry.parentID === null;
}
function isRootRemoteSession(session) {
  return session.parentID === void 0 || session.parentID === null;
}
function addRegistryRecord(combined, entry, status) {
  combined.set(entry.sessionId, {
    sessionId: entry.sessionId,
    title: entry.title,
    agent: entry.agent,
    status: status ?? entry.status ?? "idle",
    serverUrl: entry.serverUrl,
    updatedAt: entry.updatedAt
  });
}
async function addRemoteServerRecords(combined, serverUrl, deps) {
  const [remoteSessions, remoteStatusMap] = await Promise.all([
    getRemoteSessions(serverUrl, deps.opencodeFetch),
    getRemoteStatusMap(serverUrl, deps.opencodeFetch)
  ]);
  for (const session of remoteSessions.filter(isRootRemoteSession)) {
    const status = remoteStatusMap[session.id]?.type ?? "idle";
    combined.set(session.id, {
      sessionId: session.id,
      title: session.title,
      agent: session.agent,
      status,
      serverUrl,
      updatedAt: session.time.updated
    });
    await deps.sessionRegistry.upsertSession({
      sessionId: session.id,
      title: session.title,
      parentID: session.parentID ?? null,
      agent: session.agent,
      status,
      serverUrl,
      updatedAt: session.time.updated
    });
  }
}
function createSessionsDispatcher(deps) {
  return async ({ chatId, bot }) => {
    let sessions;
    try {
      const [listResult, statusResult] = await Promise.all([
        deps.client.session.list(),
        deps.client.session.status()
      ]);
      const statusMap = statusResult.data ?? {};
      for (const session of listResult.data ?? []) {
        deps.sessionTitleService.setSessionInfo(session);
        deps.sessionTitleService.setServerUrl(session.id, deps.serverUrl);
        const status = statusMap[session.id]?.type ?? "idle";
        await deps.sessionRegistry.upsertSession(
          registryEntryFromSession(session, deps.serverUrl, status)
        );
        if (status !== void 0) deps.sessionTitleService.setSessionStatus(session.id, status);
      }
      const registrySessions = await deps.sessionRegistry.listSessions();
      const combined = /* @__PURE__ */ new Map();
      const remoteServerUrls = /* @__PURE__ */ new Set();
      for (const entry of registrySessions.filter(isRootRegistryEntry)) {
        const serverUrl = normalizeOpenCodeServerUrl(entry.serverUrl);
        if (!serverUrl) continue;
        if (isDifferentServerUrl(serverUrl, deps.serverUrl)) {
          remoteServerUrls.add(serverUrl);
          continue;
        }
        addRegistryRecord(combined, { ...entry, serverUrl }, statusMap[entry.sessionId]?.type);
      }
      for (const serverUrl of remoteServerUrls) {
        try {
          await addRemoteServerRecords(combined, serverUrl, deps);
        } catch (err) {
          deps.logger.error("sessions remote server refresh failed", { serverUrl, error: String(err) });
        }
      }
      for (const session of (listResult.data ?? []).filter(isRootSession)) {
        combined.set(session.id, {
          sessionId: session.id,
          title: session.title,
          agent: agentFromSession2(session),
          status: statusMap[session.id]?.type ?? "idle",
          serverUrl: deps.serverUrl,
          updatedAt: session.time.updated
        });
      }
      sessions = [...combined.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
    } catch (err) {
      await bot.sendMessage("\uC138\uC158 \uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", { parse_mode: "HTML" });
      deps.logger.error("sessions list failed", { chatId, error: String(err) });
      return;
    }
    if (sessions.length === 0) {
      await bot.sendMessage("\uC138\uC158\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", { parse_mode: "HTML" });
      return;
    }
    const capturedAt = Date.now();
    const entries = sessions.map((session, i) => {
      const entry = {
        index: i + 1,
        sessionId: session.sessionId,
        title: session.title,
        capturedAt
      };
      if (session.agent !== void 0) entry.agent = session.agent;
      entry.status = session.status;
      if (session.serverUrl !== void 0) entry.serverUrl = session.serverUrl;
      return entry;
    });
    await deps.snapshotStore.saveSnapshot(chatId, entries);
    const lines = entries.map((entry) => {
      const agent = entry.agent ? escapeHtml(entry.agent) : "?";
      const title = truncateForTelegram(escapeHtml(entry.title), MAX_TITLE_CHARS);
      const status = ` \u2014 ${escapeHtml(entry.status ?? "idle")}`;
      return `${entry.index}. [${agent}] ${title}${status}`;
    });
    let body = lines.join("\n");
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "\u2026";
    }
    const text = `<b>\uCD5C\uADFC \uC138\uC158 (top ${entries.length})</b>
${body}

<i>/status N \uB610\uB294 /start_work N \uC73C\uB85C \uC870\uC791</i>`;
    await bot.sendMessage(text, { parse_mode: "HTML" });
    deps.logger.info("sessions listed", { chatId, count: entries.length });
  };
}

// src/lib/plan-readiness.ts
import { access, readFile as readFile5, readdir as readdir6, stat as stat2 } from "fs/promises";
import { join as join6 } from "path";
async function checkPlanReadiness(args) {
  const { projectRoot } = args;
  const omoDir = join6(projectRoot, ".omo");
  const plansDir = join6(omoDir, "plans");
  const boulderPath = join6(omoDir, "boulder.json");
  try {
    await access(omoDir);
  } catch {
    return {
      ready: false,
      reason: "no-omo-dir",
      detail: `${omoDir} does not exist`
    };
  }
  try {
    await access(boulderPath);
    return {
      ready: false,
      reason: "boulder-active",
      detail: `${boulderPath} exists`
    };
  } catch {
  }
  let planFiles = [];
  try {
    const entries = await readdir6(plansDir);
    planFiles = entries.filter((e) => e.endsWith(".md"));
  } catch {
    return {
      ready: false,
      reason: "no-plans",
      detail: `${plansDir} not found or empty`
    };
  }
  if (planFiles.length === 0) {
    return {
      ready: false,
      reason: "no-plans",
      detail: `No .md files in ${plansDir}`
    };
  }
  const stats = await Promise.all(
    planFiles.map(async (f) => {
      const full = join6(plansDir, f);
      const s = await stat2(full);
      return { path: full, name: f, mtime: s.mtime.getTime() };
    })
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  const latest = stats[0];
  const content = await readFile5(latest.path, "utf8");
  const totalMatches = content.match(/^- \[[ xX]\]/gm) ?? [];
  const completedMatches = content.match(/^- \[[xX]\]/gm) ?? [];
  const total = totalMatches.length;
  const completed = completedMatches.length;
  if (total === 0) {
    return {
      ready: false,
      reason: "plan-empty",
      detail: `${latest.name}: no checkboxes found`
    };
  }
  if (completed >= total) {
    return {
      ready: false,
      reason: "all-plans-complete",
      detail: `${latest.name}: ${completed}/${total} complete`
    };
  }
  return {
    ready: true,
    planPath: latest.path,
    planName: latest.name.replace(/\.md$/, ""),
    total,
    completed
  };
}
async function recheckSessionIdle(client, sessionId) {
  const result = await client.session.status();
  const statuses = result.data ?? {};
  const sessionStatus = statuses[sessionId];
  return (sessionStatus?.type ?? "idle") === "idle";
}

// src/events/status-command.ts
var SNIPPET_MAX_CHARS = 80;
var MESSAGES_LIMIT = 10;
var EMPTY_MESSAGE = "\uBA54\uC2DC\uC9C0 \uC5C6\uC74C";
function resolveProjectRoot(session) {
  if (!session.directory) throw new Error("session directory missing");
  return session.directory;
}
function extractTextFromParts(parts) {
  const pieces = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      pieces.push(part.text);
    }
  }
  return pieces.join(" ");
}
function buildSnippet(envelope) {
  if (!envelope) return EMPTY_MESSAGE;
  try {
    const raw = extractTextFromParts(envelope.parts);
    const cleaned = stripCodeFences(raw);
    const truncated = truncateForTelegram(cleaned, SNIPPET_MAX_CHARS);
    if (!truncated) return EMPTY_MESSAGE;
    return escapeHtml(truncated);
  } catch {
    return EMPTY_MESSAGE;
  }
}
function findLastByRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.info.role === role) return msg;
  }
  return void 0;
}
function planReadinessKorean(result) {
  if (result.ready) {
    return `${result.completed}/${result.total} (${result.planName})`;
  }
  switch (result.reason) {
    case "no-omo-dir":
      return "`.omo/` \uC5C6\uC74C";
    case "no-plans":
      return "plan \uD30C\uC77C \uC5C6\uC74C";
    case "plan-empty":
      return "\uCCB4\uD06C\uBC15\uC2A4 \uC5C6\uC74C";
    case "all-plans-complete": {
      const match = result.detail.match(/(\d+)\/(\d+)/);
      if (match) return `${match[1]}/${match[2]} \uC644\uB8CC`;
      return "\uC644\uB8CC";
    }
    case "boulder-active":
      return "boulder \uD65C\uC131";
  }
}
function planLine(result) {
  if (result.ready) {
    return `<b>\uD50C\uB79C \uC9C4\uD589\uB3C4</b>: ${result.completed}/${result.total} (${escapeHtml(result.planName)})`;
  }
  return `<b>\uD50C\uB79C \uC0C1\uD0DC</b>: ${planReadinessKorean(result)}`;
}
function boulderLine(result) {
  const active = !result.ready && result.reason === "boulder-active";
  return active ? "<b>Boulder</b>: \uD65C\uC131" : "<b>Boulder</b>: \uC5C6\uC74C";
}
function createStatusDispatcher(deps) {
  return async ({ chatId, bot, args }) => {
    const rawN = args[0];
    if (rawN === void 0 || rawN === "") {
      await bot.sendMessage("\uC0AC\uC6A9\uBC95: /status <\uBC88\uD638>. \uBA3C\uC800 /sessions \uB85C \uBAA9\uB85D \uD655\uC778", {
        parse_mode: "HTML"
      });
      return;
    }
    const n = Number(rawN);
    if (Number.isNaN(n)) {
      await bot.sendMessage(`\uC798\uBABB\uB41C \uC785\uB825: ${escapeHtml(rawN)}\uC740 \uC22B\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4`, {
        parse_mode: "HTML"
      });
      return;
    }
    const snapshot = await deps.snapshotStore.loadSnapshot(chatId);
    if (!snapshot) {
      await bot.sendMessage("\uC138\uC158 \uBAA9\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 /sessions \uB97C \uC2E4\uD589\uD558\uC138\uC694.", {
        parse_mode: "HTML"
      });
      return;
    }
    const entry = snapshot.find((e) => e.index === n);
    if (!entry) {
      await bot.sendMessage(`${n}\uBC88 \uC138\uC158 \uC5C6\uC74C. \uD604\uC7AC \uBAA9\uB85D \uD06C\uAE30: ${snapshot.length}`, {
        parse_mode: "HTML"
      });
      return;
    }
    const rawSourceServerUrl = entry.serverUrl ?? deps.sessionTitleService.getServerUrl(entry.sessionId);
    const sourceServerUrl = normalizeOpenCodeServerUrl(rawSourceServerUrl);
    if (rawSourceServerUrl && !sourceServerUrl) {
      await bot.sendMessage("\uC138\uC158 \uC11C\uBC84 \uC815\uBCF4\uAC00 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694", {
        parse_mode: "HTML"
      });
      deps.logger.error("status invalid server url", { chatId, sessionId: entry.sessionId });
      return;
    }
    const useRemoteServer = isDifferentServerUrl(sourceServerUrl, deps.serverUrl);
    let session;
    let responseStatus;
    let sessionStatus = "idle";
    let messages = [];
    if (sourceServerUrl && useRemoteServer) {
      try {
        const getResult = await getRemoteSession(sourceServerUrl, entry.sessionId, deps.opencodeFetch);
        session = getResult.data;
        responseStatus = getResult.response.status;
        if (!session || responseStatus === 404) {
          await bot.sendMessage("\uC138\uC158\uC774 \uB354 \uC774\uC0C1 \uC874\uC7AC\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694", {
            parse_mode: "HTML"
          });
          return;
        }
        const [statusMap, remoteMessages] = await Promise.all([
          getRemoteStatusMap(sourceServerUrl, deps.opencodeFetch),
          getRemoteMessages(sourceServerUrl, entry.sessionId, MESSAGES_LIMIT, deps.opencodeFetch)
        ]);
        sessionStatus = statusMap[entry.sessionId]?.type ?? "idle";
        messages = remoteMessages;
      } catch (err) {
        await bot.sendMessage("\uC138\uC158 \uC0C1\uD0DC\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694", {
          parse_mode: "HTML"
        });
        deps.logger.error("status remote lookup failed", { chatId, sessionId: entry.sessionId, error: String(err) });
        return;
      }
    } else {
      const [getResult, statusResult, messagesResult] = await Promise.all([
        deps.client.session.get({ path: { id: entry.sessionId } }),
        deps.client.session.status(),
        deps.client.session.messages({
          path: { id: entry.sessionId },
          query: { limit: MESSAGES_LIMIT }
        })
      ]);
      session = normalizeSession(getResult.data);
      responseStatus = getResult.response?.status;
      const statusMap = normalizeStatusMap(statusResult.data);
      sessionStatus = statusMap[entry.sessionId]?.type ?? "idle";
      messages = normalizeMessages(messagesResult.data);
    }
    if (!session || responseStatus === 404) {
      await bot.sendMessage("\uC138\uC158\uC774 \uB354 \uC774\uC0C1 \uC874\uC7AC\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694", {
        parse_mode: "HTML"
      });
      return;
    }
    const projectRoot = resolveProjectRoot(session);
    const planReady = await checkPlanReadiness({ projectRoot });
    const userSnippet = buildSnippet(findLastByRole(messages, "user"));
    const assistantSnippet = buildSnippet(findLastByRole(messages, "assistant"));
    const title = escapeHtml(session.title ?? "");
    const agent = entry.agent ? escapeHtml(entry.agent) : "?";
    const text = [
      `<b>\uC138\uC158 #${n}</b>: ${title}`,
      `\uC5D0\uC774\uC804\uD2B8: ${agent}`,
      `\uC0C1\uD0DC: ${escapeHtml(sessionStatus)}`,
      ``,
      `<b>\uB9C8\uC9C0\uB9C9 \uBA54\uC2DC\uC9C0</b>`,
      `\uC720\uC800: ${userSnippet}`,
      `\uC5D0\uC774\uC804\uD2B8: ${assistantSnippet}`,
      ``,
      planLine(planReady),
      ``,
      boulderLine(planReady)
    ].join("\n");
    await bot.sendMessage(text, { parse_mode: "HTML" });
    deps.logger.info("status shown", {
      chatId,
      sessionId: entry.sessionId,
      snapshotIndex: n
    });
  };
}

// src/events/start-work-command.ts
function agentFromSession3(session) {
  return session.agent;
}
function resolveProjectRoot2(session) {
  return session.directory;
}
function readinessMessage(reason) {
  switch (reason) {
    case "no-omo-dir":
      return ".omo/ \uB514\uB809\uD1A0\uB9AC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. plan \uC791\uC131\uC774 \uC120\uD589\uB418\uC5B4\uC57C \uD569\uB2C8\uB2E4";
    case "no-plans":
      return ".omo/plans/ \uC5D0 plan \uD30C\uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4";
    case "plan-empty":
      return "plan \uD30C\uC77C\uC5D0 \uCCB4\uD06C\uBC15\uC2A4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4 (\uD5E4\uB354\uB9CC \uC874\uC7AC)";
    case "all-plans-complete":
      return "plan \uC758 \uBAA8\uB4E0 task \uAC00 \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC0C8 plan \uC791\uC131 \uD544\uC694";
    case "boulder-active":
      return ".omo/boulder.json \uC774 \uC774\uBBF8 \uC874\uC7AC\uD569\uB2C8\uB2E4. \uAE30\uC874 \uC791\uC5C5\uC774 \uC9C4\uD589 \uC911\uC774\uAC70\uB098 archive \uAC00 \uD544\uC694\uD569\uB2C8\uB2E4";
  }
}
function isSessionNotFoundError(err) {
  const httpError = err;
  return httpError.status === 404 || httpError.statusCode === 404 || httpError.response?.status === 404 || err.message.includes("404");
}
async function sendHtml(bot, text) {
  await bot.sendMessage(text, { parse_mode: "HTML" });
}
async function sendPlain(bot, text) {
  await bot.sendMessage(text);
}
function createStartWorkCommandDispatcher(deps) {
  return async ({ chatId, bot, args }) => {
    const rawIndex = args[0]?.trim();
    if (!rawIndex) {
      await sendPlain(bot, "\uC0AC\uC6A9\uBC95: /start_work <\uBC88\uD638>. \uBA3C\uC800 /sessions \uB85C \uBAA9\uB85D \uD655\uC778");
      return;
    }
    const index = Number(rawIndex);
    if (Number.isNaN(index)) {
      await sendPlain(bot, `\uC798\uBABB\uB41C \uC785\uB825: ${rawIndex}\uC740 \uC22B\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4`);
      return;
    }
    const snapshot = await deps.snapshotStore.loadSnapshot(chatId);
    if (snapshot === null) {
      await sendPlain(bot, "\uC138\uC158 \uBAA9\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 /sessions \uC2E4\uD589");
      return;
    }
    const entry = snapshot.find((candidate) => candidate.index === index);
    if (!entry) {
      await sendPlain(bot, `${index}\uBC88 \uC138\uC158 \uC5C6\uC74C (\uBAA9\uB85D \uD06C\uAE30: ${snapshot.length})`);
      return;
    }
    const sessionId = entry.sessionId;
    const rawSourceServerUrl = entry.serverUrl ?? deps.sessionTitleService.getServerUrl(sessionId);
    const sourceServerUrl = normalizeOpenCodeServerUrl(rawSourceServerUrl);
    if (rawSourceServerUrl && !sourceServerUrl) {
      await sendPlain(bot, "\uC138\uC158 \uC11C\uBC84 \uC815\uBCF4\uAC00 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694");
      deps.logger.error("start-work invalid server url", { sessionId });
      return;
    }
    const useRemoteServer = isDifferentServerUrl(sourceServerUrl, deps.serverUrl);
    let session;
    try {
      if (sourceServerUrl && useRemoteServer) {
        const result = await getRemoteSession(sourceServerUrl, sessionId, deps.opencodeFetch);
        if (!result.data || result.response.status === 404) {
          await sendPlain(bot, "\uC138\uC158\uC774 \uB354 \uC774\uC0C1 \uC874\uC7AC\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
          return;
        }
        session = result.data;
      } else {
        const result = await deps.client.session.get({ path: { id: sessionId } });
        if (!result.data) {
          await sendPlain(bot, "\uC138\uC158\uC774 \uB354 \uC774\uC0C1 \uC874\uC7AC\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
          return;
        }
        session = result.data;
      }
    } catch (err) {
      if (err instanceof Error && isSessionNotFoundError(err)) {
        await sendPlain(bot, "\uC138\uC158\uC774 \uB354 \uC774\uC0C1 \uC874\uC7AC\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
        return;
      }
      await sendPlain(bot, "\uC138\uC158 \uD655\uC778 \uC2E4\uD328. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694");
      deps.logger.error("start-work session lookup failed", { sessionId, error: String(err) });
      return;
    }
    const agent = deps.sessionTitleService.getSessionAgent(sessionId) ?? agentFromSession3(session) ?? entry.agent;
    if (agent !== "plan") {
      await sendPlain(
        bot,
        `${index}\uBC88 \uC138\uC158\uC758 \uC5D0\uC774\uC804\uD2B8\uB294 'plan' \uC774 \uC544\uB2D9\uB2C8\uB2E4 (\uD604\uC7AC: ${agent ?? "unknown"}). /start_work \uB294 plan \uC138\uC158\uC5D0\uC11C\uB9CC \uAC00\uB2A5\uD569\uB2C8\uB2E4`
      );
      return;
    }
    let idle;
    try {
      idle = sourceServerUrl && useRemoteServer ? ((await getRemoteStatusMap(sourceServerUrl, deps.opencodeFetch))[sessionId]?.type ?? "idle") === "idle" : await recheckSessionIdle(deps.client, sessionId);
    } catch (err) {
      await sendPlain(bot, "\uC138\uC158 \uC0C1\uD0DC \uD655\uC778 \uC2E4\uD328. /sessions \uC7AC\uC2E4\uD589 \uD544\uC694");
      deps.logger.error("start-work idle recheck failed", { sessionId, error: String(err) });
      return;
    }
    if (!idle) {
      await sendPlain(bot, `${index}\uBC88 \uC138\uC158\uC774 idle \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4. \uC791\uC5C5 \uC644\uB8CC\uB97C \uAE30\uB2E4\uB9AC\uC138\uC694`);
      return;
    }
    const readiness = await checkPlanReadiness({ projectRoot: resolveProjectRoot2(session) });
    if (!readiness.ready) {
      await sendPlain(bot, readinessMessage(readiness.reason));
      return;
    }
    try {
      await deps.runSessionCommand(sessionId, "start-work", sourceServerUrl);
      await sendHtml(
        bot,
        `${index}\uBC88 \uC138\uC158\uC5D0 opencode /start-work \uC2AC\uB798\uC2DC \uCEE4\uB9E8\uB4DC \uC804\uC1A1 \uC644\uB8CC. (${escapeHtml(entry.title)})`
      );
      deps.logger.info("start-work dispatched", { chatId, sessionId, index });
    } catch (err) {
      await sendHtml(bot, "opencode /start-work \uC804\uC1A1 \uC2E4\uD328");
      deps.logger.error("start-work dispatch failed", { sessionId, error: String(err) });
    }
  };
}

// src/events/help-command.ts
var HELP_TEXT = `<b>OpenCode Telegram Plugin \u2014 \uBA85\uB839 \uB3C4\uC6C0\uB9D0</b>

<b>/sessions</b>
\uD65C\uC131 root \uC138\uC158 \uBAA9\uB85D\uC744 \uBC88\uD638\uC640 \uD568\uAED8 \uD45C\uC2DC (\uCD5C\uADFC\uD65C\uB3D9\uC21C top 20).

<b>/status &lt;\uBC88\uD638&gt;</b>
\uD574\uB2F9 \uC138\uC158\uC758 \uC5D0\uC774\uC804\uD2B8/\uC0C1\uD0DC/\uB9C8\uC9C0\uB9C9 \uBA54\uC2DC\uC9C0 \uC2A4\uB2C8\uD3AB/\uD50C\uB79C \uC9C4\uD589\uB3C4/boulder \uC0C1\uD0DC \uD45C\uC2DC.

<b>/start_work &lt;\uBC88\uD638&gt;</b>
\uD574\uB2F9 \uC138\uC158\uC5D0 opencode <code>/start-work</code> \uC2AC\uB798\uC2DC \uCEE4\uB9E8\uB4DC \uC804\uC1A1.
\uC548\uC804 \uAC8C\uC774\uD2B8: agent='plan' AND status=idle AND .omo/plans \uC5D0 \uBBF8\uC644\uB8CC plan \uC874\uC7AC AND .omo/boulder.json \uBD80\uC7AC.
\uC870\uAC74 \uBBF8\uCDA9\uC871\uC2DC \uAD6C\uCCB4\uC801 \uC0AC\uC720 \uC548\uB0B4.
(Telegram \uBD07 \uBA85\uB839\uC740 <code>/start_work</code>, \uB0B4\uBD80 \uD2B8\uB9AC\uAC70 \uB300\uC0C1\uC740 opencode \uC758 <code>/start-work</code>)

<b>/help</b>
\uC774 \uB3C4\uC6C0\uB9D0 \uD45C\uC2DC.

<b>\uC81C\uC57D</b>
\uBC88\uD638\uB294 <code>/sessions</code> \uB9C8\uC9C0\uB9C9 \uD638\uCD9C\uC758 \uC2A4\uB0C5\uC0F7\uC5D0 \uC885\uC18D (TTL 1\uC2DC\uAC04).
leader \uD504\uB85C\uC138\uC2A4\uAC00 \uAD00\uCC30\uD55C \uC138\uC158\uB9CC \uD45C\uC2DC \u2014 \uB2E4\uB978 OpenCode \uD504\uB85C\uC138\uC2A4\uC758 \uC138\uC158\uC740 \uBCF4\uC774\uC9C0 \uC54A\uC744 \uC218 \uC788\uC74C.`;
function createHelpDispatcher(deps) {
  return async ({ chatId, bot }) => {
    await bot.sendMessage(HELP_TEXT, { parse_mode: "HTML" });
    deps.logger.info("help shown", { chatId });
  };
}

// src/lib/env-loader.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { join as join7 } from "path";
import dotenv from "dotenv";
function loadPluginEnv(opts) {
  const paths = [
    join7(opts.pluginDir, "../../.env"),
    join7(opts.pluginDir, "..", ".env"),
    join7(opts.pluginDir, ".env"),
    join7(opts.homeDir ?? homedir(), ".config/opencode/telegram-remote/.env")
  ];
  const loadedFrom = [];
  const values = {};
  for (const envPath of paths) {
    if (!existsSync(envPath)) continue;
    const result = dotenv.config({ path: envPath, override: false });
    if (result.parsed) {
      loadedFrom.push(envPath);
      for (const [key, value] of Object.entries(result.parsed)) {
        if (!(key in values)) values[key] = value;
      }
    }
  }
  return { loadedFrom, values };
}

// src/lib/lock.ts
import { open as open2, readFile as readFile6, stat as stat3, unlink as unlink6 } from "fs/promises";
import { hostname } from "os";
var DEFAULT_TTL_MS2 = 5 * 60 * 1e3;
function hasCode6(err, code) {
  return "code" in err && err.code === code;
}
function parseLockData(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.createdAt === "string") {
      return { pid: parsed.pid, hostname: parsed.hostname, createdAt: parsed.createdAt };
    }
  } catch {
    return null;
  }
  return null;
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && hasCode6(err, "ESRCH")) return false;
    return true;
  }
}
async function createLock(lockPath, pid) {
  const file = await open2(lockPath, "wx");
  const acquiredAt = /* @__PURE__ */ new Date();
  const data = { pid, hostname: hostname(), createdAt: acquiredAt.toISOString() };
  try {
    await file.writeFile(JSON.stringify(data), "utf8");
  } finally {
    await file.close();
  }
  let released = false;
  return {
    path: lockPath,
    acquiredAt,
    async release() {
      if (released) return;
      released = true;
      try {
        await unlink6(lockPath);
      } catch {
      }
    }
  };
}
async function inspectExisting(lockPath, ttlMs) {
  let ownerPid;
  let dead = false;
  try {
    const text = await readFile6(lockPath, "utf8");
    const data = parseLockData(text);
    if (data) {
      ownerPid = data.pid;
      dead = !isPidAlive(data.pid);
    }
  } catch {
    return { stale: true, reason: "unreadable lock" };
  }
  try {
    const fileStat = await stat3(lockPath);
    const expired = Date.now() - fileStat.mtimeMs > ttlMs;
    if (dead) return { stale: true, ownerPid, reason: "dead owner" };
    if (expired) return { stale: true, ownerPid, reason: "expired lock" };
    return { stale: false, ownerPid, reason: "lock held" };
  } catch {
    return { stale: true, ownerPid, reason: "missing lock" };
  }
}
async function acquireLock(opts) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS2;
  const pid = opts.pid ?? process.pid;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { acquired: true, handle: await createLock(opts.lockPath, pid) };
    } catch (err) {
      if (!(err instanceof Error) || !hasCode6(err, "EEXIST")) {
        return { acquired: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const existing = await inspectExisting(opts.lockPath, ttlMs);
      if (!existing.stale || attempt === 1) {
        return { acquired: false, reason: existing.reason, ownerPid: existing.ownerPid };
      }
      try {
        await unlink6(opts.lockPath);
      } catch {
        return { acquired: false, reason: "failed to remove stale lock", ownerPid: existing.ownerPid };
      }
    }
  }
  return { acquired: false, reason: "lock acquisition failed" };
}

// src/lib/logger.ts
import { appendFile } from "fs/promises";
import { tmpdir as tmpdir4 } from "os";
var DEFAULT_BUFFER_LIMIT = 4096;
var DEFAULT_FLUSH_INTERVAL_MS = 2e3;
function safeJson(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return '{"serialization":"failed"}';
  }
}
function createLogger(opts = {}) {
  const filePath = opts.filePath ?? `${tmpdir4()}/opencoder-telegram.log`;
  const namespace = opts.namespace ?? "default";
  const bufferLimit = opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  let buffer = "";
  let closed = false;
  let flushing = Promise.resolve();
  const timer = setInterval(() => {
    void flushBuffer();
  }, flushIntervalMs);
  timer.unref();
  async function flushBuffer() {
    if (buffer.length === 0) return flushing;
    const chunk = buffer;
    buffer = "";
    flushing = flushing.then(async () => {
      try {
        await appendFile(filePath, chunk, "utf8");
      } catch {
      }
    });
    return flushing;
  }
  function write(level, msg, data) {
    if (closed) return;
    const json = data === void 0 ? "" : ` ${safeJson(data)}`;
    buffer += `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] [${process.pid}] [${namespace}] ${msg}${json}
`;
    if (level === "error" || buffer.length >= bufferLimit) {
      void flushBuffer();
    }
  }
  return {
    debug(msg, data) {
      write("debug", msg, data);
    },
    info(msg, data) {
      write("info", msg, data);
    },
    warn(msg, data) {
      write("warn", msg, data);
    },
    error(msg, data) {
      write("error", msg, data);
    },
    async flush() {
      await flushBuffer();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await flushBuffer();
    }
  };
}

// src/lib/session-snapshot.ts
import { chmod as chmod2, mkdir as mkdir6, readFile as readFile7, rename as rename5, unlink as unlink7, writeFile as writeFile5 } from "fs/promises";
import { dirname as dirname4, join as join8 } from "path";
var TTL_MS = 60 * 60 * 1e3;
function hasCode7(err, code) {
  return err instanceof Error && "code" in err && err.code === code;
}
function isSnapshotFile(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  if (v.version !== 1) return false;
  if (typeof v.chatId !== "number") return false;
  if (typeof v.createdAt !== "number") return false;
  if (!Array.isArray(v.entries)) return false;
  for (const entry of v.entries) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry;
    if (typeof e.index !== "number") return false;
    if (typeof e.sessionId !== "string") return false;
    if (typeof e.title !== "string") return false;
    if (typeof e.capturedAt !== "number") return false;
    if (e.agent !== void 0 && typeof e.agent !== "string") return false;
    if (e.status !== void 0 && typeof e.status !== "string") return false;
    if (e.serverUrl !== void 0) {
      if (typeof e.serverUrl !== "string") return false;
      if (!normalizeOpenCodeServerUrl(e.serverUrl)) return false;
    }
  }
  return true;
}
function normalizeEntry2(entry) {
  const out = {
    index: entry.index,
    sessionId: entry.sessionId,
    title: entry.title,
    capturedAt: entry.capturedAt
  };
  if (entry.agent !== void 0) out.agent = entry.agent;
  if (entry.status !== void 0) out.status = entry.status;
  if (entry.serverUrl !== void 0) {
    const serverUrl = normalizeOpenCodeServerUrl(entry.serverUrl);
    if (serverUrl !== void 0) out.serverUrl = serverUrl;
  }
  return out;
}
function createSnapshotStore(opts) {
  const { configDir, tokenHash, logger } = opts;
  const snapshotsDir = join8(configDir, "snapshots");
  const writeLocks = /* @__PURE__ */ new Map();
  function snapshotFilePath(chatId) {
    return join8(snapshotsDir, `${tokenHash}-${chatId}.json`);
  }
  async function performSave(chatId, entries) {
    const filePath = snapshotFilePath(chatId);
    const parent = dirname4(filePath);
    await mkdir6(parent, { recursive: true });
    try {
      await chmod2(parent, 448);
    } catch (err) {
      logger.error("snapshot: failed to chmod parent dir", {
        path: parent,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    const payload = {
      version: 1,
      chatId,
      createdAt: Date.now(),
      entries: entries.map(normalizeEntry2)
    };
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile5(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename5(tmpPath, filePath);
    } catch (err) {
      try {
        await unlink7(tmpPath);
      } catch {
      }
      throw err;
    }
    await chmod2(filePath, 384);
  }
  async function saveSnapshot(chatId, entries) {
    const prev = writeLocks.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(() => performSave(chatId, entries));
    const tracked = next.catch(() => void 0);
    writeLocks.set(chatId, tracked);
    try {
      await next;
    } finally {
      if (writeLocks.get(chatId) === tracked) {
        writeLocks.delete(chatId);
      }
    }
  }
  async function loadSnapshot(chatId) {
    const filePath = snapshotFilePath(chatId);
    let text;
    try {
      text = await readFile7(filePath, "utf8");
    } catch (err) {
      if (hasCode7(err, "ENOENT")) return null;
      logger.error("snapshot: failed to read file", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error("snapshot: corrupted JSON", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
    if (!isSnapshotFile(parsed)) {
      logger.error("snapshot: invalid shape", { path: filePath });
      return null;
    }
    if (parsed.createdAt + TTL_MS < Date.now()) {
      try {
        await unlink7(filePath);
      } catch (err) {
        if (!hasCode7(err, "ENOENT")) {
          logger.error("snapshot: failed to unlink expired file", {
            path: filePath,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      return null;
    }
    return parsed.entries.map(normalizeEntry2);
  }
  return { saveSnapshot, loadSnapshot, snapshotFilePath };
}

// src/lib/state-store.ts
import { mkdir as mkdir7, readFile as readFile8, rename as rename6, writeFile as writeFile6 } from "fs/promises";
import { homedir as homedir2 } from "os";
import { dirname as dirname5, join as join9 } from "path";
function hasCode8(err, code) {
  return "code" in err && err.code === code;
}
function parseState(text) {
  const parsed = JSON.parse(text);
  const state = {};
  if (typeof parsed.chatId === "number") state.chatId = parsed.chatId;
  if (typeof parsed.updatedAt === "string") state.updatedAt = parsed.updatedAt;
  if (typeof parsed.discoveredBy === "number") state.discoveredBy = parsed.discoveredBy;
  return state;
}
function createStateStore(opts = {}) {
  const filePath = opts.filePath ?? join9(homedir2(), ".config/opencode/telegram-remote/state.json");
  return {
    async read() {
      try {
        return parseState(await readFile8(filePath, "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode8(err, "ENOENT")) return {};
        throw err;
      }
    },
    async write(patch) {
      const existing = await this.read();
      const next = { ...existing, ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      await mkdir7(dirname5(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile6(tmpPath, JSON.stringify(next, null, 2), "utf8");
      try {
        await rename6(tmpPath, filePath);
      } catch (err) {
        if (!(err instanceof Error) || !hasCode8(err, "ENOENT")) throw err;
        await writeFile6(tmpPath, JSON.stringify(next, null, 2), "utf8");
        await rename6(tmpPath, filePath);
      }
      return next;
    }
  };
}

// src/services/session-title-service.ts
function agentFromSession4(info) {
  const candidate = info;
  return typeof candidate.agent === "string" ? candidate.agent : void 0;
}
var SessionTitleService = class {
  sessions = /* @__PURE__ */ new Map();
  setSessionInfo(info) {
    const existing = this.sessions.get(info.id);
    this.sessions.set(info.id, {
      title: info.title || null,
      parentID: info.parentID ?? null,
      agent: agentFromSession4(info) ?? existing?.agent,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl
    });
  }
  setSessionTitle(sessionId, title) {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl
    });
  }
  setSessionAgent(sessionId, agent) {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl
    });
  }
  setSessionStatus(sessionId, status) {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status,
      idleNotificationPending: status === "idle" ? existing?.idleNotificationPending ?? false : false,
      lastSeenAt: Date.now(),
      serverUrl: existing?.serverUrl
    });
  }
  setServerUrl(sessionId, serverUrl) {
    const existing = this.sessions.get(sessionId);
    if (existing?.serverUrl) return;
    const lastSeenAt = existing?.lastSeenAt ?? Date.now();
    this.sessions.set(sessionId, {
      ...existing ?? {
        title: null,
        parentID: void 0,
        idleNotificationPending: false,
        lastSeenAt
      },
      lastSeenAt,
      serverUrl
    });
  }
  getServerUrl(sessionId) {
    return this.sessions.get(sessionId)?.serverUrl;
  }
  getRootSessionsByRecency(limit) {
    const results = [];
    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.parentID !== null) continue;
      results.push({
        sessionId,
        title: entry.title,
        agent: entry.agent,
        status: entry.status,
        serverUrl: entry.serverUrl
      });
    }
    results.sort((a, b) => {
      const lastSeenA = this.sessions.get(a.sessionId)?.lastSeenAt ?? 0;
      const lastSeenB = this.sessions.get(b.sessionId)?.lastSeenAt ?? 0;
      return lastSeenB - lastSeenA;
    });
    return results.slice(0, limit);
  }
  getSessionTitle(sessionId) {
    return this.sessions.get(sessionId)?.title ?? null;
  }
  getParentID(sessionId) {
    return this.sessions.get(sessionId)?.parentID;
  }
  getSessionAgent(sessionId) {
    return this.sessions.get(sessionId)?.agent;
  }
  getSessionStatus(sessionId) {
    return this.sessions.get(sessionId)?.status;
  }
  hasUnfinishedDescendants(parentID) {
    for (const [sessionID, session] of this.sessions.entries()) {
      if (session.parentID !== parentID) continue;
      if (session.status !== "idle") return true;
      if (this.hasUnfinishedDescendants(sessionID)) return true;
    }
    return false;
  }
  deferIdleNotification(sessionId) {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID,
      agent: existing?.agent,
      status: existing?.status ?? "idle",
      idleNotificationPending: true,
      lastSeenAt: existing?.lastSeenAt ?? Date.now(),
      serverUrl: existing?.serverUrl
    });
  }
  hasDeferredIdleNotification(sessionId) {
    return this.sessions.get(sessionId)?.idleNotificationPending ?? false;
  }
  clearDeferredIdleNotification(sessionId) {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.set(sessionId, {
      ...existing,
      idleNotificationPending: false
    });
  }
};

// src/telegram-remote.ts
var pluginDir = dirname6(fileURLToPath(import.meta.url));
async function postToServer(serverUrl, path, body) {
  const safeServerUrl = normalizeOpenCodeServerUrl(serverUrl);
  if (!safeServerUrl) throw new Error("Invalid OpenCode server URL");
  const url = new URL(path, safeServerUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error"
  });
  if (response.ok) return;
  throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
}
function getSessionAgentFromMessage(event) {
  const info = event.properties.info;
  if (info.role !== "user") return void 0;
  return { sessionID: info.sessionID, agent: info.agent };
}
function getSessionAgentFromNextStep(event) {
  if (event.type !== "session.next.step.started") return void 0;
  const props = event.properties;
  if (!props) return void 0;
  if (typeof props.sessionID !== "string") return void 0;
  if (typeof props.agent !== "string") return void 0;
  return { sessionID: props.sessionID, agent: props.agent };
}
var TelegramRemote = async (input) => {
  const logger = createLogger({ namespace: "telegram" });
  try {
    const envResult = loadPluginEnv({ pluginDir });
    logger.info("env loaded", { from: envResult.loadedFrom });
    const config = loadConfig({ logger, env: process.env });
    const stateStore = createStateStore();
    const initialState = await stateStore.read();
    const tokenHash = createHash5("sha256").update(config.botToken).digest("hex").slice(0, 16);
    const configDir = join10(homedir3(), ".config/opencode/telegram-remote");
    const snapshotStore = createSnapshotStore({ configDir, tokenHash, logger });
    const sessionRegistry = createSessionRegistryStore({ configDir, tokenHash, logger });
    const lockPath = join10(tmpdir5(), `opencoder-telegram-${tokenHash}.lock`);
    const claimsDir = join10(tmpdir5(), `opencoder-telegram-claims-${tokenHash}`);
    const pendingQuestions = createPendingQuestionStore({ tokenHash });
    const pendingPermissions = createPendingPermissionStore({ tokenHash });
    const pendingStartWorks = createPendingStartWorkStore({ tokenHash });
    const lockResult = await acquireLock({ lockPath });
    const isLeader = lockResult.acquired;
    logger.info(
      `lock ${isLeader ? "acquired - leader mode" : "held by other - pass-through mode"}`,
      isLeader ? {} : { reason: lockResult.reason }
    );
    logger.info("server url", {
      url: input.serverUrl.toString(),
      href: input.serverUrl.href,
      origin: input.serverUrl.origin
    });
    const sessionTitleService = new SessionTitleService();
    const client = input.client;
    const replyToQuestion = async (requestID, answers, serverUrl = input.serverUrl.href) => {
      const path = `/question/${encodeURIComponent(requestID)}/reply`;
      if (serverUrl !== input.serverUrl.href) {
        await postToServer(serverUrl, path, { answers });
        return;
      }
      await client._client.post({
        url: path,
        headers: { "Content-Type": "application/json" },
        body: { answers },
        throwOnError: true
      });
    };
    const replyToPermission = async (requestID, sessionID, reply, endpoint2, serverUrl = input.serverUrl.href) => {
      if (endpoint2 === "request") {
        const path2 = `/permission/${encodeURIComponent(requestID)}/reply`;
        if (serverUrl !== input.serverUrl.href) {
          await postToServer(serverUrl, path2, { reply });
          return;
        }
        await client._client.post({
          url: path2,
          headers: { "Content-Type": "application/json" },
          body: { reply },
          throwOnError: true
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
        throwOnError: true
      });
    };
    const runSessionCommand = async (sessionID, command, serverUrl = input.serverUrl.href) => {
      const path = `/session/${encodeURIComponent(sessionID)}/command`;
      const body = { command, arguments: "" };
      if (serverUrl !== input.serverUrl.href) {
        await postToServer(serverUrl, path, body);
        return;
      }
      await input.client.session.command({
        path: { id: sessionID },
        body,
        throwOnError: true
      });
    };
    const bot = createTelegramBot({
      config,
      stateStore,
      logger,
      initialChatId: initialState.chatId ?? config.chatId,
      polling: isLeader
    });
    if (isLeader) {
      bot.start().catch((err) => {
        logger.error("bot polling stopped", { error: String(err) });
      });
    }
    const cleanup = async () => {
      try {
        await bot.stop();
      } catch {
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
    const ctx = {
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
      runSessionCommand
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
        logger
      }));
      bot.setStatusDispatcher(createStatusDispatcher({
        snapshotStore,
        sessionTitleService,
        client: input.client,
        logger,
        serverUrl: input.serverUrl.href
      }));
      bot.setStartWorkCommandDispatcher(createStartWorkCommandDispatcher({
        snapshotStore,
        sessionTitleService,
        client: input.client,
        serverUrl: input.serverUrl.href,
        runSessionCommand,
        logger
      }));
      bot.setHelpDispatcher(createHelpDispatcher({ logger }));
    }
    return {
      event: async ({ event }) => {
        const extEvent = event;
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
                updatedAt: Date.now()
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
                updatedAt: Date.now()
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
      }
    };
  } catch (err) {
    logger.error("plugin initialization failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    await logger.close();
    return { event: async () => {
    } };
  }
};
var id = "opencoder-telegram-remote";
var server = TelegramRemote;
var telegram_remote_default = { id, server: TelegramRemote };
export {
  TelegramRemote,
  telegram_remote_default as default,
  id,
  server
};
