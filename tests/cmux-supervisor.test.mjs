import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentChoices,
  buildWorktreeArguments,
  buildChildCommand,
  buildChildEnvironment,
  buildDetachedForkCommand,
  buildDetachedForkEnvironment,
  buildShellReadyCommand,
  buildSpawnArguments,
  childWorktreePlan,
  childScreenTail,
  formatChildIdentityLines,
  formatChildProgressLines,
  normalizeChildProgress,
  orchestrationPolicy,
  parseWorkspaceIdentifiers,
  requireOwnedWorkspace,
  resolveOwnedChildSelector,
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
    childClass: "substantial",
    parentWorkspaceId: "workspace:2"
  });

  assert.deepEqual(environment, [
    "AGENT_JOURNAL_PARENT_CLIENT=pi",
    "AGENT_JOURNAL_PARENT_SESSION_ID=parent-456",
    "AGENT_JOURNAL_CHILD_CLASS=substantial",
    "PI_CMUX_CHILD_SESSION_ID=child-123",
    "PI_CMUX_CHILD_NAME=implement-cache",
    "PI_CMUX_CHILD_DISPLAY_NAME=implement-cache",
    "PI_CMUX_SUPERVISOR_WORKSPACE_ID=workspace:2",
    "PI_CMUX_CHILD_TASK=" + task
  ]);
});

test("builds a non-focused workspace without an eager launch command", () => {
  const args = buildSpawnArguments({
    name: "Pi · implement-cache",
    cwd: "/Users/ella/Desktop/example-repo",
    environment: ["PI_CMUX_CHILD_TASK=long task"]
  });
  assert.deepEqual(args, [
    "--id-format",
    "both",
    "new-workspace",
    "--name",
    "Pi · implement-cache",
    "--cwd",
    "/Users/ella/Desktop/example-repo",
    "--env",
    "PI_CMUX_CHILD_TASK=long task",
    "--focus",
    "false"
  ]);
  assert.equal(args.includes("--command"), false);
});

test("builds a focused cmux tab for a detached fork", () => {
  const args = buildSpawnArguments({
    name: "Pi fork · research",
    cwd: "/repo",
    environment: ["PI_CMUX_FORK_SESSION_FILE=/tmp/fork.jsonl"],
    focus: true
  });
  assert.deepEqual(args.slice(-2), ["--focus", "true"]);
});

test("launches an existing fork session without embedding its path in terminal input", () => {
  const command = buildDetachedForkCommand();
  const environment = buildDetachedForkEnvironment({
    sessionFile: "/tmp/session with spaces.jsonl",
    parentSessionId: "parent-123",
    parentWorkspaceId: "workspace:2"
  });

  assert.equal(
    command,
    'session="$PI_CMUX_FORK_SESSION_FILE"; unset PI_CMUX_FORK_SESSION_FILE; exec pi --session "$session"'
  );
  assert.deepEqual(environment, [
    "AGENT_JOURNAL_PARENT_CLIENT=pi",
    "AGENT_JOURNAL_PARENT_SESSION_ID=parent-123",
    "AGENT_JOURNAL_CHILD_CLASS=substantial",
    "PI_CMUX_SUPERVISOR_WORKSPACE_ID=workspace:2",
    "PI_CMUX_FORK_SESSION_FILE=/tmp/session with spaces.jsonl"
  ]);
  assert.doesNotMatch(command, /session with spaces/);
});

test("starts a natural-language fork task from an environment value", () => {
  const task = "Research $(touch /tmp/nope)\nwithout changing the parent";
  const command = buildDetachedForkCommand({ includeTask: true });
  const environment = buildDetachedForkEnvironment({
    sessionFile: "/tmp/fork.jsonl",
    parentSessionId: "parent-123",
    task
  });

  assert.match(command, /^task="\$PI_CMUX_FORK_TASK"/);
  assert.match(command, /exec pi --session "\$session" "\$task"$/);
  assert.doesNotMatch(command, /touch/);
  assert.equal(environment.at(-1), `PI_CMUX_FORK_TASK=${task}`);
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
  assert.match(orchestrationPolicy, /explicitly asks.*\/fork/i);
  assert.match(orchestrationPolicy, /do not continue.*parent/i);
});

