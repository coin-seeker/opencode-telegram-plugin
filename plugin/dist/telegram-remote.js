/**
 * OpenCoder Telegram Remote Plugin
 * https://github.com/coin-seeker/opencode-telegram-plugin
 */

// src/telegram-remote.ts
import { fileURLToPath } from "url";
import { dirname as dirname3, join as join5 } from "path";
import { tmpdir as tmpdir3 } from "os";
import { createHash as createHash3 } from "crypto";

// src/lib/logger.ts
import { appendFile } from "fs/promises";
import { tmpdir } from "os";
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
  const filePath = opts.filePath ?? `${tmpdir()}/opencoder-telegram.log`;
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

// src/lib/lock.ts
import { open, readFile, stat, unlink } from "fs/promises";
import { hostname } from "os";
var DEFAULT_TTL_MS = 5 * 60 * 1e3;
function hasCode(err, code) {
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
    if (err instanceof Error && hasCode(err, "ESRCH")) return false;
    return true;
  }
}
async function createLock(lockPath, pid) {
  const file = await open(lockPath, "wx");
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
        await unlink(lockPath);
      } catch {
      }
    }
  };
}
async function inspectExisting(lockPath, ttlMs) {
  let ownerPid;
  let dead = false;
  try {
    const text = await readFile(lockPath, "utf8");
    const data = parseLockData(text);
    if (data) {
      ownerPid = data.pid;
      dead = !isPidAlive(data.pid);
    }
  } catch {
    return { stale: true, reason: "unreadable lock" };
  }
  try {
    const fileStat = await stat(lockPath);
    const expired = Date.now() - fileStat.mtimeMs > ttlMs;
    if (dead) return { stale: true, ownerPid, reason: "dead owner" };
    if (expired) return { stale: true, ownerPid, reason: "expired lock" };
    return { stale: false, ownerPid, reason: "lock held" };
  } catch {
    return { stale: true, ownerPid, reason: "missing lock" };
  }
}
async function acquireLock(opts) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const pid = opts.pid ?? process.pid;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { acquired: true, handle: await createLock(opts.lockPath, pid) };
    } catch (err) {
      if (!(err instanceof Error) || !hasCode(err, "EEXIST")) {
        return { acquired: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const existing = await inspectExisting(opts.lockPath, ttlMs);
      if (!existing.stale || attempt === 1) {
        return { acquired: false, reason: existing.reason, ownerPid: existing.ownerPid };
      }
      try {
        await unlink(opts.lockPath);
      } catch {
        return { acquired: false, reason: "failed to remove stale lock", ownerPid: existing.ownerPid };
      }
    }
  }
  return { acquired: false, reason: "lock acquisition failed" };
}

