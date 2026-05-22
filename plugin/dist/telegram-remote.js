/**
 * OpenCoder Telegram Remote Plugin
 * https://github.com/YOUR_USERNAME/opencoder-telegram-remote-plugin
 */

// src/telegram-remote.ts
import { fileURLToPath } from "url";
import { dirname as dirname2, join as join4 } from "path";
import { tmpdir as tmpdir2 } from "os";
import { createHash as createHash2 } from "crypto";

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

// src/lib/env-loader.ts
import { existsSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
import dotenv from "dotenv";
function loadPluginEnv(opts) {
  const paths = [
    join2(opts.pluginDir, "../../.env"),
    join2(opts.pluginDir, "..", ".env"),
    join2(opts.pluginDir, ".env"),
    join2(homedir2(), ".config/opencode/telegram-remote/.env")
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
    async editMessage(messageId, text) {
      const chatId = await requireChatId("editMessage");
      await bot.api.editMessageText(chatId, messageId, text);
    },
    async deleteMessage(messageId) {
      const chatId = await requireChatId("deleteMessage");
      await bot.api.deleteMessage(chatId, messageId);
    },
    async getActiveChatId() {
      if (activeChatId) return activeChatId;
      const state = await stateStore.read();
      return state.chatId;
    }
  };
}

// src/services/session-title-service.ts
var SessionTitleService = class {
  sessionTitles = /* @__PURE__ */ new Map();
  setSessionTitle(sessionId, title) {
    this.sessionTitles.set(sessionId, title);
  }
  getSessionTitle(sessionId) {
    return this.sessionTitles.get(sessionId) ?? null;
  }
};

// src/lib/claim.ts
import { mkdir as mkdir2, open as open2, readdir, stat as stat2, unlink as unlink2 } from "fs/promises";
import { join as join3 } from "path";
import { createHash } from "crypto";
var DEFAULT_TTL_MS2 = 6e4;
var sweptDirs = /* @__PURE__ */ new Set();
function hasCode3(err, code) {
  return "code" in err && err.code === code;
}
function claimPath(claimsDir, key) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join3(claimsDir, `${hash}.claim`);
}
async function sweep(claimsDir, ttlMs) {
  if (sweptDirs.has(claimsDir)) return;
  sweptDirs.add(claimsDir);
  try {
    const entries = await readdir(claimsDir, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".claim")).map(async (entry) => {
      const filePath = join3(claimsDir, entry.name);
      try {
        const fileStat = await stat2(filePath);
        if (Date.now() - fileStat.mtimeMs > ttlMs * 2) {
          await unlink2(filePath);
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
  await mkdir2(opts.claimsDir, { recursive: true });
  await sweep(opts.claimsDir, ttlMs);
  const filePath = claimPath(opts.claimsDir, opts.key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createClaim(filePath);
    } catch (err) {
      if (!(err instanceof Error) || !hasCode3(err, "EEXIST")) throw err;
      try {
        const fileStat = await stat2(filePath);
        if (Date.now() - fileStat.mtimeMs <= ttlMs || attempt === 1) return false;
        await unlink2(filePath);
      } catch (statErr) {
        if (statErr instanceof Error && hasCode3(statErr, "ENOENT")) continue;
        return false;
      }
    }
  }
  return false;
}

// src/events/session-idle.ts
async function handleSessionIdle(event, ctx) {
  const sessionId = event.properties.sessionID;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: `session.idle:${sessionId}`, ttlMs: 5e3 });
  if (!claimed) return;
  const title = ctx.sessionTitleService.getSessionTitle(sessionId);
  const message = title ? `Agent has finished: ${title}` : "Agent has finished.";
  try {
    await ctx.bot.sendMessage(message);
    ctx.logger.info("idle notification sent", { sessionId, title });
  } catch (err) {
    ctx.logger.error("failed to send idle notification", { error: String(err) });
  }
}

// src/events/session-updated.ts
async function handleSessionUpdated(event, ctx) {
  const info = event.properties.info;
  if (info.title && info.id) {
    ctx.sessionTitleService.setSessionTitle(info.id, info.title);
  }
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
function isEventQuestionAsked(event) {
  if (event.type !== "question.asked") return false;
  const props = event.properties;
  if (!props || typeof props.sessionID !== "string") return false;
  if (!Array.isArray(props.questions)) return false;
  return true;
}
async function handleQuestionAsked(event, ctx) {
  const { sessionID, questions } = event.properties;
  if (questions.length === 0) return;
  const claimed = await claimOnce({
    claimsDir: ctx.claimsDir,
    key: `question.asked:${sessionID}:${questions.length}`,
    ttlMs: 5e3
  });
  if (!claimed) return;
  const title = ctx.sessionTitleService.getSessionTitle(sessionID);
  const titleLine = title ? `\u{1F4CB} ${title}` : `Session: ${sessionID}`;
  const questionLines = questions.map((q, i) => `${i + 1}. ${q.header ? `${q.header}: ` : ""}${q.question}`).join("\n");
  const message = `${titleLine}

\u2753 Questions:
${questionLines}`;
  try {
    await ctx.bot.sendMessage(message);
    ctx.logger.info("question notification sent", { sessionID, count: questions.length });
  } catch (err) {
    ctx.logger.error("failed to send question notification", { error: String(err) });
  }
}

// src/telegram-remote.ts
var pluginDir = dirname2(fileURLToPath(import.meta.url));
var TelegramRemote = async (input) => {
  const logger = createLogger({ namespace: "telegram" });
  try {
    const envResult = loadPluginEnv({ pluginDir });
    logger.info("env loaded", { from: envResult.loadedFrom });
    const config = loadConfig({ logger, env: process.env });
    const stateStore = createStateStore();
    const initialState = await stateStore.read();
    const tokenHash = createHash2("sha256").update(config.botToken).digest("hex").slice(0, 16);
    const lockPath = join4(tmpdir2(), `opencoder-telegram-${tokenHash}.lock`);
    const claimsDir = join4(tmpdir2(), `opencoder-telegram-claims-${tokenHash}`);
    const lockResult = await acquireLock({ lockPath });
    const isLeader = lockResult.acquired;
    logger.info(
      `lock ${isLeader ? "acquired - leader mode" : "held by other - pass-through mode"}`,
      isLeader ? {} : { reason: lockResult.reason }
    );
    const sessionTitleService = new SessionTitleService();
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
      claimsDir
    };
    return {
      event: async ({ event }) => {
        switch (event.type) {
          case "session.idle":
            return handleSessionIdle(event, ctx);
          case "session.status":
            logger.info("session.status received", { statusType: event.properties.status.type });
            if (event.properties.status.type === "idle") {
              return handleSessionIdle(event, ctx);
            }
            return;
          case "session.updated":
            return handleSessionUpdated(event, ctx);
          case "permission.updated":
            return handlePermissionUpdated(event, ctx);
          default: {
            const asUnknown = event;
            if (isEventQuestionAsked(asUnknown)) {
              return handleQuestionAsked(asUnknown, ctx);
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
