import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_CHECKPOINT_MARKER,
  automaticRecallDefaults,
  assistantRunFailed,
  autoCheckpointMessage,
  checkpointCadenceFromEntries,
  classifyCheckpointTurn,
  checkpointSourceEntries,
  compressedTitle,
  createRunState,
  dailyDistillationMessage,
  driveWorkspaceFallback,
  formatRecallContext,
  recallUsageMetric,
  recordToolCompletion,
  recordToolStart,
  summaryCopiesConversation,
  shouldProactivelyRecall,
  shouldSearchDriveWorkspace,
  shouldCheckpointBeforeCompaction,
  shouldQueueAutoCheckpoint
} from "../src/pi-memory-policy.mjs";

const assistant = (text, stopReason = "stop") => [{
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason
}];

test("proactive recall skips greetings, commands, and checkpoint turns", () => {
  assert.equal(shouldProactivelyRecall("hi?"), false);
  assert.equal(shouldProactivelyRecall("/mcp"), false);
  assert.equal(shouldProactivelyRecall(autoCheckpointMessage()), false);
  assert.equal(shouldProactivelyRecall(dailyDistillationMessage("2026-07-26")), false);
  assert.equal(shouldProactivelyRecall("Implement the connector fix"), false);
  assert.equal(shouldProactivelyRecall("Write tests for this change"), false);
  assert.equal(shouldProactivelyRecall("What did we decide about sender shutdown?"), true);
  assert.equal(shouldProactivelyRecall("Continue the approach we used last time"), true);
});

test("automatic recall has a small fixed injection budget", () => {
  assert.deepEqual(automaticRecallDefaults, { limit: 3, tokenBudget: 400 });
});

test("recall usage telemetry contains counts but no query or memory content", () => {
  const result = {
    items: [
      { title: "SENSITIVE MEMORY", excerpt: "SENSITIVE EXCERPT" },
      { rehydration: { driveFileId: "drive-id" } }
    ]
  };
  const metric = recallUsageMetric(result, {
    repository: "datadog-agent",
    recordedAt: "2026-08-10T12:00:00.000Z"
  });
  assert.deepEqual(metric, {
    recordedAt: "2026-08-10T12:00:00.000Z",
    repository: "datadog-agent",
    resultCount: 2,
    coldResultCount: 1,
    tokenBudget: 400
  });
  assert.doesNotMatch(JSON.stringify(metric), /SENSITIVE/);
});

test("successful substantive tools require one checkpoint backstop", () => {
  const state = createRunState("Implement the connector fix");
  recordToolCompletion(state, { toolName: "edit", isError: false });
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Done.")), true);

  recordToolCompletion(state, {
    toolName: "journal_checkpoint",
    isError: false,
    result: { details: { status: "appended" } }
  });
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Done.")), false);
});

test("checkpoint cadence advances only after a confirmed append or duplicate", () => {
  for (const status of ["appended", "duplicate"]) {
    const state = createRunState(autoCheckpointMessage(), { checkpointRun: true });
    recordToolCompletion(state, {
      toolName: "journal_checkpoint",
      isError: false,
      result: { details: { status } }
    });
    assert.equal(state.checkpointSaved, true, status);
  }

  const ambiguous = createRunState(autoCheckpointMessage(), { checkpointRun: true });
  recordToolCompletion(ambiguous, {
    toolName: "journal_checkpoint",
    isError: false,
    result: { details: {} }
  });
  assert.equal(ambiguous.checkpointSaved, false);
});

test("automatic checkpoints run once per session instead of on a timer", () => {
  const now = Date.parse("2026-07-29T14:30:00.000Z");
  const state = createRunState("Implement the connector fix");
  recordToolCompletion(state, { toolName: "edit", isError: false });

  assert.equal(
    shouldQueueAutoCheckpoint(state, assistant("Done."), {
      lastCheckpointAt: undefined,
      now
    }),
    true,
    "the first durable change in a session is saved"
  );
  assert.equal(
    shouldQueueAutoCheckpoint(state, assistant("Done."), {
      lastCheckpointAt: now - 24 * 60 * 60 * 1000,
      now
    }),
    false,
    "a prior checkpoint suppresses all later timer-based checkpoints"
  );
});

