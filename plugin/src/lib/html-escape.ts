export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function truncateForTelegram(input: string, maxChars: number, ellipsis = "…"): string {
  const single = input.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  if (maxChars <= 0) return "";
  if (ellipsis.length >= maxChars) return ellipsis.slice(0, maxChars);
  return single.slice(0, maxChars - ellipsis.length) + ellipsis;
}

export function stripCodeFences(input: string): string {
  return input
    .replace(/```[^\r\n`]*\r?\n([\s\S]*?)```/g, "$1")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
