import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentJournal } from "../src/journal.mjs";
import { checkpoint } from "./fixtures.mjs";

test("returns bounded project-scoped memories with provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-search-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });

  await journal.ingest(checkpoint());
  await journal.ingest(
    checkpoint({
      sessionId: "other-project",
      checkpointId: "settled",
      cwd: "/Users/ella.taira/Desktop/unrelated",
      repository: "unrelated",
      title: "Unrelated deployment",
      summary: {
        goal: "Deploy an unrelated service.",
        outcomes: ["Deployment completed."],
        decisions: [],
        nextSteps: [],
        artifacts: [],
        tags: ["deployment"]
      }
    })
  );

  const result = await journal.recall("durable session journal", {
    repository: "datadog-agent",
    limit: 3,
    tokenBudget: 250
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].repository, "datadog-agent");
  assert.match(result.items[0].provenance, /session-123/);
  assert.ok(result.estimatedTokens <= 250);
});

test("archive memories are not returned for automatic recall without a strong project match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-auto-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  await journal.ingest(checkpoint());

  const result = await journal.recall("session journal", {
    automatic: true,
    repository: "different-project"
  });
  assert.deepEqual(result.items, []);
});

test("promoted global memory is available to bounded automatic recall", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-promote-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });

  const promoted = await journal.promote({
    title: "Prefer vendor-neutral model aliases",
    content: "Configure roles by capability and resolve them through provider-neutral aliases.",
    scope: "global",
    sourceIdentity: "pi:session-123",
    tags: ["models"]
  });
  const result = await journal.recall("vendor neutral aliases", {
    automatic: true,
    tokenBudget: 100
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "promoted");
  assert.equal(result.items[0].identity, promoted.identity);
  assert.ok(result.estimatedTokens <= 100);
});

test("duplicate archive titles consume one bounded recall slot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-dedupe-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  await journal.ingest(checkpoint({ sessionId: "duplicate-1" }));
  await journal.ingest(checkpoint({
    sessionId: "duplicate-2",
    checkpointId: "other",
    timestamp: "2026-07-24T19:00:00.000Z"
  }));

  const result = await journal.recall("durable vendor neutral journal", {
    repository: "datadog-agent",
    limit: 3
  });
  assert.equal(result.items.length, 1);
});

test("session topics are searchable even when absent from summary prose", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-topics-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  await journal.ingest(
    checkpoint({
      summary: {
        goal: "Make the connector authenticate reliably.",
        outcomes: ["The connection completed."],
        decisions: [],
        nextSteps: [],
        artifacts: [],
        tags: ["mcp-auth"]
      }
    })
  );

  const result = await journal.recall("mcp auth", {
    automatic: true,
    repository: "datadog-agent"
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].topics, ["mcp-auth"]);
});

test("later checkpoint topics update Markdown and proactive retrieval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-topic-merge-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  const first = await journal.ingest(checkpoint());
  await journal.ingest(
    checkpoint({
      checkpointId: "later-topic",
      timestamp: "2026-07-24T20:00:00.000Z",
      summary: {
        goal: "Record a later durable decision.",
        outcomes: ["A stable topic was identified."],
        decisions: [],
        nextSteps: [],
        artifacts: [],
        tags: ["retention-policy"]
      }
    })
  );

  const text = await readFile(first.notePath, "utf8");
  assert.match(text, /^tags: \[.*"retention-policy".*\]$/m);
  const result = await journal.recall("retention policy", {
    automatic: true,
    repository: "datadog-agent"
  });
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].topics.includes("retention-policy"));
});

test("promoted memory topics participate in automatic recall", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-promoted-topic-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  await journal.promote({
    title: "Connector lesson",
    content: "Prefer a shared authenticated proxy.",
    scope: "global",
    tags: ["slack-mcp"]
  });

  const result = await journal.recall("slack mcp", { automatic: true });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].topics, ["slack-mcp"]);
});

