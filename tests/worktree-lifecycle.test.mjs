import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyOwnedWorktree,
  cleanupEligibility,
  recoveryPlan
} from "../src/worktree-lifecycle.mjs";

test("worktree status distinguishes dirty, merged, active, and orphaned children", () => {
  const child = {
    identifiers: ["workspace:7"],
    sessionId: "child-123",
    worktreePath: "/tmp/repo/child",
    branch: "pi/cache-child",
    baseCommit: "abc123"
  };
  assert.equal(
    classifyOwnedWorktree(child, {
      pathExists: true,
      workspaceKnown: true,
      workspaceAlive: false,
      dirty: true,
      merged: false
    }).status,
    "dirty-orphaned"
  );
  assert.equal(
    classifyOwnedWorktree(child, {
      pathExists: true,
      workspaceKnown: true,
      workspaceAlive: true,
      dirty: false,
      merged: true
    }).status,
    "merged"
  );
});

test("cleanup fails closed unless the child is clean, merged, and not running", () => {
  assert.deepEqual(
    cleanupEligibility({
      pathExists: true,
      workspaceKnown: true,
      workspaceAlive: false,
      dirty: false,
      merged: true
    }),
    { allowed: true }
  );
  assert.match(
    cleanupEligibility({
      pathExists: true,
      workspaceKnown: false,
      workspaceAlive: false,
      dirty: false,
      merged: true
    }).reason,
    /cannot verify cmux workspace liveness/i
  );
  assert.match(
    cleanupEligibility({
      pathExists: true,
      workspaceKnown: true,
      workspaceAlive: true,
      dirty: false,
      merged: true
    }).reason,
    /workspace is still active/
  );
  assert.match(
    cleanupEligibility({
      pathExists: true,
      workspaceKnown: true,
      workspaceAlive: false,
      dirty: true,
      merged: true
    }).reason,
    /uncommitted changes/
  );
  assert.match(
    cleanupEligibility({
      pathExists: true,
      workspaceKnown: true,
      workspaceAlive: false,
      dirty: false,
      merged: false
    }).reason,
    /not merged/
  );
});

test("recovery reuses the existing session and worktree without copying task text", () => {
  const plan = recoveryPlan({
    sessionId: "child-123",
    name: "cache-safety",
    worktreePath: "/tmp/repo/child",
    task: "do not persist this"
  });
  assert.deepEqual(plan, {
    sessionId: "child-123",
    name: "cache-safety",
    cwd: "/tmp/repo/child"
  });
});
