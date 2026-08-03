import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentChoices,
  buildWorktreeArguments,
  buildChildCommand,
  buildSpawnArguments,
  childWorktreePlan,
  orchestrationPolicy,
  parseWorkspaceIdentifiers,
  requireOwnedWorkspace,
  shellQuote
} from "../src/cmux-supervisor.mjs";
import { readFile } from "node:fs/promises";

test("quotes child tasks without allowing shell interpolation", () => {
  assert.equal(shellQuote("fix $(touch /tmp/nope) and 'quote'"), "'fix $(touch /tmp/nope) and '\\''quote'\\'''");
});

test("builds a persistent vendor-neutral Pi child command with journal lineage", () => {
  const command = buildChildCommand({
    sessionId: "child-123",
    name: "implement-cache",
    task: "Implement the cache and run tests.",
    parentSessionId: "parent-456",
    childClass: "substantial"
  });

  assert.match(command, /AGENT_JOURNAL_PARENT_SESSION_ID='parent-456'/);
  assert.match(command, /AGENT_JOURNAL_CHILD_CLASS='substantial'/);
  assert.match(command, /pi --session-id 'child-123'/);
  assert.doesNotMatch(command, /--provider|--model/);
});

test("builds a non-focused cmux workspace launch", () => {
  const args = buildSpawnArguments({
    name: "Pi · implement-cache",
    cwd: "/Users/ella.taira/Desktop/datadog-agent",
    command: "pi --session-id 'child-123'"
  });
  assert.deepEqual(args, [
    "--id-format",
    "both",
    "new-workspace",
    "--name",
    "Pi · implement-cache",
    "--cwd",
    "/Users/ella.taira/Desktop/datadog-agent",
    "--command",
    "pi --session-id 'child-123'",
    "--focus",
    "false"
  ]);
});

test("policy distinguishes lightweight fanout from navigable implementation sessions", () => {
  assert.match(orchestrationPolicy, /lightweight research or decomposition/i);
  assert.match(orchestrationPolicy, /persistent cmux child/i);
  assert.match(orchestrationPolicy, /one writer/i);
  assert.match(orchestrationPolicy, /Pi-native.*\/tree.*\/resume/i);
  assert.match(orchestrationPolicy, /isolated worktree/i);
});

test("plans an isolated worktree without embedding the task prompt", () => {
  const plan = childWorktreePlan({
    repoRoot: "/Users/ella.taira/Desktop/datadog-agent",
    worktreeBaseDir: "/Users/ella.taira/.pi/agent/worktrees",
    name: "Implement cache safety",
    sessionId: "12345678-abcd-4000-8000-123456789abc"
  });

  assert.equal(plan.branch, "pi/implement-cache-safety-12345678");
  assert.equal(
    plan.path,
    "/Users/ella.taira/.pi/agent/worktrees/datadog-agent/implement-cache-safety-12345678"
  );
  assert.deepEqual(buildWorktreeArguments({ ...plan, baseRef: "HEAD" }), [
    "worktree",
    "add",
    "-b",
    "pi/implement-cache-safety-12345678",
    plan.path,
    "HEAD"
  ]);
  assert.equal("task" in plan, false);
});

test("parses cmux workspace identifiers and restricts control to owned children", () => {
  const identifiers = parseWorkspaceIdentifiers(
    "workspace:7 123e4567-e89b-42d3-a456-426614174000"
  );
  assert.deepEqual(identifiers, [
    "workspace:7",
    "123e4567-e89b-42d3-a456-426614174000"
  ]);

  const owned = [
    {
      identifiers,
      sessionId: "child-123",
      name: "cache-safety"
    }
  ];
  assert.equal(requireOwnedWorkspace(owned, "workspace:7").sessionId, "child-123");
  assert.throws(
    () => requireOwnedWorkspace(owned, "workspace:99"),
    /not owned by this Pi supervisor/
  );
});

test("agent chooser presents persistent and lightweight paths with readable child state", () => {
  assert.deepEqual(
    buildAgentChoices([
      {
        sessionId: "child-123",
        name: "cache-safety",
        status: "running",
        cwd: "/repo"
      }
    ]),
    [
      { action: "persistent", label: "Start persistent implementation agent…" },
      { action: "background", label: "Fan out a lightweight task…" },
      { action: "child", sessionId: "child-123", label: "Running · cache-safety · /repo" }
    ]
  );
});

test("supervisor exposes one agents command instead of implementation-detail aliases", async () => {
  const source = await readFile(
    new URL("../extensions/pi-cmux-supervisor.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /registerCommand\("agents"/);
  assert.doesNotMatch(source, /registerCommand\("(?:child|cmux-children|worktrees|worktree)"/);
});