// src/lib/state-store.ts
import { mkdir, readFile as readFile2, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
function hasCode2(err, code) {
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
  const filePath = opts.filePath ?? join(homedir(), ".config/opencode/telegram-remote/state.json");
  return {
    async read() {
      try {
        return parseState(await readFile2(filePath, "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode2(err, "ENOENT")) return {};
        throw err;
      }
    },
    async write(patch) {
      const existing = await this.read();
      const next = { ...existing, ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
      try {
        await rename(tmpPath, filePath);
      } catch (err) {
        if (!(err instanceof Error) || !hasCode2(err, "ENOENT")) throw err;
        await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
        await rename(tmpPath, filePath);
      }
      return next;
    }
  };
}

// src/lib/pending-questions.ts
import { createHash } from "crypto";
import { mkdir as mkdir2, readFile as readFile3, readdir, rename as rename2, unlink as unlink2, writeFile as writeFile2 } from "fs/promises";
import { tmpdir as tmpdir2 } from "os";
import { dirname as dirname2, join as join2 } from "path";
function hasCode3(err, code) {
  return "code" in err && err.code === code;
}
function pendingFilePath(dir, shortHash) {
  return join2(dir, `${shortHash}.json`);
}
function parsePending(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.requestID !== "string") throw new Error("Invalid pending question: requestID");
  if (typeof parsed.sessionID !== "string") throw new Error("Invalid pending question: sessionID");
  if (!Array.isArray(parsed.questions)) throw new Error("Invalid pending question: questions");
  if (!Array.isArray(parsed.telegramMessageIds)) throw new Error("Invalid pending question: telegramMessageIds");
  if (!Array.isArray(parsed.answersInProgress)) throw new Error("Invalid pending question: answersInProgress");
  return parsed;
}
async function listPendingFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode3(err, "ENOENT")) return [];
    throw err;
  }
}
function shortHashFromFileName(fileName) {
  return fileName.slice(0, -".json".length);
}
function createPendingQuestionStore(opts) {
  const dir = opts.baseDir ?? join2(tmpdir2(), `opencoder-telegram-pending-questions-${opts.tokenHash}`);
  return {
    dir,
    async savePending(shortHash, data) {
      const filePath = pendingFilePath(dir, shortHash);
      await mkdir2(dirname2(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile2(tmpPath, JSON.stringify(data, null, 2), "utf8");
      await rename2(tmpPath, filePath);
    },
    async loadPending(shortHash) {
      try {
        return parsePending(await readFile3(pendingFilePath(dir, shortHash), "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode3(err, "ENOENT")) return void 0;
        throw err;
      }
    },
    async deletePending(shortHash) {
      try {
        await unlink2(pendingFilePath(dir, shortHash));
      } catch (err) {
        if (!(err instanceof Error) || !hasCode3(err, "ENOENT")) throw err;
      }
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
    },
    async findByRequestID(requestID) {
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data?.requestID === requestID) return { shortHash, data };
      }
      return void 0;
    },
    async findAwaitingCustom(chatId, userId) {
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        const awaiting = data?.awaitingCustomFor;
        if (awaiting && awaiting.chatId === chatId && awaiting.userId === userId) return { shortHash, data };
      }
      return void 0;
    }
  };
}
function createQuestionShortHash(requestID) {
  return createHash("sha256").update(requestID).digest("base64url").slice(0, 10);
}

// src/lib/env-loader.ts
import { existsSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
import dotenv from "dotenv";
function loadPluginEnv(opts) {
  const paths = [
    join3(opts.pluginDir, "../../.env"),
    join3(opts.pluginDir, "..", ".env"),
    join3(opts.pluginDir, ".env"),
    join3(homedir2(), ".config/opencode/telegram-remote/.env")
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

// src/bot.ts
import { Bot, GrammyError } from "grammy";
function createTelegramBot(opts) {
  const { config, stateStore, logger, polling } = opts;
  const bot = new Bot(config.botToken);
  let activeChatId = opts.initialChatId;
  let questionDispatcher;
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
          await ctx.reply(`\u2705 Chat connected!

Your chat_id: ${newChatId}

This chat is now active for OpenCode notifications.`);
        }
      }
      await next();
    });
    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError && e.error_code === 409) {
        logger.info("polling conflict (409) - another process took over", { description: e.description });
      } else {
        logger.error("bot error", { error: String(e) });
      }
    });
    bot.callbackQuery(/^q:([^:]+):(\d+):(\d+|c)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (!questionDispatcher || messageId === void 0 || chatId === void 0 || userId === void 0) return;
      await questionDispatcher.handleCallbackQuery(data, messageId, chatId, userId);
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
      const inlineKeyboard = question.options.map((option, index) => [{
        text: option.label,
        callback_data: callbackData[index] ?? ""
      }]);
      if (callbackData[question.options.length]) {
        inlineKeyboard.push([{ text: "\u270F\uFE0F Custom answer", callback_data: callbackData[question.options.length] }]);
      }
      const header = question.header ? `\u2753 ${question.header}` : "\u2753 Question";
      return this.sendMessage(`${header}

${question.question}`, { reply_markup: { inline_keyboard: inlineKeyboard } });
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

// src/lib/claim.ts
import { mkdir as mkdir3, open as open2, readdir as readdir2, stat as stat2, unlink as unlink3 } from "fs/promises";
import { join as join4 } from "path";
import { createHash as createHash2 } from "crypto";
var DEFAULT_TTL_MS2 = 6e4;
var sweptDirs = /* @__PURE__ */ new Set();
function hasCode4(err, code) {
  return "code" in err && err.code === code;
}
function claimPath(claimsDir, key) {
  const hash = createHash2("sha256").update(key).digest("hex").slice(0, 16);
  return join4(claimsDir, `${hash}.claim`);
}
async function sweep(claimsDir, ttlMs) {
  if (sweptDirs.has(claimsDir)) return;
  sweptDirs.add(claimsDir);
  try {
    const entries = await readdir2(claimsDir, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".claim")).map(async (entry) => {
      const filePath = join4(claimsDir, entry.name);
      try {
        const fileStat = await stat2(filePath);
        if (Date.now() - fileStat.mtimeMs > ttlMs * 2) {
          await unlink3(filePath);
        }
      } catch {
      }
    }));
  } catch {
  }
}
async function createClaim(filePath) {
  const file = await open2(filePath, "wx");
  try {
    await file.writeFile((/* @__PURE__ */ new Date()).toISOString(), "utf8");
  } finally {
    await file.close();
  }
  return true;
}
async function claimOnce(opts) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS2;
  await mkdir3(opts.claimsDir, { recursive: true });
  await sweep(opts.claimsDir, ttlMs);
  const filePath = claimPath(opts.claimsDir, opts.key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createClaim(filePath);
    } catch (err) {
      if (!(err instanceof Error) || !hasCode4(err, "EEXIST")) throw err;
      try {
        const fileStat = await stat2(filePath);
        if (Date.now() - fileStat.mtimeMs <= ttlMs || attempt === 1) return false;
        await unlink3(filePath);
      } catch (statErr) {
        if (statErr instanceof Error && hasCode4(statErr, "ENOENT")) continue;
        return false;
      }
    }
  }
  return false;
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

