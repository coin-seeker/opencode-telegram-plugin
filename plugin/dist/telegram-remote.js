/**
 * OpenCoder Telegram Remote Plugin
 * https://github.com/coin-seeker/opencode-telegram-plugin
 */

// src/telegram-remote.ts
import { createHash as createHash4 } from "crypto";
import { tmpdir as tmpdir4 } from "os";
import { dirname as dirname4, join as join6 } from "path";
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
    bot.callbackQuery(/^sw:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      if (!startWorkDispatcher || messageId === void 0) return;
      await startWorkDispatcher.handleCallbackQuery(data, messageId);
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
    }
  };
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
        await ctx.replyToPermission(pending.requestID, pending.sessionID, reply, pending.endpoint);
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
    await ctx.replyToQuestion(pending.requestID, answers);
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

// src/events/session-created.ts
async function handleSessionCreated(event, ctx) {
  ctx.sessionTitleService.setSessionInfo(event.properties.info);
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

// src/events/start-work.ts
var CALLBACK_RE3 = /^sw:(.+)$/;
var START_WORK_COMMAND = "start-work";
var START_WORK_RE = /(?:^|[\s`])\/start-work(?:\s+([^\n`]+))?/g;
var StartWorkCommandStore = class {
  commands = /* @__PURE__ */ new Map();
  updateFromText(sessionID, text) {
    const command = extractStartWorkCommand(sessionID, text);
    if (!command) return void 0;
    this.commands.set(sessionID, command.arguments);
    return command;
  }
  get(sessionID) {
    const args = this.commands.get(sessionID);
    if (args === void 0) return void 0;
    return { sessionID, arguments: args };
  }
  delete(sessionID) {
    this.commands.delete(sessionID);
  }
};
function extractStartWorkCommand(sessionID, text) {
  let latestArgs;
  for (const match of text.matchAll(START_WORK_RE)) {
    const args = (match[1] ?? "").trim();
    if (args) latestArgs = args;
  }
  if (latestArgs === void 0) return void 0;
  return { sessionID, arguments: latestArgs };
}
function startWorkCallbackData(sessionID) {
  const data = `sw:${encodeURIComponent(sessionID)}`;
  return Buffer.byteLength(data, "utf8") <= 64 ? data : void 0;
}
function startWorkKeyboard(sessionID) {
  const callbackData = startWorkCallbackData(sessionID);
  if (!callbackData) return void 0;
  return [[{ text: "\u25B6\uFE0F Run /start-work", callback_data: callbackData }]];
}
function createStartWorkDispatcher(ctx) {
  return {
    async handleCallbackQuery(data, messageId) {
      const match = CALLBACK_RE3.exec(data);
      if (!match) return;
      const sessionID = decodeURIComponent(match[1]);
      const command = ctx.startWorkCommands.get(sessionID);
      if (!command) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `\u26A0\uFE0F No /start-work command was detected for this session.

Session: ${sessionID}`
        );
        return;
      }
      try {
        await ctx.runSessionCommand(sessionID, START_WORK_COMMAND, command.arguments);
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `\u25B6\uFE0F Sent /start-work ${command.arguments} to opencode.

Session: ${sessionID}`
        );
        ctx.startWorkCommands.delete(sessionID);
        ctx.logger.info("start-work command sent", { sessionID });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          `\u26A0\uFE0F Failed to send /start-work to opencode.

Session: ${sessionID}`
        );
        ctx.logger.error("failed to send start-work command", { sessionID, error: String(err) });
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
  const startWorkCommand = ctx.startWorkCommands.get(sessionId);
  const message = title ? `Agent has finished: ${title}` : "Agent has finished.";
  const keyboard = startWorkCommand ? startWorkKeyboard(sessionId) : void 0;
  const text = startWorkCommand ? `${message}

Plan is ready. Tap below to run /start-work ${startWorkCommand.arguments}.` : message;
  try {
    await ctx.bot.sendMessage(
      text,
      keyboard ? { reply_markup: { inline_keyboard: keyboard } } : void 0
    );
    ctx.sessionTitleService.clearDeferredIdleNotification(sessionId);
    ctx.logger.info("idle notification sent", { sessionId, title });
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}
async function flushDeferredParentIfReady(parentID, ctx) {
  if (!ctx.sessionTitleService.hasDeferredIdleNotification(parentID)) return;
  if (ctx.sessionTitleService.hasUnfinishedDescendants(parentID)) return;
  if (ctx.sessionTitleService.getSessionStatus(parentID) !== "idle") {
    ctx.sessionTitleService.clearDeferredIdleNotification(parentID);
    ctx.logger.info("clearing deferred parent idle notification - parent resumed", {
      sessionId: parentID
    });
    return;
  }
  ctx.logger.info("sending deferred parent idle notification", { sessionId: parentID });
  await sendIdleNotification(parentID, ctx);
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
  ctx.sessionTitleService.setSessionStatus(sessionId, "idle");
  const parentID = await resolveParentID(sessionId, ctx);
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
  if (statusType === "idle") {
    await handleSessionIdle(event, ctx);
  }
}

