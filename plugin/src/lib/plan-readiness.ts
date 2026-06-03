import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { OpencodeClient } from "../events/types.js";

export type PlanReadinessResult =
  | {
      ready: true;
      planPath: string;
      planName: string;
      total: number;
      completed: number;
      boulderActive?: boolean;
    }
  | {
      ready: false;
      reason:
        | "no-omo-dir"
        | "no-plans"
        | "all-plans-complete"
        | "plan-empty"
        | "no-session-plan";
      detail: string;
      boulderActive?: boolean;
    };

interface PlanFileCandidate {
  path: string;
  name: string;
  mtime: number;
}

interface BoulderWorkState {
  activePlan: string;
  planName?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  sessionIds: string[];
  worktreePath?: string;
}

interface BoulderState {
  activePlan?: string;
  planName?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  sessionIds: string[];
  worktreePath?: string;
  activeWorkId?: string;
  works?: Record<string, BoulderWorkState>;
}

interface BoulderReadResult {
  exists: boolean;
  state?: BoulderState;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeBoulderWork(value: JsonValue | undefined): BoulderWorkState | undefined {
  const record = asRecord(value);
  if (!record || typeof record.active_plan !== "string") return undefined;
  const work: BoulderWorkState = {
    activePlan: record.active_plan,
    sessionIds: stringArray(record.session_ids),
  };
  const planName = optionalString(record.plan_name);
  if (planName !== undefined) work.planName = planName;
  const status = optionalString(record.status);
  if (status !== undefined) work.status = status;
  const startedAt = optionalString(record.started_at);
  if (startedAt !== undefined) work.startedAt = startedAt;
  const updatedAt = optionalString(record.updated_at);
  if (updatedAt !== undefined) work.updatedAt = updatedAt;
  const worktreePath = optionalString(record.worktree_path);
  if (worktreePath !== undefined) work.worktreePath = worktreePath;
  return work;
}

function normalizeBoulderState(value: JsonValue | undefined): BoulderState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const state: BoulderState = { sessionIds: stringArray(record.session_ids) };
  const activePlan = optionalString(record.active_plan);
  if (activePlan !== undefined) state.activePlan = activePlan;
  const planName = optionalString(record.plan_name);
  if (planName !== undefined) state.planName = planName;
  const status = optionalString(record.status);
  if (status !== undefined) state.status = status;
  const startedAt = optionalString(record.started_at);
  if (startedAt !== undefined) state.startedAt = startedAt;
  const updatedAt = optionalString(record.updated_at);
  if (updatedAt !== undefined) state.updatedAt = updatedAt;
  const worktreePath = optionalString(record.worktree_path);
  if (worktreePath !== undefined) state.worktreePath = worktreePath;
  const activeWorkId = optionalString(record.active_work_id);
  if (activeWorkId !== undefined) state.activeWorkId = activeWorkId;

  const worksRecord = asRecord(record.works);
  if (worksRecord) {
    const works: Record<string, BoulderWorkState> = {};
    for (const [workId, rawWork] of Object.entries(worksRecord)) {
      const work = normalizeBoulderWork(rawWork);
      if (work) works[workId] = work;
    }
    if (Object.keys(works).length > 0) state.works = works;
  }

  return state;
}

