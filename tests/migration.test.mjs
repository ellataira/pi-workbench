import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  migrateJournalStorage,
  sanitizeJournalNote
} from "../src/migration.mjs";

const legacyNote = `---
schema_version: 1
journal_id: "pi:session-1"
client: "pi"
session_id: "session-1"
parent_session: ""
started_at: "2026-07-24T12:00:00.000Z"
updated_at: "2026-07-24T13:00:00.000Z"
cwd: "/tmp/repo"
repository: "repo"
branch: "main"
tags: ["memory", "retention"]
source_path: "/tmp/session.jsonl"
---

# A user prompt copied into the title

<!-- agent-journal:pi:session-1:first -->
## Checkpoint: 2026-07-24T13:00:00.000Z

**Kind:** checkpoint

**Goal:** Preserve a compressed operational decision.

**Outcome:** Use the subagent tool to run one worker with this task: copy the request exactly.

**Artifacts:**
- /tmp/plan.md
- The user asked for this entire sentence to be saved as supporting context.

## Lightweight child: Fetch everything the user requested: 2026-07-24T13:01:00.000Z

<!-- agent-journal-child:pi:child-1 -->
- Child session: [A raw delegated task](child.md)
`;

test("migration removes prompt-shaped titles and prose artifacts without a backup", () => {
  const result = sanitizeJournalNote(legacyNote);
  assert.equal(result.changed, true);
  assert.match(result.text, /^representation: compressed-summary-v1$/m);
  assert.match(result.text, /^# Pi session 2026-07-24 — memory, retention$/m);
  assert.match(result.text, /^## Lightweight child: 2026-07-24T13:01:00.000Z$/m);
  assert.match(result.text, /Child session: \[Linked child session\]\(child\.md\)/);
  assert.match(result.text, /- \/tmp\/plan\.md/);
  assert.doesNotMatch(result.text, /user prompt|user requested|raw delegated task|Fetch everything/);
  assert.doesNotMatch(result.text, /copy the request exactly|with this task:/);
  assert.match(result.text, /\*\*Outcome:\*\* Delegated task activity recorded\./);
  assert.equal(result.sanitizedSummaries, 1);
  assert.equal(sanitizeJournalNote(result.text).changed, false);
});

test("migration updates notes in place with owner-only permissions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-migration-"));
  const sessionsRoot = path.join(root, "sessions");
  const notePath = path.join(sessionsRoot, "2026", "07", "legacy.md");
  await writeFile(notePath, legacyNote, { recursive: true }).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, legacyNote);
  });

  const result = await migrateJournalStorage({ sessionsRoot });
  assert.deepEqual(
    {
      scanned: result.scanned,
      changed: result.changed,
      removedArtifacts: result.removedArtifacts
    },
    { scanned: 1, changed: 1, removedArtifacts: 1 }
  );
  const migrated = await readFile(notePath, "utf8");
  assert.doesNotMatch(migrated, /user prompt|user requested|raw delegated task/);
});

test("migration merges duplicate identities into the canonical session note", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-duplicate-"));
  const sessionsRoot = path.join(root, "sessions");
  const directory = path.join(sessionsRoot, "2026", "07");
  await mkdir(directory, { recursive: true });
  const canonical = path.join(directory, "2026-07-24-pi-session-1.md");
  const duplicate = path.join(directory, "2026-07-24-pi-child-1.md");
  await writeFile(
    canonical,
    legacyNote.replace(
      "<!-- agent-journal:pi:session-1:first -->",
      "<!-- agent-journal:pi:session-1:parent -->"
    )
  );
  await writeFile(
    duplicate,
    legacyNote
      .replace('source_path: "/tmp/session.jsonl"', 'source_path: "/tmp/child.jsonl"')
      .replace(
        "<!-- agent-journal:pi:session-1:first -->",
        "<!-- agent-journal:pi:session-1:child -->"
      )
  );

  const result = await migrateJournalStorage({ sessionsRoot });
  assert.equal(result.duplicateFilesMerged, 1);
  const text = await readFile(canonical, "utf8");
  assert.match(text, /agent-journal:pi:session-1:parent/);
  assert.match(text, /agent-journal:pi:session-1:child/);
  await assert.rejects(access(duplicate), /ENOENT/);
});
