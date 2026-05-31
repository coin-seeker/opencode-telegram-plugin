export function isPlanSessionAgent(agent: string | undefined): boolean {
  if (!agent) return false;
  const normalized = agent.trim().replace(/[–—]/g, "-").replace(/\s+/g, " ").toLowerCase();
  return (
    normalized === "plan" ||
    normalized === "prometheus" ||
    normalized === "prometheus - plan builder" ||
    normalized === "prometheus (plan builder)"
  );
}
