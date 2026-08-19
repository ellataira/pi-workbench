import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFeatureUsage,
  evaluatePiHealth,
  latestDatedFilename,
  rollupDatesThrough,
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

test("health audit counts explicit review and pair metrics without counting suggestions", () => {
  const usage = buildFeatureUsage({
    toolCalls: { review_open: 2, pair_terminal: 3, journal_checkpoint: 4 },
    customEntries: {
      "pi-review-open-metrics": 5,
      "pi-review-suggestions-v1": 900,
      "pi-pair-open-metrics": 7
    },
    recall: { attempts: 1 }
  });
  assert.equal(usage.reviewUi, 5);
  assert.equal(usage.pairTerminal, 7);
  assert.equal(usage.checkpoint, 4);

  const legacy = buildFeatureUsage({
    toolCalls: { review_open: 2, pair_terminal: 3 },
    customEntries: {},
    recall: { attempts: 0 }
  });
  assert.equal(legacy.reviewUi, 2);
  assert.equal(legacy.pairTerminal, 3);
});

test("health audit reports actionable rates only after bounded minimum samples", () => {
  const result = evaluatePiHealth({
    assistantRuns: 1000,
    compactions: 20,
    stopReasons: { length: 12 },
    toolResults: {
      journal_checkpoint: { success: 85, error: 15 },
      cmux_session: { success: 80, error: 20 },
      ctx_execute_file: { success: 90, error: 10 },
      ctx_fetch_and_index: { success: 18, error: 2 }
    }
  });
  assert.equal(result.rates.checkpointErrorRate, 0.15);
  assert.equal(result.rates.lengthStopRate, 0.012);
  assert.match(result.issues.join("\n"), /checkpoint error rate/i);
  assert.match(result.issues.join("\n"), /cmux_session error rate/i);
  assert.doesNotMatch(result.issues.join("\n"), /ctx_fetch_and_index/);
});

test("daily rollup catch-up is bounded and ends at reviewed date", () => {
  assert.deepEqual(
    rollupDatesThrough("2026-08-09", "2026-08-12", { limit: 3 }),
    ["2026-08-10", "2026-08-11", "2026-08-12"]
  );
  assert.deepEqual(
    rollupDatesThrough(undefined, "2026-08-02", { limit: 3, firstDate: "2026-08-01" }),
    ["2026-08-01", "2026-08-02"]
  );
});