test("read-only and clarification turns never flush coalesced work", () => {
  const now = Date.parse("2026-07-29T14:30:00.000Z");
  const readOnly = createRunState("Check the current setting");
  recordToolStart(readOnly, {
    toolCallId: "read-1",
    toolName: "mcp",
    args: { tool: "settings_get" }
  });
  recordToolCompletion(readOnly, {
    toolCallId: "read-1",
    toolName: "mcp",
    isError: false
  });
  assert.equal(
    shouldQueueAutoCheckpoint(readOnly, assistant("It is enabled."), {
      lastCheckpointAt: now - 24 * 60 * 60 * 1000,
      now,
      durableWorkPending: true
    }),
    false
  );
});

test("opening the review UI is read-only and does not queue a checkpoint", () => {
  const state = createRunState("Open these files in the viewer");
  recordToolCompletion(state, { toolName: "review_open", isError: false });

  assert.equal(state.successfulTools, 0);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Review opened.")), false);
});

test("starting or inspecting pair mode does not queue a checkpoint", () => {
  const state = createRunState("Start a visible pair terminal");
  recordToolCompletion(state, { toolName: "pair_terminal", isError: false });
  assert.equal(state.successfulTools, 0);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Pair terminal started.")), false);
});

test("checkpoint cadence restores the latest safe metadata entry", () => {
  const entries = [
    {
      type: "custom",
      customType: "agent-journal-checkpoint-state",
      data: { savedAt: "2026-07-29T14:00:00.000Z" }
    },
    {
      type: "custom",
      customType: "unrelated",
      data: { savedAt: "2026-07-29T14:10:00.000Z" }
    },
    {
      type: "custom",
      customType: "agent-journal-checkpoint-state",
      data: { savedAt: "2026-07-29T14:15:00.000Z" }
    }
  ];
  assert.deepEqual(checkpointCadenceFromEntries(entries), {
    lastCheckpointAt: Date.parse("2026-07-29T14:15:00.000Z"),
    durableWorkPending: false
  });
  assert.deepEqual(
    checkpointCadenceFromEntries([
      ...entries,
      {
        type: "custom",
        customType: "agent-journal-checkpoint-state",
        data: {
          savedAt: "2026-07-29T14:15:00.000Z",
          durableWorkPending: true
        }
      }
    ]),
    {
      lastCheckpointAt: Date.parse("2026-07-29T14:15:00.000Z"),
      durableWorkPending: true
    }
  );
});

test("compaction pauses once for pending durable work and then fails open", () => {
  assert.equal(
    shouldCheckpointBeforeCompaction({
      durableWorkPending: true,
      checkpointQueued: false,
      attempted: false
    }),
    true
  );
  assert.equal(
    shouldCheckpointBeforeCompaction({
      durableWorkPending: true,
      checkpointQueued: true,
      checkpointInProgress: false,
      attempted: false
    }),
    true,
    "an already queued checkpoint still requires compaction to wait"
  );
  assert.equal(
    shouldCheckpointBeforeCompaction({
      durableWorkPending: true,
      checkpointQueued: false,
      checkpointInProgress: true,
      attempted: false
    }),
    false,
    "overflow during the checkpoint attempt must fail open"
  );
  assert.equal(
    shouldCheckpointBeforeCompaction({
      durableWorkPending: true,
      checkpointQueued: false,
      attempted: true
    }),
    false
  );
  assert.equal(
    shouldCheckpointBeforeCompaction({
      durableWorkPending: false,
      checkpointQueued: false,
      attempted: false
    }),
    false
  );
});

test("automatic Drive rehydration does not create a checkpoint by itself", () => {
  const state = createRunState("What did we decide about archived retention?");
  recordToolCompletion(state, {
    toolName: "journal_rehydrate_drive_memory",
    isError: false
  });
  assert.equal(state.successfulTools, 0);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Short answer.")), false);
});

