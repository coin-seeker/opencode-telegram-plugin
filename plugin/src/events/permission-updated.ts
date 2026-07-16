import type { EventPermissionUpdated, Permission } from "@opencode-ai/sdk";
import type { EventPermissionAsked, PermissionRequest } from "@opencode-ai/sdk/v2";
import type { TelegramPermissionDispatcher } from "../bot.js";
import { claimOnce, releaseClaim } from "../lib/claim.js";
import { field, notice } from "../lib/message-format.js";
import {
  createPermissionShortHash,
  type PendingPermissionState,
  type PermissionReply,
} from "../lib/pending-permissions.js";
import type { EventHandlerContext } from "./types.js";

// No answer deadline: late Telegram replies are always forwarded and OpenCode decides whether the
// permission is still answerable. `expiresAt` only bounds file retention (sweepExpired).
const PERMISSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CALLBACK_RE = /^p:([^:]+):(o|a|r)$/;

interface NormalizedPermissionRequest {
  requestID: string;
  sessionID: string;
  title: string;
  permission: string;
  patterns: string[];
  always: string[];
  endpoint: "request" | "session";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isEventPermissionAsked(event: {
  type: string;
  properties?: Record<string, unknown>;
}): event is EventPermissionAsked {
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

function buildCallbackData(shortHash: string, reply: "o" | "a" | "r"): string {
  const data = `p:${shortHash}:${reply}`;
  if (Buffer.byteLength(data, "utf8") > 64)
    throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}

function normalizeUpdated(permission: Permission): NormalizedPermissionRequest {
  const pattern =
    permission.pattern === undefined
      ? []
      : Array.isArray(permission.pattern)
        ? permission.pattern
        : [permission.pattern];
  return {
    requestID: permission.id,
    sessionID: permission.sessionID,
    title: permission.title,
    permission: permission.type,
    patterns: pattern,
    always: [],
    endpoint: "session",
  };
}

function normalizeAsked(permission: PermissionRequest): NormalizedPermissionRequest {
  return {
    requestID: permission.id,
    sessionID: permission.sessionID,
    title: permission.patterns.join(", ") || permission.permission,
    permission: permission.permission,
    patterns: permission.patterns,
    always: permission.always,
    endpoint: "request",
  };
}

function permissionMessage(
  permission: NormalizedPermissionRequest,
  sessionTitle: string | undefined,
): string {
  return notice(
    "🔐",
    "권한 요청",
    field("세션", sessionTitle ?? permission.sessionID),
    field("권한", permission.permission),
    field("내용", permission.title),
    ...(permission.patterns.length > 0 ? [field("패턴", permission.patterns.join(", "))] : []),
  );
}

function permissionBodyLines(permission: string, title: string): string[] {
  return [field("권한", permission), field("내용", title)];
}

function permissionKeyboard(
  shortHash: string,
): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: "✅ Allow once", callback_data: buildCallbackData(shortHash, "o") }],
    [{ text: "♻️ Always allow", callback_data: buildCallbackData(shortHash, "a") }],
    [{ text: "❌ Reject", callback_data: buildCallbackData(shortHash, "r") }],
  ];
}

function replyFromSelection(selection: string): PermissionReply | undefined {
  if (selection === "o") return "once";
  if (selection === "a") return "always";
  if (selection === "r") return "reject";
  return undefined;
}

function replyNotice(reply: PermissionReply, permission: string, title: string): string {
  const heading =
    reply === "once"
      ? (["✅", "권한 허용 (1회)"] as const)
      : reply === "always"
        ? (["♻️", "권한 항상 허용"] as const)
        : (["⛔", "권한 거부"] as const);
  return notice(heading[0], heading[1], ...permissionBodyLines(permission, title));
}

async function upgradeLegacyPendingPermission(
  permission: NormalizedPermissionRequest,
  ctx: EventHandlerContext,
): Promise<void> {
  const found = await ctx.pendingPermissions.findByRequestID(
    permission.requestID,
    permission.sessionID,
    ctx.serverUrl.href,
  );
  if (!found || found.data.endpoint === "request") return;

  await ctx.pendingPermissions.savePending(found.shortHash, {
    ...found.data,
    directory: ctx.directory,
    title: permission.title,
    permission: permission.permission,
    patterns: permission.patterns,
    always: permission.always,
    endpoint: "request",
  });
  ctx.logger.info("permission pending upgraded to request endpoint", {
    requestID: permission.requestID,
    sessionID: permission.sessionID,
  });
}

