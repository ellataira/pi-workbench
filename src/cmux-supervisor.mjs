import path from "node:path";
import os from "node:os";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function slug(value, fallback = "child") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

export function childWorktreePlan({
  repoRoot,
  worktreeBaseDir,
  name,
  sessionId
}) {
  const suffix = String(sessionId).slice(0, 8);
  const label = `${slug(name)}-${suffix}`;
  return {
    branch: `pi/${label}`,
    path: path.join(worktreeBaseDir, path.basename(repoRoot), label)
  };
}

export function buildWorktreeArguments({ branch, path: worktreePath, baseRef = "HEAD" }) {
  return ["worktree", "add", "-b", branch, worktreePath, baseRef];
}

export function parseWorkspaceIdentifiers(output) {
  const text = String(output ?? "");
  const workspaceRef = text.match(/\bworkspace:\d+\b/)?.[0];
  const uuid = text.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
  )?.[0];
  const identifiers = [workspaceRef, uuid].filter(Boolean);
  if (identifiers.length === 0) {
    throw new Error(`cmux did not return a workspace identifier: ${text.trim() || "<empty>"}`);
  }
  return identifiers;
}

export function parseWorkspaceRefs(output) {
  return [...new Set(String(output ?? "").match(/\bworkspace:\d+\b/g) ?? [])];
}

export function supervisorWorkspaceCandidates(output, children, currentWorkspace) {
  const childWorkspaces = new Set(
    (Array.isArray(children) ? children : [])
      .flatMap((child) => Array.isArray(child.identifiers) ? child.identifiers : [])
  );
  if (currentWorkspace) childWorkspaces.add(currentWorkspace);
  return parseWorkspaceRefs(output).filter((workspace) => !childWorkspaces.has(workspace));
}

export function requireOwnedWorkspace(entries, workspace) {
  const entry = entries.find((candidate) => candidate.identifiers?.includes(workspace));
  if (!entry) {
    throw new Error(`Workspace ${workspace} is not owned by this Pi supervisor`);
  }
  return entry;
}

const CHILD_PROGRESS_PHASES = new Set([
  "starting",
  "thinking",
  "tool",
  "waiting",
  "failed",
  "stopped"
]);

export function normalizeChildProgress(value) {
  if (!value || value.version !== 1 || typeof value.sessionId !== "string") return null;
  if (!CHILD_PROGRESS_PHASES.has(value.phase)) return null;
  const timestamp = Date.parse(value.updatedAt);
  if (!Number.isFinite(timestamp)) return null;
  const lastUserInputTimestamp = Date.parse(value.lastUserInputAt);
  const toolName = typeof value.toolName === "string"
    ? value.toolName.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80)
    : "";
  return {
    version: 1,
    sessionId: value.sessionId.slice(0, 160),
    phase: value.phase,
    ...(toolName ? { toolName } : {}),
    ...(Number.isFinite(lastUserInputTimestamp)
      ? { lastUserInputAt: new Date(lastUserInputTimestamp).toISOString() }
      : {}),
    updatedAt: new Date(timestamp).toISOString()
  };
}

function sanitizeTempScopeSegment(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
}

export function backgroundSubagentRoot({
  env = process.env,
  tmpdir = os.tmpdir,
  getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
  userInfo = os.userInfo,
  homedir = os.homedir
} = {}) {
  const configured = env.PI_SUBAGENTS_TEMP_ROOT;
  if (configured) return path.join(configured, "async-subagent-runs");
  let scope = "";
  if (typeof getuid === "function") {
    scope = `uid-${getuid()}`;
  } else {
    try {
      scope = `user-${userInfo().username}`;
    } catch {
      scope = `home-${homedir()}`;
    }
  }
  return path.join(tmpdir(), `pi-subagents-${sanitizeTempScopeSegment(scope)}`, "async-subagent-runs");
}