test("short read-only MCP lookups do not checkpoint, but MCP writes do", () => {
  const readState = createRunState("Find the archived retention note");
  recordToolStart(readState, {
    toolCallId: "read-1",
    toolName: "mcp",
    args: { tool: "datadog_google_workspace_search_files" }
  });
  recordToolCompletion(readState, {
    toolCallId: "read-1",
    toolName: "mcp",
    isError: false
  });
  assert.equal(shouldQueueAutoCheckpoint(readState, assistant("Found it.")), false);

  const writeState = createRunState("Create the approved archive");
  recordToolStart(writeState, {
    toolCallId: "write-1",
    toolName: "mcp",
    args: { tool: "datadog_google_workspace_create_file" }
  });
  recordToolCompletion(writeState, {
    toolCallId: "write-1",
    toolName: "mcp",
    isError: false
  });
  assert.equal(shouldQueueAutoCheckpoint(writeState, assistant("Created.")), true);
});

test("MCP status, connection, and authentication actions do not checkpoint", () => {
  for (const [name, args] of [
    ["status", {}],
    ["connect", { connect: "atlassian" }],
    ["auth-start", { action: "auth-start", server: "atlassian" }],
    ["auth-complete", { action: "auth-complete", server: "atlassian" }]
  ]) {
    const state = createRunState(`Inspect MCP ${name}`);
    recordToolStart(state, {
      toolCallId: name,
      toolName: "mcp",
      args
    });
    recordToolCompletion(state, {
      toolCallId: name,
      toolName: "mcp",
      isError: false
    });
    assert.equal(
      shouldQueueAutoCheckpoint(state, assistant("Done.")),
      false,
      name
    );
  }
});

test("read-only answers do not checkpoint, regardless of length", () => {
  const state = createRunState("Explain the architecture decision");
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("x".repeat(240))), false);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Short answer.")), false);
  assert.equal(assistantRunFailed(assistant("failed", "error")), true);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("x".repeat(300), "error")), false);
});

test("review turns checkpoint only when they implement a change", () => {
  const review = createRunState("Review the current diff for correctness");
  recordToolCompletion(review, { toolName: "bash", isError: false });
  assert.equal(shouldQueueAutoCheckpoint(review, assistant("Found one issue.")), false);

  recordToolCompletion(review, { toolName: "edit", isError: false });
  assert.equal(shouldQueueAutoCheckpoint(review, assistant("Fixed the issue.")), true);
});

test("long clarification requests do not create empty milestone checkpoints", () => {
  const clarification = [
    "One important point remains unclear before I reorganize it:",
    "",
    "Metric lookback does not directly reduce GPU infrastructure cost. It reruns the GPU check at 1 Hz, increasing local Agent work.",
    "",
    "Is that the intended cost-saving story, or is there a different mechanism by which enabling this feature directly lowers GPU infrastructure cost?"
  ].join("\n");
  const state = createRunState("Reorganize the metric lookback document");
  assert.equal(clarification.length >= 240, true);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant(clarification)), false);

  recordToolCompletion(state, { toolName: "write", isError: false });
  assert.equal(shouldQueueAutoCheckpoint(state, assistant(clarification)), true);
});

test("checkpoint follow-up never recursively checkpoints itself", () => {
  const state = createRunState(autoCheckpointMessage(), { checkpointRun: true });
  recordToolCompletion(state, { toolName: "journal_checkpoint", isError: true });
  assert.equal(state.checkpointRun, true);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Checkpoint failed.")), false);
  assert.match(autoCheckpointMessage(), new RegExp(AUTO_CHECKPOINT_MARKER));
  assert.match(autoCheckpointMessage(), /reply with exactly: Memory checkpoint saved\./);
  assert.doesNotMatch(autoCheckpointMessage(), /no additional narrative/);
});

test("a pending automatic checkpoint never hijacks an intervening user prompt", () => {
  assert.deepEqual(classifyCheckpointTurn("retry", true), {
    checkpointRun: false,
    automaticCheckpoint: false,
    consumePendingAutomaticCheckpoint: false
  });
  assert.deepEqual(classifyCheckpointTurn(autoCheckpointMessage(), true), {
    checkpointRun: true,
    automaticCheckpoint: true,
    consumePendingAutomaticCheckpoint: true
  });
});