test("plans an isolated worktree without embedding the task prompt", () => {
  const plan = childWorktreePlan({
    repoRoot: "/Users/ella/Desktop/example-repo",
    worktreeBaseDir: "/Users/ella/.pi/agent/worktrees",
    name: "Implement cache safety",
    sessionId: "12345678-abcd-4000-8000-123456789abc"
  });

  assert.equal(plan.branch, "pi/implement-cache-safety-12345678");
  assert.equal(
    plan.path,
    "/Users/ella/.pi/agent/worktrees/example-repo/implement-cache-safety-12345678"
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

test("child progress stores lifecycle metadata without prompts or terminal output", () => {
  assert.deepEqual(
    normalizeChildProgress({
      version: 1,
      sessionId: "child-123",
      phase: "tool",
      toolName: "apply_patch",
      updatedAt: "2026-08-21T12:00:00.000Z",
      prompt: "secret task",
      output: "terminal transcript"
    }),
    {
      version: 1,
      sessionId: "child-123",
      phase: "tool",
      toolName: "apply_patch",
      updatedAt: "2026-08-21T12:00:00.000Z"
    }
  );
});

test("parent progress lines identify the worker, phase, branch, activity, and focus action", () => {
  assert.deepEqual(
    formatChildProgressLines(
      [{ sessionId: "child-123", name: "campaign-core", branch: "pi/campaign-core", createdAt: "2026-08-21T11:00:00.000Z" }],
      new Map([["child-123", {
        version: 1,
        sessionId: "child-123",
        phase: "tool",
        toolName: "apply_patch",
        updatedAt: "2026-08-21T11:59:57.000Z"
      }]]),
      { now: Date.parse("2026-08-21T12:00:00.000Z") }
    ),
    [
      "Agent map · supervisor (this tab) · 1 active child",
      "└─ campaign-core · working: apply_patch · active now",
      "   open: /agents focus campaign-core · follow: /agents watch campaign-core",
      "   pi/campaign-core",
      "Child tabs return here with /agents parent"
    ]
  );
});

test("child identity widget explains how to return to the supervisor", () => {
  assert.deepEqual(formatChildIdentityLines("campaign-core"), [
    "Agent map · child: campaign-core (this tab)",
    "Return to supervisor · /agents parent",
    "The supervisor follows a bounded live tail automatically"
  ]);
});

test("parent progress can show a bounded redacted live child tail", () => {
  const tail = childScreenTail([
    "────────────────────────",
    "Authorization: Bearer super-secret-token",
    "Working on controller tests",
    "API_KEY=also-secret",
    "Tests passed",
    " GPT-5.6 Terra · think:med · 42%",
    ">"
  ].join("\n"));

  assert.deepEqual(tail, [
    "Working on controller tests",
    "API_KEY=[redacted]",
    "Tests passed"
  ]);
  assert.doesNotMatch(tail.join("\n"), /secret-token|also-secret/);

  const lines = formatChildProgressLines(
    [{ sessionId: "child-123", name: "campaign-core", branch: "pi/campaign-core" }],
    new Map(),
    { screenTailBySessionId: new Map([["child-123", tail]]) }
  );
  assert.deepEqual(lines.filter((line) => line.includes("↳")), [
    "   ↳ Working on controller tests",
    "   ↳ API_KEY=[redacted]",
    "   ↳ Tests passed"
  ]);
});

test("child screen tails are line and character bounded", () => {
  assert.deepEqual(
    childScreenTail("first\nsecond is long\nthird\nfourth", {
      maxLines: 2,
      maxLineChars: 8
    }),
    ["third", "fourth"]
  );
});

test("parent progress makes stale and stopped children unambiguous", () => {
  const child = {
    sessionId: "child-123",
    name: "campaign-core",
    branch: "pi/campaign-core",
    createdAt: "2026-08-21T11:00:00.000Z"
  };
  assert.match(
    formatChildProgressLines(
      [child],
      new Map([["child-123", {
        version: 1,
        sessionId: "child-123",
        phase: "thinking",
        updatedAt: "2026-08-21T11:58:00.000Z"
      }]]),
      { now: Date.parse("2026-08-21T12:00:00.000Z") }
    )[1],
    /heartbeat stale · 2m ago/
  );
  assert.deepEqual(
    formatChildProgressLines(
      [child],
      new Map([["child-123", {
        version: 1,
        sessionId: "child-123",
        phase: "stopped",
        updatedAt: "2026-08-21T12:00:00.000Z"
      }]])
    ),
    []
  );
});

test("child selectors accept readable names and unique short ids but reject ambiguity", () => {
  const children = [
    { sessionId: "12345678-aaaa", name: "campaign-core" },
    { sessionId: "12349999-bbbb", name: "campaign-tests" }
  ];
  assert.equal(resolveOwnedChildSelector(children, "campaign-core"), children[0]);
  assert.equal(resolveOwnedChildSelector(children, "12345678"), children[0]);
  assert.throws(() => resolveOwnedChildSelector(children, "campaign"), /ambiguous/i);
  assert.throws(() => resolveOwnedChildSelector(children, "missing"), /unknown/i);
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
  assert.match(source, /session_before_fork/);
  assert.match(source, /Type\.Literal\("fork"\)/);
  assert.match(source, /waitForPath/);
  assert.match(source, /pi-agents-progress/);
  assert.match(source, /tool_execution_start/);
  assert.match(source, /agent_settled/);
  assert.match(source, /AGENT_JOURNAL_CHILD_CLASS === "substantial"/);
  assert.match(source, /registerCommand\("agents"/);
  assert.match(source, /action === "status"/);
  assert.match(source, /"read-screen"/);
  assert.match(source, /action === "watch"/);
  assert.match(source, /action === "parent"/);
  assert.match(source, /PI_CMUX_SUPERVISOR_WORKSPACE_ID/);
  assert.match(source, /importFreshSourceModule/);
  assert.doesNotMatch(source, /from "\.\.\/src\/cmux-supervisor\.mjs"/);
});