function normalizeBackgroundTimestamp(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function backgroundProgressLabel(value) {
  const steps = Array.isArray(value?.steps) ? value.steps : [];
  if (Number.isInteger(value?.currentStep) && Number.isInteger(value?.chainStepCount) && value.chainStepCount > 0) {
    return `step ${value.currentStep + 1}/${value.chainStepCount}`;
  }
  if (!steps.length) return "";
  const counts = new Map();
  for (const step of steps) {
    const status = typeof step?.status === "string" ? step.status : "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const running = counts.get("running") ?? 0;
  const total = steps.length;
  if (running) return `${running}/${total} running`;
  const failed = counts.get("failed") ?? 0;
  if (failed) return `${failed}/${total} failed`;
  const completed = counts.get("completed") ?? 0;
  if (completed) return `${completed}/${total} done`;
  return `${total} step${total === 1 ? "" : "s"}`;
}

export function normalizeBackgroundSubagentRun(value) {
  if (!value || typeof value.runId !== "string") return null;
  const updatedAt = normalizeBackgroundTimestamp(value.lastUpdate ?? value.updatedAt ?? value.startedAt);
  if (!updatedAt) return null;
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const agents = [...new Set(steps
    .map((step) => typeof step?.agent === "string" ? step.agent : typeof step?.label === "string" ? step.label : "")
    .map((agent) => agent.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 60))
    .filter(Boolean))]
    .slice(0, 4);
  const currentTool = steps
    .map((step) => typeof step?.currentTool === "string" ? step.currentTool : "")
    .find(Boolean);
  return {
    id: value.runId.slice(0, 160),
    state: typeof value.state === "string" ? value.state.slice(0, 40) : "unknown",
    ...(typeof value.mode === "string" ? { mode: value.mode.slice(0, 40) } : {}),
    ...(agents.length ? { agents } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd.slice(0, 240) } : {}),
    ...(currentTool ? { currentTool: currentTool.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80) } : {}),
    ...(backgroundProgressLabel(value) ? { progress: backgroundProgressLabel(value) } : {}),
    updatedAt
  };
}

function childActivityLabel(progress, now) {
  const updatedAt = progress?.updatedAt;
  const ageMs = Math.max(0, now - Date.parse(updatedAt));
  const answeredAt = Date.parse(progress?.lastUserInputAt);
  const answeredMs = Number.isFinite(answeredAt) ? now - answeredAt : Infinity;
  const prefix = answeredMs >= 0 && answeredMs < 15 * 60_000 ? "answered in child · " : "";
  if (ageMs < 10_000) return `${prefix}active now`;
  const age = ageMs < 60_000
    ? `${Math.floor(ageMs / 1000)}s ago`
    : ageMs < 3_600_000
      ? `${Math.floor(ageMs / 60_000)}m ago`
      : `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${prefix}${ageMs >= 15_000 ? `heartbeat stale · ${age}` : age}`;
}

function childPhaseLabel(progress) {
  if (!progress) return "starting";
  if (progress.phase === "tool") return `working: ${progress.toolName || "tool"}`;
  if (progress.phase === "thinking") return "thinking";
  if (progress.phase === "waiting") return "waiting for review or steering";
  if (progress.phase === "failed") return "needs attention";
  return progress.phase;
}

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const SECRET_VALUE = /(\b(?:api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*(?:bearer\s+)?)([^\s]+)/gi;
const TOKEN_VALUE = /\b(?:sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|xox[baprs]-[a-z0-9-]{12,})\b/gi;

export function childScreenTail(
  value,
  { maxLines = 3, maxLineChars = 160 } = {}
) {
  const lines = String(value ?? "")
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim())
    .filter(Boolean)
    .filter((line) => !/^[─━═_\-=\s]+$/.test(line))
    .filter((line) => line !== ">")
    .filter((line) => !(line.includes("think:") && /\b\d+(?:\.\d+)?%/.test(line)))
    .map((line) => line
      .replace(SECRET_VALUE, "$1[redacted]")
      .replace(TOKEN_VALUE, "[redacted]")
      .slice(0, Math.max(1, maxLineChars)));
  return lines.slice(-Math.max(1, maxLines));
}

