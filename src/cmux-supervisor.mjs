import path from "node:path";

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
  const toolName = typeof value.toolName === "string"
    ? value.toolName.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80)
    : "";
  return {
    version: 1,
    sessionId: value.sessionId.slice(0, 160),
    phase: value.phase,
    ...(toolName ? { toolName } : {}),
    updatedAt: new Date(timestamp).toISOString()
  };
}

function childActivityLabel(updatedAt, now) {
  const ageMs = Math.max(0, now - Date.parse(updatedAt));
  if (ageMs < 10_000) return "active now";
  const age = ageMs < 60_000
    ? `${Math.floor(ageMs / 1000)}s ago`
    : ageMs < 3_600_000
      ? `${Math.floor(ageMs / 60_000)}m ago`
      : `${Math.floor(ageMs / 3_600_000)}h ago`;
  return ageMs >= 15_000 ? `heartbeat stale · ${age}` : age;
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
  { now = Date.now(), limit = 4, screenTailBySessionId = new Map() } = {}
) {
  const visible = (Array.isArray(children) ? children : [])
    .map((child) => ({ child, progress: progressBySessionId?.get(child.sessionId) ?? null }))
    .filter(({ progress }) => progress?.phase !== "stopped")
    .slice(0, Math.max(1, limit));
  if (!visible.length) return [];
  const lines = [
    `Agent map · supervisor (this tab) · ${visible.length} active child${visible.length === 1 ? "" : "ren"}`
  ];
  for (const [index, { child, progress }] of visible.entries()) {
    const activity = progress?.updatedAt
      ? childActivityLabel(progress.updatedAt, now)
      : "startup pending";
    const tree = index === visible.length - 1 ? "└─" : "├─";
    lines.push(`${tree} ${child.name} · ${childPhaseLabel(progress)} · ${activity}`);
    lines.push(`   open: /agents focus ${child.name} · follow: /agents watch ${child.name}`);
    lines.push(`   ${child.branch || child.cwd || "isolated workspace"}`);
    for (const line of screenTailBySessionId.get(child.sessionId) ?? []) {
      lines.push(`   ↳ ${line}`);
    }
  }
  lines.push("Child tabs return here with /agents parent");
  return lines;
}

export function formatChildIdentityLines(name = "delegated agent") {
  return [
    `Agent map · child: ${String(name).trim() || "delegated agent"} (this tab)`,
    "Return to supervisor · /agents parent",
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

export function buildAgentChoices(children = []) {
  return [
    {
      action: "persistent",
      label: "Start persistent implementation agent…"
    },
    {
      action: "background",
      label: "Fan out a lightweight task…"
    },
    ...children.map((child) => ({
      action: "child",
      sessionId: child.sessionId,
      label: `${String(child.status ?? "unknown").replace(/^./, (value) => value.toUpperCase())} · ${child.name} · ${child.cwd}`
    }))
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
- Before delegating, tell the user which named child will work and why. After launch, report its branch/worktree plus /agents focus <name> for live output and /agents status <name> for metadata-only progress.
- Never leave the parent looking idle while a child works: keep the delegated-work widget visible and summarize child completion or failure promptly.
- Never delegate merely to avoid doing a straightforward task.
- When the user explicitly asks to start work in a /fork, create a detached fork in a new cmux tab; never substitute a background subagent.
- After launching a detached /fork, do not continue that task in the parent session.
`.trim();