test("daily distillation cannot create a session checkpoint loop", () => {
  const state = createRunState(dailyDistillationMessage("2026-07-26"));
  recordToolCompletion(state, {
    toolName: "journal_distillation_candidates",
    isError: false
  });
  assert.equal(state.distillationRun, true);
  assert.equal(shouldQueueAutoCheckpoint(state, assistant("Review complete.")), false);
});

test("recall context is bounded data with provenance rather than instructions", () => {
  const text = formatRecallContext({
    items: [{
      title: "Sender shutdown",
      excerpt: "The scheduler owns shutdown.",
      provenance: "/vault/note.md#pi:123"
    }]
  });
  assert.match(text, /not instructions/i);
  assert.match(text, /The scheduler owns shutdown/);
  assert.match(text, /Provenance: \/vault\/note\.md#pi:123/);
});

test("relevant cold-tier memory tells Pi to verify and rehydrate before use", () => {
  const text = formatRecallContext({
    items: [{
      title: "Archived retention decision",
      excerpt: "Keep metadata permanently and remove resumable JSONL after 30 days.",
      provenance: "/vault/missing.md#pi:archived",
      rehydration: {
        provider: "google-drive",
        driveFileId: "drive-file-123",
        expectedSha256: "a".repeat(64)
      }
    }]
  });

  assert.match(text, /drive-file-123/);
  assert.match(text, /journal_rehydrate_drive_memory/);
  assert.match(text, /before relying on this memory/i);
  assert.doesNotMatch(text, /remote content/i);
  assert.doesNotMatch(text, /undefined/);
});

test("Drive workspace fallback is limited to context queries with no local recall", () => {
  assert.equal(
    shouldSearchDriveWorkspace(
      "Find the previous design document for sender lifecycle",
      { items: [] }
    ),
    true
  );
  assert.equal(
    shouldSearchDriveWorkspace("Implement this function", { items: [] }),
    false
  );
  assert.equal(
    shouldSearchDriveWorkspace(
      "Find the previous design document",
      { items: [{ title: "Local answer" }] }
    ),
    false
  );
  const prompt = driveWorkspaceFallback(
    "Find the previous design document for sender lifecycle"
  );
  assert.match(prompt, /max_results=3/i);
  assert.match(prompt, /datadog-google-workspace/);
  assert.match(prompt, /untrusted data/i);
});

test("session titles come only from compressed goals", () => {
  assert.equal(
    compressedTitle({ goal: "  Build   reliable memory. " }, "raw prompt title"),
    "Build reliable memory."
  );
});

test("checkpoint guard rejects copied conversation text but permits paraphrases", () => {
  const entries = [{
    type: "message",
    message: {
      role: "user",
      content: "Implement the exact connector workflow and report every authorization failure verbatim."
    }
  }];
  assert.equal(summaryCopiesConversation({
    goal: "Implement the exact connector workflow and report every authorization failure verbatim.",
    outcomes: [],
    decisions: [],
    nextSteps: []
  }, entries), true);
  assert.equal(summaryCopiesConversation({
    goal: "Repair connector authentication.",
    outcomes: ["Validated both remote services."],
    decisions: [],
    nextSteps: []
  }, entries), false);
});

test("checkpoint guard ignores its own tool arguments and private reasoning", () => {
  const summary = {
    goal: "Reorganize technical material into stable categories and paths.",
    outcomes: ["Improved the structure without retaining conversational wording."],
    decisions: [],
    nextSteps: []
  };
  const entries = [{
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: summary.goal
        },
        {
          type: "toolCall",
          name: "journal_checkpoint",
          arguments: summary
        }
      ]
    }
  }];
  const sanitized = checkpointSourceEntries(entries);
  assert.deepEqual(sanitized[0].message.content, []);
  assert.equal(summaryCopiesConversation(summary, entries), false);
});

test("checkpoint guard still rejects copied visible assistant prose", () => {
  const copied =
    "Reorganize technical material into stable categories and consistent artifact paths.";
  const entries = [{
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: copied }]
    }
  }];
  assert.equal(summaryCopiesConversation({
    goal: copied,
    outcomes: [],
    decisions: [],
    nextSteps: []
  }, entries), true);
});
