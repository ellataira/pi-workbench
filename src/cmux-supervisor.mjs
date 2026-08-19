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
  task
}) {
  return [
    `AGENT_JOURNAL_PARENT_CLIENT=pi`,
    `AGENT_JOURNAL_PARENT_SESSION_ID=${parentSessionId}`,
    `AGENT_JOURNAL_CHILD_CLASS=substantial`,
    `PI_CMUX_FORK_SESSION_FILE=${sessionFile}`,
    ...(task ? [`PI_CMUX_FORK_TASK=${task}`] : [])
  ];
}

export function buildChildEnvironment({
  sessionId,
  name,
  task,
  parentSessionId,
  childClass = "substantial"
}) {
  return [
    `AGENT_JOURNAL_PARENT_CLIENT=pi`,
    `AGENT_JOURNAL_PARENT_SESSION_ID=${parentSessionId}`,
    `AGENT_JOURNAL_CHILD_CLASS=${childClass}`,
    `PI_CMUX_CHILD_SESSION_ID=${sessionId}`,
    `PI_CMUX_CHILD_NAME=${name}`,
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
- Never delegate merely to avoid doing a straightforward task.
- When the user explicitly asks to start work in a /fork, create a detached fork in a new cmux tab; never substitute a background subagent.
- After launching a detached /fork, do not continue that task in the parent session.
`.trim();