// src/events/session-idle.ts
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
async function sendIdleNotification(sessionId, ctx) {
  if (shouldSuppressIdle(sessionId)) {
    ctx.logger.info("idle suppressed - session was aborted", { sessionId });
    return;
  }
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `session.idle:${sessionId}`, ttlMs: 5e3 });
  if (!claimed) return;
  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const message = title ? `Agent has finished: ${title}` : "Agent has finished.";
  try {
    await ctx.bot.sendMessage(message);
    ctx.sessionTitleService.clearDeferredIdleNotification(sessionId);
    ctx.logger.info("idle notification sent", { sessionId, title });
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}
async function flushDeferredParentIfReady(parentID, ctx) {
  if (!ctx.sessionTitleService.hasDeferredIdleNotification(parentID)) return;
  if (ctx.sessionTitleService.hasUnfinishedDescendants(parentID)) return;
  ctx.logger.info("sending deferred parent idle notification", { sessionId: parentID });
  await sendIdleNotification(parentID, ctx);
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
  if (ctx.sessionTitleService.hasUnfinishedDescendants(sessionId)) {
    ctx.sessionTitleService.deferIdleNotification(sessionId);
    ctx.logger.info("deferring parent idle notification - child sessions still running", { sessionId });
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

// src/events/session-error.ts
function isEventSessionError(event) {
  return event.type === "session.error";
}
async function handleSessionError(event, ctx) {
  if (event.properties.error?.name !== "MessageAbortedError") return;
  noteAbort(event.properties.sessionID);
  ctx.logger.info("session abort recorded", { sessionId: event.properties.sessionID ?? "global" });
}

// src/events/session-created.ts
async function handleSessionCreated(event, ctx) {
  ctx.sessionTitleService.setSessionInfo(event.properties.info);
}

// src/events/session-updated.ts
async function handleSessionUpdated(event, ctx) {
  const info = event.properties.info;
  ctx.sessionTitleService.setSessionInfo(info);
}

// src/events/permission-updated.ts
async function handlePermissionUpdated(event, ctx) {
  const permission = event.properties;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `permission.updated:${permission.id}` });
  if (!claimed) return;
  const sessionTitle = ctx.sessionTitleService.getSessionTitle(permission.sessionID);
  const titleLine = sessionTitle ? `\u{1F4CB} ${sessionTitle}` : `Session: ${permission.sessionID}`;
  const message = `\u2753 Permission requested

${titleLine}

Type: ${permission.type}
Detail: ${permission.title}`;
  try {
    await ctx.bot.sendMessage(message);
  } catch (err) {
    ctx.logger.error("failed to send permission notification", { error: String(err) });
  }
}

