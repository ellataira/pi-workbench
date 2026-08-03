import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkpointFromCodexFile } from "../src/adapters/codex.mjs";
import { checkpointFromClaudeFile } from "../src/adapters/claude.mjs";
import {
  checkpointFromPiEntries,
  checkpointFromPiFile,
  classifyPiChildEnvironment
} from "../src/adapters/pi.mjs";
import { checkpointSourceEntries } from "../src/pi-memory-policy.mjs";
import { checkpoint } from "./fixtures.mjs";

const compressedSummary = checkpoint().summary;

test("normalizes a Codex user session without retaining messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "journal-codex-"));
  const source = path.join(directory, "session.jsonl");
  const records = [
    {
      timestamp: "2026-07-24T17:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-1",
        cwd: "/tmp/example",
        thread_source: "user",
        timestamp: "2026-07-24T17:00:00.000Z"
      }
    },
    {
      timestamp: "2026-07-24T17:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Implement the durable journal." }]
      }
    },
    {
      timestamp: "2026-07-24T17:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Completed the journal core.\n- Added atomic writes.\n- Tests pass." }]
      }
    }
  ];
  await writeFile(source, `${records.map(JSON.stringify).join("\n")}\n`);

  await assert.rejects(() => checkpointFromCodexFile(source), /compressed summary is required/i);
  const value = await checkpointFromCodexFile(source, { summary: compressedSummary });
  assert.equal(value.client, "codex");
  assert.equal(value.sessionId, "codex-1");
  assert.deepEqual(value.summary, compressedSummary);
  assert.doesNotMatch(JSON.stringify(value), /Implement the durable journal|Added atomic writes/);
  assert.equal("messages" in value, false);
  assert.equal("transcript" in value, false);
});

test("normalizes a Claude session and aggregates usage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "journal-claude-"));
  const source = path.join(directory, "claude-1.jsonl");
  const records = [
    {
      type: "user",
      sessionId: "claude-1",
      uuid: "u1",
      timestamp: "2026-07-24T17:00:00.000Z",
      cwd: "/tmp/example",
      gitBranch: "main",
      message: { role: "user", content: "Review the memory design." }
    },
    {
      type: "assistant",
      sessionId: "claude-1",
      uuid: "a1",
      timestamp: "2026-07-24T17:02:00.000Z",
      cwd: "/tmp/example",
      gitBranch: "main",
      message: {
        role: "assistant",
        model: "claude-example",
        content: [{ type: "text", text: "Review complete.\n- Retrieval is bounded.\nNext: add provenance." }],
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 }
      }
    }
  ];
  await writeFile(source, `${records.map(JSON.stringify).join("\n")}\n`);

  await assert.rejects(() => checkpointFromClaudeFile(source), /compressed summary is required/i);
  const value = await checkpointFromClaudeFile(source, { summary: compressedSummary });
  assert.equal(value.client, "claude");
  assert.equal(value.usage.inputTokens, 100);
  assert.equal(value.usage.outputTokens, 40);
  assert.equal(value.usage.cacheReadTokens, 10);
  assert.equal(value.usage.model, "claude-example");
  assert.deepEqual(value.summary, compressedSummary);
  assert.doesNotMatch(JSON.stringify(value), /Review the memory design|Retrieval is bounded/);
});

test("normalizes Pi branch entries and honors substantial child metadata", () => {
  const entries = [
    {
      type: "message",
      id: "u1",
      timestamp: "2026-07-24T17:00:00.000Z",
      message: { role: "user", content: "Implement the supervisor bridge." }
    },
    {
      type: "message",
      id: "a1",
      timestamp: "2026-07-24T17:03:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Implemented the bridge.\n- Added focus support." }],
        model: "gpt-example",
        usage: {
          input: 200,
          output: 50,
          cacheRead: 20,
          cacheWrite: 5,
          cost: { total: 0.2 }
        }
      }
    }
  ];
  const value = checkpointFromPiEntries(entries, {
    sessionId: "pi-child",
    cwd: "/tmp/example",
    title: "Implement the supervisor bridge.",
    summary: compressedSummary,
    parent: { client: "pi", sessionId: "pi-parent" },
    childClass: "substantial"
  });

  assert.equal(value.client, "pi");
  assert.equal(value.checkpointId, "a1");
  assert.equal(value.childClass, "substantial");
  assert.deepEqual(value.parent, { client: "pi", sessionId: "pi-parent" });
  assert.equal(value.usage.inputTokens, 200);
  assert.equal(value.usage.costUsd, 0.2);
  assert.equal(value.title, compressedSummary.goal);
  assert.doesNotMatch(value.title, /Implement the supervisor bridge/);
});