async function readBoulderState(boulderPath: string): Promise<BoulderReadResult> {
  let text: string;
  try {
    text = await readFile(boulderPath, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    return { exists: true };
  }
  try {
    return { exists: true, state: normalizeBoulderState(JSON.parse(text) as JsonValue) };
  } catch {
    return { exists: true };
  }
}

function mirrorWorkFromState(state: BoulderState): BoulderWorkState | undefined {
  if (!state.activePlan) return undefined;
  const work: BoulderWorkState = {
    activePlan: state.activePlan,
    sessionIds: state.sessionIds,
  };
  if (state.planName !== undefined) work.planName = state.planName;
  if (state.status !== undefined) work.status = state.status;
  if (state.startedAt !== undefined) work.startedAt = state.startedAt;
  if (state.updatedAt !== undefined) work.updatedAt = state.updatedAt;
  if (state.worktreePath !== undefined) work.worktreePath = state.worktreePath;
  return work;
}

function boulderWorks(state: BoulderState): BoulderWorkState[] {
  if (state.works) return Object.values(state.works);
  const mirrorWork = mirrorWorkFromState(state);
  return mirrorWork ? [mirrorWork] : [];
}

function parseIsoToMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function findBoulderWorkForSession(
  state: BoulderState,
  sessionId: string,
): BoulderWorkState | undefined {
  const works = boulderWorks(state)
    .filter((work) => work.sessionIds.includes(sessionId))
    .sort(
      (left, right) =>
        parseIsoToMs(right.updatedAt ?? right.startedAt) -
        parseIsoToMs(left.updatedAt ?? left.startedAt),
    );
  if (works[0]) return works[0];
  const mirrorWork = mirrorWorkFromState(state);
  if (mirrorWork && state.sessionIds.includes(sessionId)) return mirrorWork;
  return undefined;
}

function isActiveBoulderWork(work: BoulderWorkState): boolean {
  return work.status !== "completed" && work.status !== "abandoned";
}

// boulder.json is a persistent ledger that is never deleted on completion, so
// its mere existence must not block start-work; only a non-terminal work does.
function boulderHasActiveWork(read: BoulderReadResult): boolean {
  if (!read.exists) return false;
  // Unparseable ledger: fail closed and treat as active to avoid duplicate runs.
  if (!read.state) return true;
  const works = boulderWorks(read.state);
  if (works.length === 0) return false;
  return works.some(isActiveBoulderWork);
}

function resolveTrackedPath(baseDirectory: string, trackedPath: string): string {
  return isAbsolute(trackedPath) ? resolve(trackedPath) : resolve(baseDirectory, trackedPath);
}

async function resolveBoulderPlanPath(
  projectRoot: string,
  work: BoulderWorkState,
): Promise<string> {
  const absolutePlanPath = resolveTrackedPath(projectRoot, work.activePlan);
  const worktreePath = work.worktreePath?.trim();
  if (!worktreePath) return absolutePlanPath;

  const relativePlanPath = relative(resolve(projectRoot), absolutePlanPath);
  if (
    relativePlanPath.length === 0 ||
    relativePlanPath.startsWith("..") ||
    isAbsolute(relativePlanPath)
  ) {
    return absolutePlanPath;
  }

  const worktreePlanPath = resolve(resolveTrackedPath(projectRoot, worktreePath), relativePlanPath);
  try {
    await access(worktreePlanPath);
    return worktreePlanPath;
  } catch {
    return absolutePlanPath;
  }
}

function planNameFromPath(planPath: string): string {
  return basename(planPath, ".md");
}

function normalizePlanToken(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function selectPlanByHint(
  candidates: PlanFileCandidate[],
  planHint: string | undefined,
): PlanFileCandidate | undefined {
  if (!planHint) return undefined;
  const normalizedHint = normalizePlanToken(planHint);
  if (!normalizedHint) return undefined;
  return candidates.find((candidate) => {
    const planName = candidate.name.replace(/\.md$/, "");
    return normalizePlanToken(planName) === normalizedHint;
  });
}

function resolvePlanPathHint(
  projectRoot: string,
  planPath: string | undefined,
): string | undefined {
  if (!planPath) return undefined;
  const resolvedPath = isAbsolute(planPath) ? resolve(planPath) : resolve(projectRoot, planPath);
  const plansRoot = resolve(projectRoot, ".omo", "plans");
  const relativePlanPath = relative(plansRoot, resolvedPath);
  if (
    !resolvedPath.endsWith(".md") ||
    relativePlanPath.length === 0 ||
    relativePlanPath.startsWith("..") ||
    isAbsolute(relativePlanPath)
  ) {
    return undefined;
  }
  return resolvedPath;
}

async function getPlanFiles(plansDir: string): Promise<PlanFileCandidate[] | undefined> {
  let planFiles: string[] = [];
  try {
    const entries = await readdir(plansDir);
    planFiles = entries.filter((e) => e.endsWith(".md"));
  } catch {
    return undefined;
  }
  if (planFiles.length === 0) return [];

  const stats = await Promise.all(
    planFiles.map(async (f) => {
      const full = join(plansDir, f);
      const s = await stat(full);
      return { path: full, name: f, mtime: s.mtime.getTime() };
    }),
  );
  return stats.sort((a, b) => b.mtime - a.mtime);
}

async function readPlanProgress(
  planPath: string,
  planName: string,
  boulderActive = false,
): Promise<PlanReadinessResult> {
  let content: string;
  try {
    content = await readFile(planPath, "utf8");
  } catch {
    return {
      ready: false,
      reason: "no-plans",
      detail: `${planPath} not found`,
      ...(boulderActive ? { boulderActive } : {}),
    };
  }

  const totalMatches = content.match(/^- \[[ xX]\]/gm) ?? [];
  const completedMatches = content.match(/^- \[[xX]\]/gm) ?? [];
  const total = totalMatches.length;
  const completed = completedMatches.length;

  if (total === 0) {
    return {
      ready: false,
      reason: "plan-empty",
      detail: `${planName}: no checkboxes found`,
      ...(boulderActive ? { boulderActive } : {}),
    };
  }
  if (completed >= total) {
    return {
      ready: false,
      reason: "all-plans-complete",
      detail: `${planName}: ${completed}/${total} complete`,
      ...(boulderActive ? { boulderActive } : {}),
    };
  }

  return {
    ready: true,
    planPath,
    planName,
    total,
    completed,
    ...(boulderActive ? { boulderActive } : {}),
  };
}

export async function checkPlanReadiness(args: {
  projectRoot: string;
  sessionId?: string;
  planHint?: string;
  planPath?: string;
  allowLatestFallback?: boolean;
}): Promise<PlanReadinessResult> {
  const { projectRoot, sessionId } = args;
  const allowLatestFallback = args.allowLatestFallback ?? sessionId === undefined;
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

  const boulder = await readBoulderState(boulderPath);
  // An active boulder no longer blocks readiness; it is surfaced via the
  // boulderActive flag for display only, so start-work proceeds regardless.
  const projectBoulderActive = boulderHasActiveWork(boulder);
  if (boulder.state && sessionId !== undefined) {
    const work = findBoulderWorkForSession(boulder.state, sessionId);
    if (work) {
      const planPath = await resolveBoulderPlanPath(projectRoot, work);
      return readPlanProgress(
        planPath,
        work.planName ?? planNameFromPath(planPath),
        isActiveBoulderWork(work),
      );
    }
  }

  const explicitPlanPath = resolvePlanPathHint(projectRoot, args.planPath);
  if (explicitPlanPath) {
    return readPlanProgress(
      explicitPlanPath,
      planNameFromPath(explicitPlanPath),
      projectBoulderActive,
    );
  }

  // Step 3: .omo/plans/*.md files?
  const stats = await getPlanFiles(plansDir);
  if (stats === undefined) {
    return {
      ready: false,
      reason: "no-plans",
      detail: `${plansDir} not found or empty`,
      ...(projectBoulderActive ? { boulderActive: true } : {}),
    };
  }
  if (stats.length === 0) {
    return {
      ready: false,
      reason: "no-plans",
      detail: `No .md files in ${plansDir}`,
      ...(projectBoulderActive ? { boulderActive: true } : {}),
    };
  }

  const hinted = selectPlanByHint(stats, args.planHint);
  if (hinted) {
    return readPlanProgress(hinted.path, hinted.name.replace(/\.md$/, ""), projectBoulderActive);
  }

  if (!allowLatestFallback) {
    return {
      ready: false,
      reason: "no-session-plan",
      detail: `No plan associated with session ${sessionId ?? "missing"}`,
      ...(projectBoulderActive ? { boulderActive: true } : {}),
    };
  }

  const latest = stats[0]!;
  return readPlanProgress(latest.path, latest.name.replace(/\.md$/, ""), projectBoulderActive);
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
