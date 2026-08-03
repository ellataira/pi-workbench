export function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    client: "pi",
    sessionId: "session-123",
    checkpointId: "settled-entry-456",
    checkpointKind: "settled",
    timestamp: "2026-07-24T18:00:00.000Z",
    startedAt: "2026-07-24T17:30:00.000Z",
    cwd: "/Users/ella/Desktop/example-repo",
    repository: "example-repo",
    branch: "ella/example",
    title: "Implement bounded session memory",
    summary: {
      goal: "Build a durable, vendor-neutral session journal.",
      outcomes: ["Defined the shared checkpoint contract."],
      decisions: ["Store summaries rather than transcripts."],
      nextSteps: ["Implement the journal writer."],
      artifacts: ["/tmp/example.md"],
      tags: ["agent-journal", "pi"]
    },
    usage: {
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      costUsd: 0.12,
      model: "openai/gpt-example"
    },
    ...overrides
  };
}
