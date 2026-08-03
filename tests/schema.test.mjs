import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCheckpoint, validateCheckpoint } from "../src/schema.mjs";
import { checkpoint } from "./fixtures.mjs";

test("accepts a valid vendor-neutral checkpoint", () => {
  const result = validateCheckpoint(checkpoint());
  assert.equal(result.ok, true);
});

test("normalizes stable identity and bounded tags", () => {
  const value = normalizeCheckpoint(
    checkpoint({
      client: " PI ",
      sessionId: " session/123 ",
      checkpointId: " settled/456 ",
      summary: {
        ...checkpoint().summary,
        tags: ["Agent Journal", "agent-journal", "PI", "extra", "ignored"]
      }
    })
  );

  assert.equal(value.client, "pi");
  assert.equal(value.sessionId, "session-123");
  assert.equal(value.checkpointId, "settled-456");
  assert.deepEqual(value.summary.tags, ["agent-journal", "pi", "extra", "ignored"]);
  assert.equal(value.identity, "pi:session-123");
  assert.equal(value.idempotencyKey, "pi:session-123:settled-456");
});

test("rejects transcript-shaped fields", () => {
  for (const forbidden of [
    "transcript",
    "messages",
    "rawTranscript",
    "prompt",
    "response",
    "completion",
    "conversation",
    "turns"
  ]) {
    const candidate = checkpoint({ [forbidden]: ["raw conversation"] });
    const result = validateCheckpoint(candidate);
    assert.equal(result.ok, false, forbidden);
    assert.match(result.errors.join("\n"), /raw conversation content/i);
  }
});

test("requires an explicit compressed representation marker", () => {
  const candidate = checkpoint();
  delete candidate.representation;
  const result = validateCheckpoint(candidate);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /compressed-summary-v1/);
});

test("rejects role-labelled transcript text hidden inside summary fields", () => {
  const result = validateCheckpoint(
    checkpoint({
      summary: {
        ...checkpoint().summary,
        outcomes: ["User: implement it\nAssistant: done"]
      }
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /role-labelled transcript/i);
});

test("rejects oversized summary content", () => {
  const result = validateCheckpoint(
    checkpoint({
      summary: {
        ...checkpoint().summary,
        outcomes: ["x".repeat(20_000)]
      }
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /summary.*large/i);
});

test("artifacts must be references rather than prose copied from a conversation", () => {
  const prose = validateCheckpoint(
    checkpoint({
      summary: {
        ...checkpoint().summary,
        artifacts: [
          "No tests ran because this was only a documentation update requested by the user."
        ]
      }
    })
  );
  assert.equal(prose.ok, false);
  assert.match(prose.errors.join("\n"), /artifact.*reference/i);

  for (const artifact of [
    "/Users/ella.taira/Desktop/datadog-agent/docs/plan.md",
    "docs/plan.md",
    "https://example.test/design",
    "PR#1234"
  ]) {
    const result = validateCheckpoint(
      checkpoint({
        summary: {
          ...checkpoint().summary,
          artifacts: [artifact]
        }
      })
    );
    assert.equal(result.ok, true, artifact);
  }
});

test("supports substantial children but keeps lightweight children inline", () => {
  const parent = { client: "pi", sessionId: "parent-1" };
  assert.equal(
    normalizeCheckpoint(checkpoint({ parent, childClass: "substantial" })).childClass,
    "substantial"
  );
  assert.equal(
    normalizeCheckpoint(checkpoint({ parent, childClass: "lightweight" })).childClass,
    "lightweight"
  );
});