// src/events/session-updated.ts
async function handleSessionUpdated(event, ctx) {
  const info = event.properties.info;
  ctx.sessionTitleService.setSessionInfo(info);
}

// src/lib/env-loader.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { join as join4 } from "path";
import dotenv from "dotenv";
function loadPluginEnv(opts) {
  const paths = [
    join4(opts.pluginDir, "../../.env"),
    join4(opts.pluginDir, "..", ".env"),
    join4(opts.pluginDir, ".env"),
    join4(opts.homeDir ?? homedir(), ".config/opencode/telegram-remote/.env")
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
import { open as open2, readFile as readFile3, stat as stat2, unlink as unlink4 } from "fs/promises";
import { hostname } from "os";
var DEFAULT_TTL_MS2 = 5 * 60 * 1e3;
function hasCode4(err, code) {
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
    if (err instanceof Error && hasCode4(err, "ESRCH")) return false;
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
        await unlink4(lockPath);
      } catch {
      }
    }
  };
}
async function inspectExisting(lockPath, ttlMs) {
  let ownerPid;
  let dead = false;
  try {
    const text = await readFile3(lockPath, "utf8");
    const data = parseLockData(text);
    if (data) {
      ownerPid = data.pid;
      dead = !isPidAlive(data.pid);
    }
  } catch {
    return { stale: true, reason: "unreadable lock" };
  }
  try {
    const fileStat = await stat2(lockPath);
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
      if (!(err instanceof Error) || !hasCode4(err, "EEXIST")) {
        return { acquired: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const existing = await inspectExisting(opts.lockPath, ttlMs);
      if (!existing.stale || attempt === 1) {
        return { acquired: false, reason: existing.reason, ownerPid: existing.ownerPid };
      }
      try {
        await unlink4(opts.lockPath);
      } catch {
        return { acquired: false, reason: "failed to remove stale lock", ownerPid: existing.ownerPid };
      }
    }
  }
  return { acquired: false, reason: "lock acquisition failed" };
}

// src/lib/logger.ts
import { appendFile } from "fs/promises";
import { tmpdir as tmpdir3 } from "os";
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
  const filePath = opts.filePath ?? `${tmpdir3()}/opencoder-telegram.log`;
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

// src/lib/state-store.ts
import { mkdir as mkdir4, readFile as readFile4, rename as rename3, writeFile as writeFile3 } from "fs/promises";
import { homedir as homedir2 } from "os";
import { dirname as dirname3, join as join5 } from "path";
function hasCode5(err, code) {
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
  const filePath = opts.filePath ?? join5(homedir2(), ".config/opencode/telegram-remote/state.json");
  return {
    async read() {
      try {
        return parseState(await readFile4(filePath, "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode5(err, "ENOENT")) return {};
        throw err;
      }
    },
    async write(patch) {
      const existing = await this.read();
      const next = { ...existing, ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      await mkdir4(dirname3(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile3(tmpPath, JSON.stringify(next, null, 2), "utf8");
      try {
        await rename3(tmpPath, filePath);
      } catch (err) {
        if (!(err instanceof Error) || !hasCode5(err, "ENOENT")) throw err;
        await writeFile3(tmpPath, JSON.stringify(next, null, 2), "utf8");
        await rename3(tmpPath, filePath);
      }
      return next;
    }
  };
}

// src/services/session-title-service.ts
var SessionTitleService = class {
  sessions = /* @__PURE__ */ new Map();
  setSessionInfo(info) {
    const existing = this.sessions.get(info.id);
    this.sessions.set(info.id, {
      title: info.title || null,
      parentID: info.parentID ?? null,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false
    });
  }
  setSessionTitle(sessionId, title) {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title,
      parentID: existing?.parentID ?? null,
      status: existing?.status,
      idleNotificationPending: existing?.idleNotificationPending ?? false
    });
  }
  setSessionStatus(sessionId, status) {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      title: existing?.title ?? null,
      parentID: existing?.parentID ?? null,
      status,
      idleNotificationPending: status === "idle" ? existing?.idleNotificationPending ?? false : false
    });
  }
  getSessionTitle(sessionId) {
    return this.sessions.get(sessionId)?.title ?? null;
  }
  getParentID(sessionId) {
    return this.sessions.get(sessionId)?.parentID;
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
      parentID: existing?.parentID ?? null,
      status: existing?.status ?? "idle",
      idleNotificationPending: true
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
var pluginDir = dirname4(fileURLToPath(import.meta.url));
function getTextPartFromMessagePartUpdated(event) {
  if (event.type !== "message.part.updated") return void 0;
  const part = event.properties?.part;
  if (!part || typeof part !== "object") return void 0;
  const candidate = part;
  if (candidate.type !== "text" || typeof candidate.sessionID !== "string" || typeof candidate.text !== "string") {
    return void 0;
  }
  return { type: "text", sessionID: candidate.sessionID, text: candidate.text };
}
var TelegramRemote = async (input) => {
  const logger = createLogger({ namespace: "telegram" });
  try {
    const envResult = loadPluginEnv({ pluginDir });
    logger.info("env loaded", { from: envResult.loadedFrom });
    const config = loadConfig({ logger, env: process.env });
    const stateStore = createStateStore();
    const initialState = await stateStore.read();
    const tokenHash = createHash4("sha256").update(config.botToken).digest("hex").slice(0, 16);
    const lockPath = join6(tmpdir4(), `opencoder-telegram-${tokenHash}.lock`);
    const claimsDir = join6(tmpdir4(), `opencoder-telegram-claims-${tokenHash}`);
    const pendingQuestions = createPendingQuestionStore({ tokenHash });
    const pendingPermissions = createPendingPermissionStore({ tokenHash });
    const startWorkCommands = new StartWorkCommandStore();
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
    const replyToQuestion = async (requestID, answers) => {
      await client._client.post({
        url: `/question/${encodeURIComponent(requestID)}/reply`,
        headers: { "Content-Type": "application/json" },
        body: { answers },
        throwOnError: true
      });
    };
    const replyToPermission = async (requestID, sessionID, reply, endpoint) => {
      if (endpoint === "request") {
        await client._client.post({
          url: `/permission/${encodeURIComponent(requestID)}/reply`,
          headers: { "Content-Type": "application/json" },
          body: { reply },
          throwOnError: true
        });
        return;
      }
      await client._client.post({
        url: `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}`,
        headers: { "Content-Type": "application/json" },
        body: { response: reply },
        throwOnError: true
      });
    };
    const runSessionCommand = async (sessionID, command, args) => {
      await input.client.session.command({
        path: { id: sessionID },
        body: { command, arguments: args },
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
      startWorkCommands,
      replyToQuestion,
      replyToPermission,
      runSessionCommand
    };
    if (isLeader) {
      bot.setQuestionDispatcher(createQuestionDispatcher(ctx));
      bot.setPermissionDispatcher(createPermissionDispatcher(ctx));
      bot.setStartWorkDispatcher(createStartWorkDispatcher(ctx));
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
            return handleSessionCreated(event, ctx);
          case "session.updated":
            return handleSessionUpdated(event, ctx);
          case "permission.updated":
            return handlePermissionUpdated(event, ctx);
          default: {
            const textPart = getTextPartFromMessagePartUpdated(extEvent);
            if (textPart) {
              const command = startWorkCommands.updateFromText(textPart.sessionID, textPart.text);
              if (command) {
                logger.info("start-work command detected", {
                  sessionID: command.sessionID,
                  arguments: command.arguments
                });
              }
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
