import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentChoices,
  buildWorktreeArguments,
  buildChildCommand,
  buildChildEnvironment,
  buildShellReadyCommand,
  buildSpawnArguments,
  childWorktreePlan,
  orchestrationPolicy,
  parseWorkspaceIdentifiers,
  requireOwnedWorkspace,
  shellQuote,
  waitForPath
} from "../src/cmux-supervisor.mjs";
import { readFile } from "node:fs/promises";

test("quotes child tasks without allowing shell interpolation", () => {
  assert.equal(shellQuote("fix $(touch /tmp/nope) and 'quote'"), "'fix $(touch /tmp/nope) and '\\''quote'\\'''");
});

test("builds a short child command without embedding the task", () => {
  const command = buildChildCommand();

  assert.match(command, /PI_CMUX_CHILD_TASK/);
  assert.match(command, /pi --session-id "\$session"/);
  assert.match(command, /^task=/);
  assert.match(command, /unset PI_CMUX_CHILD_TASK PI_CMUX_CHILD_SESSION_ID PI_CMUX_CHILD_NAME/);
  assert.doesNotMatch(command, /Implement the cache/);
  assert.doesNotMatch(command, /--provider|--model/);
  assert.ok(Buffer.byteLength(command) < 512);
});

test("passes long tasks through the workspace environment instead of terminal input", () => {
  const task = `Implement safely: ${"x".repeat(4000)}\nwith another line`;
  const environment = buildChildEnvironment({
    sessionId: "child-123",
    name: "implement-cache",
    task,
    parentSessionId: "parent-456",
    childClass: "substantial"
  });

  assert.deepEqual(environment, [
    "AGENT_JOURNAL_PARENT_CLIENT=pi",
    "AGENT_JOURNAL_PARENT_SESSION_ID=parent-456",
    "AGENT_JOURNAL_CHILD_CLASS=substantial",
    "PI_CMUX_CHILD_SESSION_ID=child-123",
    "PI_CMUX_CHILD_NAME=implement-cache",
    "PI_CMUX_CHILD_TASK=" + task
  ]);
});

test("builds a non-focused workspace without an eager launch command", () => {
  const args = buildSpawnArguments({
    name: "Pi · implement-cache",
    cwd: "/Users/ella.taira/Desktop/datadog-agent",
    environment: ["PI_CMUX_CHILD_TASK=long task"]
  });
  assert.deepEqual(args, [
    "--id-format",
    "both",
    "new-workspace",
    "--name",
    "Pi · implement-cache",
    "--cwd",
    "/Users/ella.taira/Desktop/datadog-agent",
    "--env",
    "PI_CMUX_CHILD_TASK=long task",
    "--focus",
    "false"
  ]);
  assert.equal(args.includes("--command"), false);
});

test("uses a bounded shell-ready probe that cannot contain task text", () => {
  const command = buildShellReadyCommand("/tmp/pi launch/child.shell-ready");
  assert.equal(command, ": > '/tmp/pi launch/child.shell-ready'");
  assert.ok(Buffer.byteLength(command) < 128);
});

test("startup handshake waits until the marker exists", async () => {
  let checks = 0;
  let sleeps = 0;
  await waitForPath("/tmp/child.started", {
    exists: async () => ++checks === 3,
    timeoutMs: 1000,
    intervalMs: 1,
    sleep: async () => {
      sleeps += 1;
    }
  });
  assert.equal(checks, 3);
  assert.equal(sleeps, 2);
});

test("startup handshake rejects a missing marker", async () => {
  await assert.rejects(
    waitForPath("/tmp/child.started", {
      exists: async () => false,
      timeoutMs: 0,
      intervalMs: 0,
      sleep: async () => {}
    }),
    /Timed out waiting for child startup marker/
  );
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
  assert.match(source, /PI_CMUX_CHILD_STARTED_PATH/);
  assert.match(source, /session_start/);
  assert.match(source, /waitForPath/);
});
