#!/usr/bin/env node

import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentJournal } from "../src/journal.mjs";
import {
  autoCheckpointMessage,
  checkpointCadenceFromEntries,
  createRunState,
  recordToolCompletion,
  shouldQueueAutoCheckpoint
} from "../src/pi-memory-policy.mjs";
import {
  claimDriveBackup,
  confirmDriveBackup,
  evictDriveArchivedNotes,
  retentionCandidates
} from "../src/retention-audit.mjs";

const root = await mkdtemp(path.join(tmpdir(), "agent-memory-canary-"));
try {
  const durable = createRunState("Implement the isolated checkpoint canary");
  recordToolCompletion(durable, { toolName: "edit", isError: false });
  const checkpointQueued = shouldQueueAutoCheckpoint(
    durable,
    [{ role: "assistant", content: [{ type: "text", text: "Completed." }] }],
    { lastCheckpointAt: undefined }
  );
  const checkpointRun = createRunState(autoCheckpointMessage(), {
    checkpointRun: true,
    automaticCheckpoint: true
  });
  recordToolCompletion(checkpointRun, {
    toolName: "journal_checkpoint",
    isError: false,
    result: { details: { status: "appended" } }
  });
  const savedAt = "2026-07-30T13:00:00.000Z";
  const restoredCadence = checkpointCadenceFromEntries([
    {
      type: "custom",
      customType: "agent-journal-checkpoint-state",
      data: { savedAt, durableWorkPending: false }
    }
  ]);

  const vaultRoot = path.join(root, "vault");
  const stateRoot = path.join(root, "state");
  const sessionsRoot = path.join(root, "native");
  const receiptsRoot = path.join(stateRoot, "retention-receipts");
  await mkdir(sessionsRoot, { recursive: true });
  const sessionPath = path.join(sessionsRoot, "old.jsonl");
  await writeFile(sessionPath, '{"type":"temporary-canary-record"}\n', {
    mode: 0o600
  });
  const oldTime = new Date("2026-01-01T12:00:00.000Z");
  await utimes(sessionPath, oldTime, oldTime);

  const journal = new AgentJournal({ vaultRoot, stateRoot });
  const note = await journal.ingest({
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    client: "pi",
    sessionId: "retention-canary",
    checkpointId: "first",
    checkpointKind: "checkpoint",
    timestamp: "2026-01-01T13:00:00.000Z",
    startedAt: "2026-01-01T12:00:00.000Z",
    cwd: root,
    repository: "canary",
    branch: "",
    title: "Ignored in favor of the compressed goal",
    summary: {
      goal: "Verify retention canary archive and restoration.",
      outcomes: ["The isolated compressed note is available for retrieval."],
      decisions: [],
      nextSteps: [],
      artifacts: [],
      tags: ["retention-canary"]
    },
    usage: {},
    sourcePath: sessionPath,
    status: "checkpoint",
    childClass: "none"
  });
  const now = new Date("2026-07-30T14:00:00.000Z");
  const retention = await retentionCandidates({
    sessionsRoot,
    journalRoot: journal.sessionsRoot,
    receiptsRoot,
    now,
    retentionDays: 30
  });
  const candidate = retention.candidates[0];
  const claim = await claimDriveBackup({
    receiptsRoot,
    sessionPath,
    notePath: candidate.notePath,
    noteSha256: candidate.noteSha256,
    backupName: candidate.backupName,
    now
  });
  const confirmed = await confirmDriveBackup({
    sessionsRoot,
    sessionPath,
    notePath: candidate.notePath,
    claimToken: claim.claimToken,
    driveFileId: "canary-drive-file",
    driveFolderId: "canary-drive-folder",
    remoteContent: candidate.backupContent,
    journalRoot: journal.sessionsRoot,
    receiptsRoot,
    now,
    retentionDays: 30,
    onVerified: (receipt) =>
      journal.recordDriveArchive({
        notePath: receipt.notePath,
        driveFileId: receipt.driveFileId,
        driveFolderId: receipt.driveFolderId,
        driveFileName: receipt.driveFileName,
        noteSha256: receipt.noteSha256
      })
  });
  await utimes(note.notePath, oldTime, oldTime);
  const eviction = await evictDriveArchivedNotes({
    journalRoot: journal.sessionsRoot,
    receiptsRoot,
    now,
    localRetentionDays: 90
  });
  const recalled = await journal.recall("retention canary archive restoration", {
    automatic: true,
    repository: "canary",
    limit: 3,
    tokenBudget: 400
  });
  const cold = recalled.items.find((item) => item.rehydration);
  const restored = await journal.rehydrateDriveArchive(
    cold.rehydration.driveFileId,
    candidate.backupContent
  );
  await access(restored.notePath);

  process.stdout.write(
    `${JSON.stringify(
      {
        checkpoint: {
          queued: checkpointQueued,
          confirmed: checkpointRun.checkpointSaved,
          persisted:
            restoredCadence.lastCheckpointAt === Date.parse(savedAt) &&
            restoredCadence.durableWorkPending === false
        },
        retention: {
          candidateState: candidate.backupState,
          nativeDeleted: confirmed.deleted,
          coldNoteEvicted: eviction.evictedCount === 1,
          recallRequestedRehydration: Boolean(cold),
          restored: restored.restored
        },
        isolated: true
      },
      null,
      2
    )}\n`
  );
} finally {
  if (root.startsWith(path.join(tmpdir(), "agent-memory-canary-"))) {
    await rm(root, { recursive: true, force: true });
  }
}
