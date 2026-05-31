export function isPlanSessionAgent(agent: string | undefined): boolean {
  if (!agent) return false;
  const normalized = agent
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .trim()
    .toLowerCase();
  return (
    normalized === "plan" ||
    normalized === "prometheus" ||
    normalized === "prometheus - plan builder" ||
    normalized === "prometheus (plan builder)" ||
    (normalized.includes("prometheus") && normalized.includes("plan builder"))
  );
}