export function formatChildProgressLines(
  children,
  progressBySessionId,
  { now = Date.now(), limit = 4, screenTailBySessionId = new Map(), backgroundRuns = [] } = {}
) {
  const visible = (Array.isArray(children) ? children : [])
    .map((child) => ({ child, progress: progressBySessionId?.get(child.sessionId) ?? null }))
    .filter(({ progress }) => progress?.phase !== "stopped")
    .slice(0, Math.max(1, limit));
  const visibleBackground = (Array.isArray(backgroundRuns) ? backgroundRuns : [])
    .filter((run) => run && !["completed", "failed", "cancelled", "stopped"].includes(run.state))
    .slice(0, Math.max(0, limit - visible.length));
  const total = visible.length + visibleBackground.length;
  if (!total) return [];
  const lines = [
    `Agent Center · supervisor · ${total} active agent${total === 1 ? "" : "s"}`
  ];
  const rows = [
    ...visible.map((entry) => ({ type: "child", ...entry })),
    ...visibleBackground.map((run) => ({ type: "background", run }))
  ];
  for (const [index, row] of rows.entries()) {
    const tree = index === rows.length - 1 ? "└─" : "├─";
    if (row.type === "background") {
      const activity = childActivityLabel({ updatedAt: row.run.updatedAt }, now);
      const agents = row.run.agents?.length ? ` · ${row.run.agents.join(", ")}` : "";
      const progress = row.run.progress ? ` · ${row.run.progress}` : "";
      lines.push(`${tree} background ${row.run.id.slice(0, 9)} · ${row.run.state}${progress}${agents} · ${activity}`);
      lines.push(`   ${row.run.cwd || row.run.mode || "background subagent"}`);
      lines.push("   inspect: /subagents-fleet");
      continue;
    }
    const { child, progress } = row;
    const activity = progress?.updatedAt
      ? childActivityLabel(progress, now)
      : "startup pending";
    lines.push(`${tree} ${child.name} · ${childPhaseLabel(progress)} · ${activity}`);
    lines.push(`   ${child.branch || child.cwd || "isolated workspace"}`);
    for (const line of screenTailBySessionId.get(child.sessionId) ?? []) {
      lines.push(`   ↳ ${line}`);
    }
  }
  lines.push("   manage: /agents (stays in this tab)");
  return lines;
}

export function formatChildIdentityLines(name = "delegated agent") {
  return [
    `Agent Center · ${String(name).trim() || "delegated agent"} (worker tab)`,
    "Run /agents to return to the supervisor",
    "The supervisor follows a bounded live tail automatically"
  ];
}

export function resolveOwnedChildSelector(children, selector) {
  const value = String(selector ?? "").trim();
  if (!value) throw new Error("A child name or session id is required");
  const exact = children.filter(
    (child) => child.sessionId === value || child.name === value
  );
  if (exact.length === 1) return exact[0];
  const matches = children.filter(
    (child) => child.sessionId?.startsWith(value) || child.name?.startsWith(value)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Child selector is ambiguous: ${value}`);
  throw new Error(`Unknown owned child: ${value}`);
}

export function resolveCurrentChild(children, { sessionId, cwd } = {}) {
  const entries = Array.isArray(children) ? children : [];
  return entries.find((child) => child.sessionId === sessionId)
    ?? entries.find((child) => [child.cwd, child.worktreePath].includes(cwd))
    ?? null;
}

export function buildChildCommand({ includeTask = true } = {}) {
  const task = includeTask ? `task="$PI_CMUX_CHILD_TASK"; ` : "";
  const taskArgument = includeTask ? ` "$task"` : "";
  return `${task}session="$PI_CMUX_CHILD_SESSION_ID"; name="$PI_CMUX_CHILD_NAME"; unset PI_CMUX_CHILD_TASK PI_CMUX_CHILD_SESSION_ID PI_CMUX_CHILD_NAME; exec pi --session-id "$session" --name "$name"${taskArgument}`;
}

export function buildDetachedForkCommand({ includeTask = false } = {}) {
  const task = includeTask ? `task="$PI_CMUX_FORK_TASK"; ` : "";
  const taskArgument = includeTask ? ` "$task"` : "";
  const unset = includeTask
    ? "PI_CMUX_FORK_SESSION_FILE PI_CMUX_FORK_TASK"
    : "PI_CMUX_FORK_SESSION_FILE";
  return `${task}session="$PI_CMUX_FORK_SESSION_FILE"; unset ${unset}; exec pi --session "$session"${taskArgument}`;
}

export function buildDetachedForkEnvironment({
  sessionFile,
  parentSessionId,
  parentWorkspaceId,
  childName,
  task
}) {
  return [
    `AGENT_JOURNAL_PARENT_CLIENT=pi`,
    `AGENT_JOURNAL_PARENT_SESSION_ID=${parentSessionId}`,
    `AGENT_JOURNAL_CHILD_CLASS=substantial`,
    ...(parentWorkspaceId ? [`PI_CMUX_SUPERVISOR_WORKSPACE_ID=${parentWorkspaceId}`] : []),
    ...(childName ? [`PI_CMUX_CHILD_DISPLAY_NAME=${childName}`] : []),
    `PI_CMUX_FORK_SESSION_FILE=${sessionFile}`,
    ...(task ? [`PI_CMUX_FORK_TASK=${task}`] : [])
  ];
}

export function buildChildEnvironment({
  sessionId,
  name,
  task,
  parentSessionId,
  childClass = "substantial",
  parentWorkspaceId
}) {
  return [
    `AGENT_JOURNAL_PARENT_CLIENT=pi`,
    `AGENT_JOURNAL_PARENT_SESSION_ID=${parentSessionId}`,
    `AGENT_JOURNAL_CHILD_CLASS=${childClass}`,
    `PI_CMUX_CHILD_SESSION_ID=${sessionId}`,
    `PI_CMUX_CHILD_NAME=${name}`,
    `PI_CMUX_CHILD_DISPLAY_NAME=${name}`,
    ...(parentWorkspaceId ? [`PI_CMUX_SUPERVISOR_WORKSPACE_ID=${parentWorkspaceId}`] : []),
    `PI_CMUX_CHILD_TASK=${task}`
  ];
}

export function buildShellReadyCommand(readyPath) {
  return `: > ${shellQuote(readyPath)}`;
}

export function buildSpawnArguments({ name, cwd, environment = [], focus = false }) {
  const args = [
    "--id-format",
    "both",
    "new-workspace",
    "--name",
    name,
    "--cwd",
    cwd
  ];
  for (const value of environment) args.push("--env", value);
  args.push("--focus", String(focus));
  return args;
}

export async function waitForPath(
  targetPath,
  {
    exists,
    timeoutMs = 20_000,
    intervalMs = 100,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await exists(targetPath)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child startup marker: ${targetPath}`);
    }
    await sleep(intervalMs);
  }
}