// src/events/question-asked.ts
var QUESTION_EXPIRY_MS = 5 * 6e4;
var CALLBACK_RE = /^q:([^:]+):(\d+):(\d+|c)$/;
function isQuestionOption(value) {
  return typeof value.label === "string" && typeof value.description === "string";
}
function isQuestionInfo(value) {
  if (typeof value.question !== "string") return false;
  if (typeof value.header !== "string") return false;
  if (!Array.isArray(value.options)) return false;
  return value.options.every((option) => typeof option === "object" && option !== null && isQuestionOption(option));
}
function isEventQuestionAsked(event) {
  if (event.type !== "question.asked") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.id !== "string") return false;
  if (typeof props.sessionID !== "string") return false;
  if (!Array.isArray(props.questions)) return false;
  return props.questions.every((question) => typeof question === "object" && question !== null && isQuestionInfo(question));
}
function buildCallbackData(shortHash, questionIndex, optionIndex) {
  const data = `q:${shortHash}:${questionIndex}:${optionIndex}`;
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}
function callbackDataForQuestion(shortHash, questionIndex, question) {
  const data = question.options.map((_, optionIndex) => buildCallbackData(shortHash, questionIndex, optionIndex));
  if (question.custom !== false) data.push(buildCallbackData(shortHash, questionIndex, "c"));
  return data;
}
function questionPromptText(pending, questionIndex) {
  const question = pending.questions[questionIndex];
  const prefix = pending.questions.length > 1 ? `Question ${questionIndex + 1}/${pending.questions.length}

` : "";
  const allQuestions = pending.questions.length > 1 ? `All questions:
${pending.questions.map((q, i) => `${i + 1}. ${q.header}: ${q.question}`).join("\n")}

` : "";
  return `${allQuestions}${prefix}\u2753 ${question.header}

${question.question}`;
}
function answerSummary(questions, answers) {
  return answers.map((answer, index) => `${index + 1}. ${questions[index]?.header ?? "Question"}: ${answer.join(", ") || "(empty)"}`).join("\n");
}
async function editPromptForQuestion(ctx, pending, shortHash, questionIndex) {
  const messageId = pending.telegramMessageIds[0];
  const question = pending.questions[questionIndex];
  const inlineKeyboard = question.options.map((option, optionIndex) => [{
    text: option.label,
    callback_data: buildCallbackData(shortHash, questionIndex, optionIndex)
  }]);
  if (question.custom !== false) {
    inlineKeyboard.push([{ text: "\u270F\uFE0F Custom answer", callback_data: buildCallbackData(shortHash, questionIndex, "c") }]);
  }
  await ctx.bot.editMessageText(messageId, questionPromptText(pending, questionIndex), { reply_markup: { inline_keyboard: inlineKeyboard } });
}
async function completeIfReady(ctx, pending, shortHash) {
  const nextIndex = pending.answersInProgress.findIndex((answer) => answer === void 0);
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
    await ctx.bot.editMessageRemoveKeyboard(messageId, `\u2705 Answered:
${answerSummary(pending.questions, answers)}`);
    ctx.logger.info("question reply sent", { requestID: pending.requestID, sessionID: pending.sessionID });
  } catch (err) {
    await ctx.bot.editMessageRemoveKeyboard(messageId, "\u26A0\uFE0F Failed to send answer to opencode");
    ctx.logger.error("failed to send question reply", { error: String(err), requestID: pending.requestID });
  } finally {
    await ctx.pendingQuestions.deletePending(shortHash);
  }
}
async function expirePending(ctx, shortHash, pending, messageId) {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "\u23F1 Question expired");
  await ctx.pendingQuestions.deletePending(shortHash);
  ctx.logger.info("pending question expired", { requestID: pending.requestID });
}
async function handleQuestionAsked(event, ctx) {
  const request = event.properties;
  if (request.questions.length === 0) return;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `question.asked:${request.id}`, ttlMs: 5e3 });
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
    answersInProgress: request.questions.map(() => void 0)
  };
  try {
    const message = request.questions.length === 1 ? await ctx.bot.sendQuestionWithKeyboard(firstQuestion, callbackDataForQuestion(shortHash, 0, firstQuestion)) : await ctx.bot.sendMessage(questionPromptText(pending, 0), {
      reply_markup: {
        inline_keyboard: firstQuestion.options.map((option, optionIndex) => [{
          text: option.label,
          callback_data: buildCallbackData(shortHash, 0, optionIndex)
        }]).concat(firstQuestion.custom !== false ? [[{ text: "\u270F\uFE0F Custom answer", callback_data: buildCallbackData(shortHash, 0, "c") }]] : [])
      }
    });
    pending.telegramMessageIds = [message.message_id];
    await ctx.pendingQuestions.savePending(shortHash, pending);
    ctx.logger.info("question prompt sent", { requestID: request.id, sessionID: request.sessionID, count: request.questions.length });
  } catch (err) {
    ctx.logger.error("failed to send question prompt", { error: String(err), requestID: request.id });
  }
}
function createQuestionDispatcher(ctx) {
  return {
    async handleCallbackQuery(data, messageId, chatId, userId) {
      const match = CALLBACK_RE.exec(data);
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
        await expirePending(ctx, shortHash, pending, messageId);
        return;
      }
      const question = pending.questions[questionIndex];
      if (!question) return;
      if (selection === "c") {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "\u270F\uFE0F Reply to the next message with your custom answer.");
        const prompt = await ctx.bot.replyWithForceReply("Type your custom answer", "Type your answer");
        pending.awaitingCustomFor = { shortHash, questionIndex, chatId, userId, promptMessageId: prompt.message_id };
        await ctx.pendingQuestions.savePending(shortHash, pending);
        return;
      }
      const option = question.options[Number(selection)];
      if (!option) return;
      if (question.multiple === true) {
        ctx.logger.info("multiple-choice question handled as single-select", { requestID: pending.requestID, questionIndex });
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
        await expirePending(ctx, match.shortHash, match.data, match.data.telegramMessageIds[0]);
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

// src/telegram-remote.ts
var pluginDir = dirname3(fileURLToPath(import.meta.url));
var TelegramRemote = async (input) => {
  const logger = createLogger({ namespace: "telegram" });
  try {
    const envResult = loadPluginEnv({ pluginDir });
    logger.info("env loaded", { from: envResult.loadedFrom });
    const config = loadConfig({ logger, env: process.env });
    const stateStore = createStateStore();
    const initialState = await stateStore.read();
    const tokenHash = createHash3("sha256").update(config.botToken).digest("hex").slice(0, 16);
    const lockPath = join5(tmpdir3(), `opencoder-telegram-${tokenHash}.lock`);
    const claimsDir = join5(tmpdir3(), `opencoder-telegram-claims-${tokenHash}`);
    const pendingQuestions = createPendingQuestionStore({ tokenHash });
    const lockResult = await acquireLock({ lockPath });
    const isLeader = lockResult.acquired;
    logger.info(
      `lock ${isLeader ? "acquired - leader mode" : "held by other - pass-through mode"}`,
      isLeader ? {} : { reason: lockResult.reason }
    );
    logger.info("server url", { url: input.serverUrl.toString(), href: input.serverUrl.href, origin: input.serverUrl.origin });
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
      replyToQuestion
    };
    if (isLeader) {
      bot.setQuestionDispatcher(createQuestionDispatcher(ctx));
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
    logger.error("plugin initialization failed", { error: err instanceof Error ? err.message : String(err) });
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
