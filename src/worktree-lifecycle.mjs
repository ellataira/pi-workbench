export function classifyOwnedWorktree(child, facts) {
  let status;
  if (facts.workspaceKnown === false) status = "unknown";
  else if (!facts.pathExists) status = "missing";
  else if (facts.workspaceAlive && facts.dirty) status = "dirty-active";
  else if (facts.dirty) status = "dirty-orphaned";
  else if (facts.merged) status = "merged";
  else if (facts.workspaceAlive) status = "active";
  else status = "orphaned";
  return {
    sessionId: child.sessionId,
    name: child.name,
    branch: child.branch,
    worktreePath: child.worktreePath,
    status,
    workspaceKnown: facts.workspaceKnown !== false,
    workspaceAlive: Boolean(facts.workspaceAlive),
    dirty: Boolean(facts.dirty),
    merged: Boolean(facts.merged)
  };
}

export function cleanupEligibility(facts) {
  if (facts.workspaceKnown === false) {
    return {
      allowed: false,
      reason: "Cannot verify cmux workspace liveness from this process."
    };
  }
  if (facts.workspaceAlive) {
    return { allowed: false, reason: "The child workspace is still active." };
  }
  if (!facts.pathExists) {
    return { allowed: false, reason: "The registered worktree path is missing; recover the registry first." };
  }
  if (facts.dirty) {
    return { allowed: false, reason: "The child has uncommitted changes." };
  }
  if (!facts.merged) {
    return { allowed: false, reason: "The child branch is not merged into the repository HEAD." };
  }
  return { allowed: true };
}

export function recoveryPlan(child) {
  if (!child?.sessionId || !child?.worktreePath) {
    throw new Error("Recovery requires a session ID and worktree path");
  }
  return {
    sessionId: child.sessionId,
    name: child.name || `child-${child.sessionId.slice(0, 8)}`,
    cwd: child.worktreePath
  };
}
