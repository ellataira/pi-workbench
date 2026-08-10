import test from "node:test";
import assert from "node:assert/strict";

import {
  latestDatedFilename,
  summarizePiJsonl
} from "../src/pi-health-audit.mjs";

test("Pi health usage aggregates metadata without retaining message content", () => {
  const secretPrompt = "SENSITIVE PROMPT MUST NOT APPEAR";
  const jsonl = [
    { type: "session", timestamp: "2026-08-01T12:00:00.000Z" },
    {
      type: "message",
      timestamp: "2026-08-01T12:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: secretPrompt }] }
    },
    {
      type: "message",
      timestamp: "2026-08-01T12:02:00.000Z",
      message: {
        role: "assistant",
        model: "model-a",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 7, cost: { total: 0.02 } },
        content: [{ type: "toolCall", name: "review_open", arguments: { path: secretPrompt } }]
      }
    },
    {
      type: "message",
      timestamp: "2026-08-01T12:03:00.000Z",
      message: { role: "toolResult", toolName: "review_open", isError: false, content: [{ type: "text", text: secretPrompt }] }
    },
    {
      type: "custom",
      customType: "agent-journal-recall-metrics",
      timestamp: "2026-08-01T12:03:30.000Z",
      data: { resultCount: 2, coldResultCount: 1, query: secretPrompt }
    },
    { type: "compaction", timestamp: "2026-08-01T12:04:00.000Z", tokensBefore: 270000 }
  ].map(JSON.stringify).join("\n");

  const result = summarizePiJsonl(jsonl, {
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-09-01T00:00:00.000Z")
  });

  assert.equal(result.userTurns, 1);
  assert.equal(result.assistantRuns, 1);
  assert.equal(result.compactions, 1);
  assert.deepEqual(result.recall, { attempts: 1, results: 2, coldResults: 1 });
  assert.equal(result.toolCalls.review_open, 1);
  assert.equal(result.toolResults.review_open.success, 1);
  assert.deepEqual(result.models["model-a"], {
    calls: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 7,
    cacheWriteTokens: 0,
    costUsd: 0.02
  });
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE PROMPT/);
});

test("Pi health usage counts malformed records without copying them", () => {
  const result = summarizePiJsonl("not-json\n", {
    start: new Date(0),
    end: new Date("2100-01-01T00:00:00.000Z")
  });
  assert.equal(result.parseErrors, 1);
  assert.equal(JSON.stringify(result).includes("not-json"), false);
});

test("health audit identifies the newest link-rollup date", () => {
  assert.equal(
    latestDatedFilename([
      "/vault/daily/2026/07/2026-07-24.md",
      "/vault/daily/2026/08/2026-08-09.md"
    ]),
    "2026-08-09"
  );
  assert.equal(latestDatedFilename([]), null);
});
