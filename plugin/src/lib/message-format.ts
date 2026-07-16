import { escapeHtml } from "./html-escape.js";

/**
 * Shared Telegram notice layout. Every user-facing message follows:
 *
 *   {emoji} <b>{title}</b>
 *
 *   {body line}
 *   {body line}
 *
 * Body lines are joined with a single newline; pass pre-escaped HTML
 * (use `field()` for label/value pairs). Empty lines are dropped.
 */
export function notice(emoji: string, title: string, ...bodyLines: string[]): string {
  const header = `${emoji} <b>${escapeHtml(title)}</b>`;
  const body = bodyLines.filter((line) => line !== "").join("\n");
  return body ? `${header}\n\n${body}` : header;
}

/** `<b>{label}</b>: {value}` with the value HTML-escaped. */
export function field(label: string, value: string): string {
  return `<b>${escapeHtml(label)}</b>: ${escapeHtml(value)}`;
}
