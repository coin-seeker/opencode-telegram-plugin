import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { OpencodeClient } from "../events/types.js";

export type PlanReadinessResult =
  | {
      ready: true;
      planPath: string;
      planName: string;
      total: number;
      completed: number;
    }
  | {
      ready: false;
      reason:
        | "no-omo-dir"
        | "no-plans"
        | "all-plans-complete"
        | "plan-empty"
        | "boulder-active";
      detail: string;
    };

export async function checkPlanReadiness(args: {
  projectRoot: string;
}): Promise<PlanReadinessResult> {
  const { projectRoot } = args;
  const omoDir = join(projectRoot, ".omo");
  const plansDir = join(omoDir, "plans");
  const boulderPath = join(omoDir, "boulder.json");

  // Step 1: .omo/ exists?
  try {
    await access(omoDir);
  } catch {
    return {
      ready: false,
      reason: "no-omo-dir",
      detail: `${omoDir} does not exist`,
    };
  }

  // Step 2: boulder.json exists? → already running
  try {
    await access(boulderPath);
    return {
      ready: false,
      reason: "boulder-active",
      detail: `${boulderPath} exists`,
    };
  } catch {
    // boulder not present = good
  }

  // Step 3: .omo/plans/*.md files?
  let planFiles: string[] = [];
  try {
    const entries = await readdir(plansDir);
    planFiles = entries.filter((e) => e.endsWith(".md"));
  } catch {
    return {
      ready: false,
      reason: "no-plans",
      detail: `${plansDir} not found or empty`,
    };
  }
  if (planFiles.length === 0) {
    return {
      ready: false,
      reason: "no-plans",
      detail: `No .md files in ${plansDir}`,
    };
  }

  // Step 4: Find most recent plan by mtime
  const stats = await Promise.all(
    planFiles.map(async (f) => {
      const full = join(plansDir, f);
      const s = await stat(full);
      return { path: full, name: f, mtime: s.mtime.getTime() };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  const latest = stats[0]!;

  // Step 5: Parse checkboxes
  const content = await readFile(latest.path, "utf8");
  const totalMatches = content.match(/^- \[[ xX]\]/gm) ?? [];
  const completedMatches = content.match(/^- \[[xX]\]/gm) ?? [];
  const total = totalMatches.length;
  const completed = completedMatches.length;

  // Step 6: Evaluate
  if (total === 0) {
    return {
      ready: false,
      reason: "plan-empty",
      detail: `${latest.name}: no checkboxes found`,
    };
  }
  if (completed >= total) {
    return {
      ready: false,
      reason: "all-plans-complete",
      detail: `${latest.name}: ${completed}/${total} complete`,
    };
  }

  return {
    ready: true,
    planPath: latest.path,
    planName: latest.name.replace(/\.md$/, ""),
    total,
    completed,
  };
}

// TOCTOU re-validation: call client.session.status() and check if sessionId is idle
export async function recheckSessionIdle(
  client: OpencodeClient,
  sessionId: string,
): Promise<boolean> {
  const result = await client.session.status();
  const statuses = result.data ?? {};
  const sessionStatus = statuses[sessionId];
  return (sessionStatus?.type ?? "idle") === "idle";
}