test("rejects a Pi checkpoint that copies a prompt into its summary", () => {
  const copied = "Implement the supervisor bridge and preserve every exact user instruction in the durable note.";
  const entries = [{
    type: "message",
    id: "u1",
    timestamp: "2026-07-24T17:00:00.000Z",
    message: { role: "user", content: copied }
  }];
  assert.throws(
    () => checkpointFromPiEntries(entries, {
      sessionId: "pi-copy",
      cwd: "/tmp/example",
      summary: {
        ...compressedSummary,
        goal: copied
      }
    }),
    /copies raw conversation content/i
  );
});

test("accepts a semantic Pi checkpoint after removing private self-reference", () => {
  const entries = [{
    type: "message",
    id: "a1",
    timestamp: "2026-07-24T17:00:00.000Z",
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        name: "journal_checkpoint",
        arguments: compressedSummary
      }]
    }
  }];
  const value = checkpointFromPiEntries(checkpointSourceEntries(entries), {
    sessionId: "pi-semantic",
    cwd: "/tmp/example",
    summary: compressedSummary
  });
  assert.equal(value.summary, compressedSummary);
});

test("promotes an implementing Claude subagent to a linked substantial session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "journal-claude-child-"));
  const source = path.join(directory, "agent-worker.jsonl");
  const records = [
    {
      type: "user",
      sessionId: "claude-parent",
      agentId: "worker-1",
      uuid: "u1",
      timestamp: "2026-07-24T17:00:00.000Z",
      cwd: "/tmp/example",
      isSidechain: true,
      message: { role: "user", content: "Implement the journal writer." }
    },
    {
      type: "assistant",
      sessionId: "claude-parent",
      agentId: "worker-1",
      uuid: "a1",
      timestamp: "2026-07-24T17:02:00.000Z",
      cwd: "/tmp/example",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/tmp/example/core.js" } },
          { type: "text", text: "Implemented the journal writer." }
        ]
      }
    }
  ];
  await writeFile(source, `${records.map(JSON.stringify).join("\n")}\n`);

  const value = await checkpointFromClaudeFile(source, { summary: compressedSummary });
  assert.equal(value.sessionId, "claude-parent-agent-worker-1");
  assert.equal(value.childClass, "substantial");
  assert.deepEqual(value.parent, { client: "claude", sessionId: "claude-parent" });
});

test("recovers a persisted Pi session file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "journal-pi-file-"));
  const source = path.join(directory, "pi.jsonl");
  const records = [
    {
      type: "session",
      version: 3,
      id: "pi-file-1",
      timestamp: "2026-07-24T17:00:00.000Z",
      cwd: "/tmp/example"
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-07-24T17:01:00.000Z",
      message: { role: "user", content: "Recover this Pi session." }
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-07-24T17:02:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered successfully." }],
        usage: { input: 10, output: 5, cost: { total: 0.01 } }
      }
    }
  ];
  await writeFile(source, `${records.map(JSON.stringify).join("\n")}\n`);

  await assert.rejects(() => checkpointFromPiFile(source), /compressed summary is required/i);
  const value = await checkpointFromPiFile(source, { summary: compressedSummary });
  assert.equal(value.client, "pi");
  assert.equal(value.sessionId, "pi-file-1");
  assert.equal(value.checkpointKind, "recovered");
  assert.equal(value.sourcePath, source);
});

test("classifies Pi research fanout inline and implementing agents as substantial", () => {
  assert.deepEqual(
    classifyPiChildEnvironment({
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_PARENT_SESSION: "parent-1",
      PI_SUBAGENT_CHILD_AGENT: "scout"
    }),
    {
      parent: { client: "pi", sessionId: "parent-1" },
      childClass: "lightweight"
    }
  );
  assert.deepEqual(
    classifyPiChildEnvironment({
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_PARENT_SESSION: "parent-1",
      PI_SUBAGENT_CHILD_AGENT: "worker"
    }),
    {
      parent: { client: "pi", sessionId: "parent-1" },
      childClass: "substantial"
    }
  );
});