export function buildAgentChoices(children = [], backgroundRuns = []) {
  return [
    {
      action: "persistent",
      label: "Start implementation agent…"
    },
    {
      action: "background",
      label: "Run parallel task…"
    },
    ...children.map((child) => ({
      action: "child",
      sessionId: child.sessionId,
      label: `${child.name} · ${String(child.status ?? "unknown").replace(/^./, (value) => value.toUpperCase())} · ${child.worktreePath || child.cwd || child.branch || "workspace unavailable"}`
    })),
    ...(Array.isArray(backgroundRuns) ? backgroundRuns : []).map((run) => ({
      action: "background-run",
      runId: run.id,
      label: `Background subagent · ${run.id.slice(0, 9)} · ${String(run.state ?? "unknown").replace(/^./, (value) => value.toUpperCase())} · ${run.agents?.length ? run.agents.join(", ") : run.mode || "unknown"} · ${run.cwd || "workspace unavailable"}`
    }))
  ];
}

export function buildAgentCenterActions() {
  return [
    "Follow here",
    "Send instruction…",
    "Review changes…",
    "Open child tab…",
    "More…"
  ];
}

export const orchestrationPolicy = `
ORCHESTRATION POLICY
- Keep simple tasks in the parent.
- Use pi-subagents for bounded lightweight research or decomposition and keep those results inline.
- Spawn a persistent cmux child with a Pi-native session for substantial implementation, long-running validation, or work the user may want to enter and steer directly.
- Use Pi-native /tree and /resume inside every persistent child.
- Give each implementing child an isolated worktree and keep one writer per checkout.
- Cap ordinary fan-out at four concurrent children and one level of nesting.
- Give substantial children a concrete deliverable and verification contract; journal them as linked child sessions.
- Before delegating, tell the user which named child will work and why. After launch, report its branch/worktree and say that /agents manages it without leaving the supervisor tab.
- Never leave the parent looking idle while a child works: keep the delegated-work widget visible and summarize child completion or failure promptly.
- Never delegate merely to avoid doing a straightforward task.
- When the user explicitly asks to start work in a /fork, create a detached fork in a new cmux tab; never substitute a background subagent.
- After launching a detached /fork, do not continue that task in the parent session.
`.trim();
