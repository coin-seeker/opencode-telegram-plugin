import type { EventPermissionUpdated, Permission } from "@opencode-ai/sdk";
import type { EventPermissionAsked, PermissionRequest } from "@opencode-ai/sdk/v2";
import { claimOnce } from "../lib/claim.js";
import { createPermissionShortHash, type PendingPermissionState, type PermissionReply } from "../lib/pending-permissions.js";
import type { TelegramPermissionDispatcher } from "../bot.js";
import type { EventHandlerContext } from "./types.js";

const PERMISSION_EXPIRY_MS = 5 * 60_000;
const CALLBACK_RE = /^p:([^:]+):(o|a|r)$/;

interface NormalizedPermissionRequest {
  requestID: string;
  sessionID: string;
  title: string;
  permission: string;
  patterns: string[];
  always: string[];
  endpoint: "request" | "session";
  claimKey: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isEventPermissionAsked(event: { type: string; properties?: Record<string, unknown> }): event is EventPermissionAsked {
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
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("Telegram callback_data exceeds 64 bytes");
  return data;
}

function normalizeUpdated(permission: Permission): NormalizedPermissionRequest {
  const pattern = permission.pattern === undefined ? [] : Array.isArray(permission.pattern) ? permission.pattern : [permission.pattern];
  return {
    requestID: permission.id,
    sessionID: permission.sessionID,
    title: permission.title,
    permission: permission.type,
    patterns: pattern,
    always: [],
    endpoint: "session",
    claimKey: `permission.updated:${permission.id}`,
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
    claimKey: `permission.asked:${permission.id}`,
  };
}

function permissionMessage(permission: NormalizedPermissionRequest, sessionTitle: string | undefined): string {
  const titleLine = sessionTitle ? `📋 ${sessionTitle}` : `Session: ${permission.sessionID}`;
  const patterns = permission.patterns.length > 0 ? `\nPatterns: ${permission.patterns.join(", ")}` : "";
  const always = permission.always.length > 0 ? `\nAlways options: ${permission.always.join(", ")}` : "";
  return `❓ Permission requested\n\n${titleLine}\n\nPermission: ${permission.permission}\nDetail: ${permission.title}${patterns}${always}`;
}

function permissionKeyboard(shortHash: string): Array<Array<{ text: string; callback_data: string }>> {
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

function replyLabel(reply: PermissionReply): string {
  if (reply === "once") return "Allowed once";
  if (reply === "always") return "Always allowed";
  return "Rejected";
}

async function handleNormalizedPermission(permission: NormalizedPermissionRequest, ctx: EventHandlerContext): Promise<void> {
  const claimed = await claimOnce({ claimsDir: ctx.claimsDir, key: permission.claimKey });
  if (!claimed) return;

  const shortHash = createPermissionShortHash(permission.requestID);
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
      title: permission.title,
      permission: permission.permission,
      patterns: permission.patterns,
      always: permission.always,
      sentAt,
      expiresAt: sentAt + PERMISSION_EXPIRY_MS,
      telegramMessageId: message.message_id,
      endpoint: permission.endpoint,
    };
    await ctx.pendingPermissions.savePending(shortHash, pending);
  } catch (err) {
    ctx.logger.error("failed to send permission notification", { error: String(err) });
  }
}

async function expirePending(ctx: EventHandlerContext, shortHash: string, pending: PendingPermissionState, messageId: number): Promise<void> {
  await ctx.bot.editMessageRemoveKeyboard(messageId, "⏱ Permission request expired");
  await ctx.pendingPermissions.deletePending(shortHash);
  ctx.logger.info("pending permission expired", { requestID: pending.requestID });
}

export async function handlePermissionUpdated(event: EventPermissionUpdated, ctx: EventHandlerContext): Promise<void> {
  await handleNormalizedPermission(normalizeUpdated(event.properties), ctx);
}

export async function handlePermissionAsked(event: EventPermissionAsked, ctx: EventHandlerContext): Promise<void> {
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

export function isEventPermissionReplied(event: { type: string; properties?: Record<string, unknown> }): event is PermissionRepliedEvent {
  if (event.type !== "permission.replied") return false;
  const props = event.properties;
  if (!props) return false;
  if (typeof props.sessionID !== "string") return false;
  const hasId =
    typeof (props as { permissionID?: unknown }).permissionID === "string" ||
    typeof (props as { requestID?: unknown }).requestID === "string";
  return hasId;
}

function externalReplyLabel(value: string | undefined): string {
  if (value === "once") return "Allowed once in opencode";
  if (value === "always") return "Always allowed in opencode";
  if (value === "reject") return "Rejected in opencode";
  return "Already answered in opencode";
}

export async function handlePermissionReplied(event: PermissionRepliedEvent, ctx: EventHandlerContext): Promise<void> {
  const requestID = event.properties.requestID ?? event.properties.permissionID;
  if (!requestID) return;
  const found = await ctx.pendingPermissions.findByRequestID(requestID);
  if (!found) return;
  const label = externalReplyLabel(event.properties.reply ?? event.properties.response);
  try {
    await ctx.bot.editMessageRemoveKeyboard(
      found.data.telegramMessageId,
      `✅ ${label}\n\n${found.data.permission}: ${found.data.title}`,
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
          pending.serverUrl,
        );
        await ctx.bot.editMessageRemoveKeyboard(messageId, `✅ Permission ${replyLabel(reply)}\n\n${pending.permission}: ${pending.title}`);
        ctx.logger.info("permission reply sent", { requestID: pending.requestID, sessionID: pending.sessionID, reply });
      } catch (err) {
        await ctx.bot.editMessageRemoveKeyboard(messageId, "⚠️ Failed to send permission reply to opencode");
        ctx.logger.error("failed to send permission reply", { error: String(err), requestID: pending.requestID });
      } finally {
        await ctx.pendingPermissions.deletePending(shortHash);
      }
    },
  };
}
