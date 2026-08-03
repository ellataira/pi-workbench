import path from "node:path";

export const WORKSPACE_SWITCH_ENTRY = "pi-workspace-switch-v1";

const maxWorkspaceHistory = 16;

function boundedAbsolutePaths(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && path.isAbsolute(entry))
    .slice(-maxWorkspaceHistory);
}

export function currentWorkspaceState(entries, currentCwd) {
  const matching = [...entries].reverse().find(
    (entry) =>
      entry?.type === "custom" &&
      entry.customType === WORKSPACE_SWITCH_ENTRY &&
      entry.data?.current === currentCwd
  );
  return {
    current: currentCwd,
    history: boundedAbsolutePaths(matching?.data?.history)
  };
}

export function buildWorkspaceChoices(state) {
  const seen = new Set();
  const recent = [];
  for (const candidate of [...(state?.history ?? [])].reverse()) {
    if (candidate === state?.current || seen.has(candidate)) continue;
    seen.add(candidate);
    recent.push({ path: candidate, label: `Recent · ${candidate}` });
  }
  return [
    ...recent,
    { path: undefined, label: "Enter another repository path…" }
  ];
}

export async function resolveWorkspaceTarget(
  input,
  {
    cwd,
    home,
    stat,
    realpath,
    gitRoot
  }
) {
  const raw = String(input ?? "").trim();
  const requested =
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw;
  if (!requested) throw new Error("Workspace path is required");

  const expanded =
    requested === "~"
      ? home
      : requested.startsWith("~/")
        ? path.join(home, requested.slice(2))
        : requested;
  const candidate = path.resolve(cwd, expanded);

  let info;
  try {
    info = await stat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Workspace path does not exist: ${candidate}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${candidate}`);
  }

  const canonical = await realpath(candidate);
  const repository = String(await gitRoot(canonical)).trim();
  if (!repository) {
    throw new Error(`Workspace path is not inside a Git repository: ${canonical}`);
  }
  return realpath(repository);
}

export async function performWorkspaceSwitch({
  currentCwd,
  targetCwd,
  sourceSessionFile,
  history,
  back = false,
  forkSession,
  switchSession
}) {
  if (!sourceSessionFile) {
    throw new Error("Workspace switching requires a persisted Pi session");
  }
  if (path.resolve(currentCwd) === path.resolve(targetCwd)) {
    throw new Error(`Workspace is already active: ${targetCwd}`);
  }

  const prior = boundedAbsolutePaths(history);
  const nextHistory = back
    ? prior.slice(0, -1)
    : [...prior, path.resolve(currentCwd)].slice(-maxWorkspaceHistory);
  const targetSession = await forkSession(sourceSessionFile, targetCwd);
  targetSession.appendCustomEntry(WORKSPACE_SWITCH_ENTRY, {
    current: path.resolve(targetCwd),
    history: nextHistory
  });
  const targetSessionFile = targetSession.getSessionFile();
  if (!targetSessionFile) {
    throw new Error("Workspace handoff did not create a persisted target session");
  }
  return switchSession(targetSessionFile);
}
