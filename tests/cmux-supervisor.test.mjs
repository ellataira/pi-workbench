import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentCenterActions,
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
  parseWorkspaceRefs,
  parseWorkspaceIdentifiers,
  requireOwnedWorkspace,
  resolveCurrentChild,
  resolveOwnedChildSelector,
  supervisorWorkspaceCandidates,
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

test("legacy children discover only non-child cmux workspaces as supervisor candidates", () => {
  const listing = [
    "workspace:1  Parent Pi",
    "workspace:3  Notes",
    "workspace:5  Pi · campaign-core",
    "workspace:6  Pi · tests"
  ].join("\n");
  assert.deepEqual(parseWorkspaceRefs(listing), [
    "workspace:1",
    "workspace:3",
    "workspace:5",
    "workspace:6"
  ]);
  assert.deepEqual(
    supervisorWorkspaceCandidates(listing, [
      { identifiers: ["workspace:5"], sessionId: "current" },
      { identifiers: ["workspace:6"], sessionId: "other" }
    ], "workspace:5"),
    ["workspace:1", "workspace:3"]
  );
});

test("agent center uses plain language and keeps child management in the parent", () => {
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
      { action: "persistent", label: "Start implementation agent…" },
      { action: "background", label: "Run parallel task…" },
      { action: "child", sessionId: "child-123", label: "cache-safety · Running · /repo" }
    ]
  );
  assert.deepEqual(buildAgentCenterActions(), [
    "Follow here",
    "Send instruction…",
    "Review changes…",
    "Open child tab…",
    "More…"
  ]);
});

test("agent chooser uses lifecycle worktree paths instead of rendering undefined", () => {
  assert.equal(
    buildAgentChoices([{
      sessionId: "child-123",
      name: "campaign-core",
      status: "dirty-active",
      worktreePath: "/worktrees/campaign-core",
      branch: "pi/campaign-core"
    }]).at(-1).label,
    "campaign-core · Dirty-active · /worktrees/campaign-core"
  );
});

test("child identity falls back to its worktree when a legacy session id differs", () => {
  const child = {
    sessionId: "legacy-id",
    name: "campaign-core",
    cwd: "/worktrees/campaign-core"
  };
  assert.equal(
    resolveCurrentChild([child], {
      sessionId: "reloaded-id",
      cwd: "/worktrees/campaign-core"
    }),
    child
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

test("parent progress keeps navigation behind the agent center", () => {
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
      "Agent Center · supervisor · 1 active agent",
      "└─ campaign-core · working: apply_patch · active now",
      "   pi/campaign-core",
      "   manage: /agents (stays in this tab)"
    ]
  );
});

test("child identity widget explains how to return to the supervisor", () => {
  assert.deepEqual(formatChildIdentityLines("campaign-core"), [
    "Agent Center · campaign-core (worker tab)",
    "Run /agents to return to the supervisor",
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
  assert.match(source, /openChildAgentsChooser/);
  assert.match(source, /Agent Center · .*stays in this tab/);
  assert.match(source, /selected === "Follow here"/);
  assert.match(source, /selected === "Send instruction…"/);
  assert.match(source, /selected === "Review changes…"/);
  assert.match(source, /selected === "Open child tab…"/);
  assert.match(source, /Run \/agents to manage it without leaving this tab/);
  assert.match(source, /importFreshSourceModule/);
  assert.doesNotMatch(source, /from "\.\.\/src\/cmux-supervisor\.mjs"/);
});
