import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentJournal } from "../src/journal.mjs";
import { checkpoint } from "./fixtures.mjs";

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-"));
  return {
    root,
    journal: new AgentJournal({
      vaultRoot: path.join(root, "vault"),
      stateRoot: path.join(root, "state")
    })
  };
}

test("creates one session note and appends idempotent checkpoints", async () => {
  const { root, journal } = await harness();
  const first = await journal.ingest(checkpoint());
  const duplicate = await journal.ingest(checkpoint());
  const second = await journal.ingest(
    checkpoint({
      checkpointId: "shutdown-789",
      checkpointKind: "shutdown",
      timestamp: "2026-07-24T19:00:00.000Z"
    })
  );

  assert.equal(first.status, "appended");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(second.status, "appended");
  assert.equal(first.notePath, second.notePath);

  const text = await readFile(first.notePath, "utf8");
  assert.equal(text.match(/agent-journal:pi:session-123:/g)?.length, 2);
  assert.doesNotMatch(text, /rawTranscript|raw conversation/);

  const monthDir = path.join(root, "vault", "sessions", "2026", "07");
  assert.equal((await readdir(monthDir)).length, 1);
});

test("journal state, SQLite sidecars, and notes are owner-only", async () => {
  const { root, journal } = await harness();
  const result = await journal.ingest(checkpoint());
  const stateRoot = path.join(root, "state");

  assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(result.notePath)).mode & 0o777, 0o600);
  for (const name of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) {
    assert.equal((await stat(path.join(stateRoot, name))).mode & 0o777, 0o600, name);
  }
});

test("promotion stores an explicit compressed representation and rejects transcripts", async () => {
  const { journal } = await harness();
  const result = await journal.promote({
    title: "Stable connector lesson",
    content: "Use one authenticated proxy and verify the connector with a read operation.",
    scope: "global",
    sourceIdentity: "pi:session-123",
    tags: ["connector"]
  });
  const text = await readFile(result.notePath, "utf8");
  assert.match(text, /^representation: compressed-summary-v1$/m);

  await assert.rejects(
    journal.promote({
      title: "Copied exchange",
      content: "User: configure it\nAssistant: configuration finished",
      scope: "global",
      sourceIdentity: "pi:session-123",
      tags: []
    }),
    /transcript/i
  );
});

test("disk rebuild restores an unindexed compressed session note", async () => {
  const { journal } = await harness();
  const result = await journal.ingest(checkpoint());
  journal.database.prepare("DELETE FROM journal_fts WHERE identity = ?").run("pi:session-123");
  journal.database.prepare("DELETE FROM journal_topics WHERE identity = ?").run("pi:session-123");
  journal.database.prepare("DELETE FROM journal_documents WHERE identity = ?").run("pi:session-123");
  assert.equal(journal.lookup("pi:session-123"), undefined);

  const rebuilt = await journal.rebuildIndexFromDisk();
  assert.equal(rebuilt.sessionDocuments, 1);
  assert.equal(journal.lookup("pi:session-123").note_path, result.notePath);
});

test("keeps lightweight child activity inline with the parent", async () => {
  const { journal } = await harness();
  const parent = await journal.ingest(checkpoint());
  const child = await journal.ingest(
    checkpoint({
      sessionId: "child-1",
      checkpointId: "child-done",
      parent: { client: "pi", sessionId: "session-123" },
      childClass: "lightweight",
      title: "Search shard"
    })
  );

  assert.equal(child.notePath, parent.notePath);
  const text = await readFile(parent.notePath, "utf8");
  assert.match(text, /Lightweight child: 2026-07-24T18:00:00.000Z/);
  assert.doesNotMatch(text, /Search shard/);
});

test("creates a linked note for a substantial child", async () => {
  const { journal } = await harness();
  const parent = await journal.ingest(checkpoint());
  const child = await journal.ingest(
    checkpoint({
      sessionId: "child-2",
      checkpointId: "child-done",
      parent: { client: "pi", sessionId: "session-123" },
      childClass: "substantial",
      title: "Implement journal writer"
    })
  );

  assert.notEqual(child.notePath, parent.notePath);
  const parentText = await readFile(parent.notePath, "utf8");
  const childText = await readFile(child.notePath, "utf8");
  assert.match(parentText, /Child session: \[Linked child session\]/);
  assert.doesNotMatch(parentText, /Implement journal writer/);
  assert.match(childText, /parent_session: "pi:session-123"/);
});

test("creates a recovered parent link when a substantial child finishes first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-child-first-"));
  const journal = new AgentJournal({
    vaultRoot: path.join(root, "vault"),
    stateRoot: path.join(root, "state")
  });
  const child = checkpoint({
    sessionId: "child-first",
    checkpointId: "done",
    childClass: "substantial",
    parent: { client: "pi", sessionId: "parent-later" },
    title: "Implement cache"
  });

  const result = await journal.ingest(child);
  const parent = journal.lookup("pi:parent-later");
  assert.ok(parent);
  const parentText = await readFile(parent.note_path, "utf8");
  assert.match(parentText, /Child session: \[Linked child session\]/);
  assert.doesNotMatch(parentText, /Implement cache/);
  assert.match(parentText, /agent-journal-child:pi:child-first/);
  assert.notEqual(parent.note_path, result.notePath);
});

test("returns compressed daily candidates without conversation content", async () => {
  const { journal } = await harness();
  await journal.ingest(checkpoint({ timestamp: "2026-07-24T12:00:00.000Z" }));
  await journal.ingest(
    checkpoint({
      sessionId: "other-day",
      checkpointId: "done",
      timestamp: "2026-07-25T12:00:00.000Z"
    })
  );

  const candidates = await journal.distillationCandidates("2026-07-24");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].identity, "pi:session-123");
  assert.ok(candidates[0].topics.includes("agent-journal"));
  assert.doesNotMatch(
    JSON.stringify(candidates),
    /"(?:messages|prompt|response|conversation|turns)":/i
  );
});

test("only one concurrent Pi session can claim the daily review", async () => {
  const { journal } = await harness();
  const claims = await Promise.all([
    journal.claimDistillation("2026-07-26"),
    journal.claimDistillation("2026-07-26"),
    journal.claimDistillation("2026-07-26")
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const state = await journal.maintenanceState();
  assert.equal(state.lastPromptedFor, "2026-07-26");
});