test("project memories stay scoped and daily rollups contain links rather than copied summaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-rollup-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  await journal.ingest(checkpoint({ timestamp: "2026-07-24T12:00:00.000Z" }));
  await journal.promote({
    title: "Datadog Agent convention",
    content: "Use repository-native verification.",
    scope: "project",
    repository: "datadog-agent"
  });

  const unrelated = await journal.recall("repository native verification", {
    automatic: true,
    repository: "unrelated"
  });
  assert.deepEqual(unrelated.items, []);

  const rollup = await journal.dailyRollup("2026-07-24");
  const text = await readFile(rollup.notePath, "utf8");
  assert.match(text, /Session summaries: 1/);
  assert.match(text, /\[.*\]\(\.\.\/\.\.\/\.\.\/sessions\//);
  assert.doesNotMatch(text, /Implement a durable session journal/);
});

test("recall marks a relevant missing local note for verified Drive rehydration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-drive-tier-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  const ingested = await journal.ingest(checkpoint());
  const content = await readFile(ingested.notePath, "utf8");
  await journal.recordDriveArchive({
    notePath: ingested.notePath,
    driveFileId: "drive-file-123",
    driveFolderId: "drive-folder-123",
    driveFileName: "agent-journal-session-123.md",
    noteSha256: "a".repeat(64)
  });
  await rm(ingested.notePath);

  const result = await journal.recall("durable session journal", {
    repository: "datadog-agent"
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].rehydration, {
    provider: "google-drive",
    driveFileId: "drive-file-123",
    driveFolderId: "drive-folder-123",
    driveFileName: "agent-journal-session-123.md",
    driveUrl: "https://drive.google.com/open?id=drive-file-123",
    expectedSha256: "a".repeat(64)
  });
  assert.doesNotMatch(result.items[0].excerpt, /"role":|"type":"message"/);
  await assert.rejects(access(ingested.notePath), { code: "ENOENT" });
  assert.ok(content.includes("compressed-summary-v1"));
});

test("Drive rehydration verifies content before atomically restoring a note", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-drive-restore-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  const ingested = await journal.ingest(checkpoint());
  const content = await readFile(ingested.notePath, "utf8");
  const noteSha256 = createHash("sha256").update(content).digest("hex");
  await journal.recordDriveArchive({
    notePath: ingested.notePath,
    driveFileId: "drive-file-restore",
    driveFolderId: "drive-folder-123",
    driveFileName: "agent-journal-restore.md",
    noteSha256
  });
  await rm(ingested.notePath);

  await assert.rejects(
    journal.rehydrateDriveArchive("drive-file-restore", "tampered"),
    /does not match/
  );
  await assert.rejects(access(ingested.notePath), { code: "ENOENT" });

  const restored = await journal.rehydrateDriveArchive(
    "drive-file-restore",
    content
  );
  assert.equal(restored.notePath, ingested.notePath);
  assert.equal(await readFile(ingested.notePath, "utf8"), content);
  const recalled = await journal.recall("durable session journal", {
    repository: "datadog-agent"
  });
  assert.equal(recalled.items[0].rehydration, undefined);
});

test("retention receipts rebuild searchable cold metadata after SQLite loss", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-rebuild-cold-"));
  const stateRoot = path.join(root, "state");
  const vaultRoot = path.join(root, "vault");
  const notePath = path.join(vaultRoot, "sessions", "2026", "01", "archived.md");
  const receiptsRoot = path.join(stateRoot, "retention-receipts");
  await mkdir(receiptsRoot, { recursive: true });
  await writeFile(
    path.join(receiptsRoot, "receipt.json"),
    JSON.stringify({
      schemaVersion: 1,
      representation: "compressed-summary-v1",
      sourcePath: "/tmp/removed.jsonl",
      notePath,
      noteSha256: "b".repeat(64),
      driveFileId: "drive-rebuild",
      driveFolderId: "drive-folder-rebuild",
      driveFileName: "agent-journal-rebuild.md",
      verifiedAt: "2026-07-01T00:00:00.000Z",
      search: {
        identity: "pi:archived-session",
        client: "pi",
        sessionId: "archived-session",
        repository: "datadog-agent",
        cwd: "/work/datadog-agent",
        title: "Archived sender lifecycle",
        updatedAt: "2026-04-01T00:00:00.000Z",
        topics: ["sender-lifecycle"],
        excerpt: "The scheduler owns sender shutdown and cleanup."
      }
    })
  );

  const rebuilt = new AgentJournal({ vaultRoot, stateRoot });
  const result = await rebuilt.recall("sender shutdown cleanup", {
    automatic: true,
    repository: "datadog-agent"
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].identity, "pi:archived-session");
  assert.equal(result.items[0].rehydration.driveFileId, "drive-rebuild");
  assert.equal(
    result.items[0].rehydration.driveUrl,
    "https://drive.google.com/open?id=drive-rebuild"
  );
  assert.equal(result.items[0].rehydration.driveFolderId, "drive-folder-rebuild");
  assert.equal(result.items[0].rehydration.driveFileName, "agent-journal-rebuild.md");
  assert.deepEqual(result.items[0].topics, ["sender-lifecycle"]);
});
