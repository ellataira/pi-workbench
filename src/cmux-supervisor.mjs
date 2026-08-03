import path from "node:path";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function slug(value, fallback = "child") {
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

export function buildChildCommand({
  sessionId,
  name,
  task,
  parentSessionId,
  childClass = "substantial"
}) {
  const environment = [
    ["AGENT_JOURNAL_PARENT_CLIENT", "pi"],
    ["AGENT_JOURNAL_PARENT_SESSION_ID", parentSessionId],
    ["AGENT_JOURNAL_CHILD_CLASS", childClass]
  ]
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `${environment} pi --session-id ${shellQuote(sessionId)} --name ${shellQuote(name)} ${shellQuote(task)}`;
}

export function buildSpawnArguments({ name, cwd, command }) {
  return [
    "--id-format",
    "both",
    "new-workspace",
    "--name",
    name,
    "--cwd",
    cwd,
    "--command",
    command,
    "--focus",
    "false"
  ];
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
`.trim();