async function handleNormalizedPermission(
  permission: NormalizedPermissionRequest,
  ctx: EventHandlerContext,
): Promise<void> {
  const permissionKey = `${ctx.serverUrl.href}:${permission.sessionID}:${permission.requestID}`;
  const claimKey = `permission:${permissionKey}`;
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: claimKey });
  if (!claimed) {
    if (permission.endpoint === "request") await upgradeLegacyPendingPermission(permission, ctx);
    return;
  }

  const shortHash = createPermissionShortHash(
    permission.requestID,
    permission.sessionID,
    permission.endpoint,
    ctx.serverUrl.href,
  );
  const sentAt = Date.now();
  const rawSessionTitle = ctx.sessionTitleService.getSessionTitle(permission.sessionID);
  const sessionTitle = rawSessionTitle === null ? undefined : rawSessionTitle;
  try {
    const message = await ctx.bot.sendMessage(permissionMessage(permission, sessionTitle), {
      reply_markup: { inline_keyboard: permissionKeyboard(shortHash) },
    });
    const pending: PendingPermissionState = {
      requestID: permission.requestID,
      sessionID: permission.sessionID,
      serverUrl: ctx.serverUrl.href,
      directory: ctx.directory,
      title: permission.title,
      permission: permission.permission,
      patterns: permission.patterns,
      always: permission.always,
      sentAt,
      expiresAt: sentAt + PERMISSION_RETENTION_MS,
      telegramMessageId: message.message_id,
      endpoint: permission.endpoint,
    };
    await ctx.pendingPermissions.savePending(shortHash, pending);
  } catch (err) {
    await releaseClaim({ claimsDir: ctx.claimsDir, key: claimKey });
    ctx.logger.error("failed to send permission notification", { error: String(err) });
  }
}

export async function handlePermissionUpdated(
  event: EventPermissionUpdated,
  ctx: EventHandlerContext,
): Promise<void> {
  await handleNormalizedPermission(normalizeUpdated(event.properties), ctx);
}

export async function handlePermissionAsked(
  event: EventPermissionAsked,
  ctx: EventHandlerContext,
): Promise<void> {
  await handleNormalizedPermission(normalizeAsked(event.properties), ctx);
}

interface PermissionRepliedEvent {
  type: "permission.replied";
  properties: {
    sessionID: string;
    // v1 SDK uses `permissionID`, v2 SDK uses `requestID`. We accept either.
    permissionID?: string;
    requestID?: string;
    // v1 uses `response`, v2 uses `reply`. We accept either.
    response?: string;
    reply?: string;
  };
}

export function isEventPermissionReplied(event: {
  type: string;
  properties?: Record<string, unknown>;
}): event is PermissionRepliedEvent {
  if (event.type !== "permission.replied") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.sessionID !== "string") return false;
  const hasId =
    typeof (props as { permissionID?: unknown }).permissionID === "string" ||
    typeof (props as { requestID?: unknown }).requestID === "string";
  return hasId;
}

function externalReplyTitle(value: string | undefined): string {
  if (value === "once") return "권한 허용 (1회)";
  if (value === "always") return "권한 항상 허용";
  if (value === "reject") return "권한 거부";
  return "권한 처리 완료";
}

export async function handlePermissionReplied(
  event: PermissionRepliedEvent,
  ctx: EventHandlerContext,
): Promise<void> {
  const requestID = event.properties.requestID ?? event.properties.permissionID;
  if (!requestID) return;
  const found = await ctx.pendingPermissions.findByRequestID(
    requestID,
    event.properties.sessionID,
    ctx.serverUrl.href,
  );
  if (!found) return;
  const title = externalReplyTitle(event.properties.reply ?? event.properties.response);
  try {
    await ctx.bot.editMessageRemoveKeyboard(
      found.data.telegramMessageId,
      notice(
        "✅",
        title,
        ...permissionBodyLines(found.data.permission, found.data.title),
        "OpenCode에서 직접 처리했어요.",
      ),
    );
    ctx.logger.info("permission externally replied - cleared pending", {
      requestID,
      sessionID: event.properties.sessionID,
    });
  } catch (err) {
    ctx.logger.error("failed to edit externally replied permission", {
      error: String(err),
      requestID,
    });
  } finally {
    await ctx.pendingPermissions.deletePending(found.shortHash);
  }
}

export function createPermissionDispatcher(ctx: EventHandlerContext): TelegramPermissionDispatcher {
  return {
    async handleCallbackQuery(data, messageId) {
      const match = CALLBACK_RE.exec(data);
      if (!match) return;
      const shortHash = match[1];
      const reply = replyFromSelection(match[2]);
      if (!reply) return;
      const pending = await ctx.pendingPermissions.loadPending(shortHash);
      if (!pending) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          notice("ℹ️", "만료된 요청", "이미 처리되었거나 세션이 종료된 권한 요청이에요."),
        );
        return;
      }
      try {
        await ctx.replyToPermission(
          pending.requestID,
          pending.sessionID,
          reply,
          pending.endpoint,
          pending.serverUrl,
          pending.directory,
        );
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          replyNotice(reply, pending.permission, pending.title),
        );
        ctx.logger.info("permission reply sent", {
          requestID: pending.requestID,
          sessionID: pending.sessionID,
          reply,
        });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(
          messageId,
          notice("⚠️", "권한 응답 전송 실패", "OpenCode에 응답을 전달하지 못했어요."),
        );
        ctx.logger.error("failed to send permission reply", {
          error: String(err),
          requestID: pending.requestID,
          endpoint: pending.endpoint,
          serverUrl: pending.serverUrl,
          directory: pending.directory,
        });
      } finally {
        await ctx.pendingPermissions.deletePending(shortHash);
      }
    },
  };
}
