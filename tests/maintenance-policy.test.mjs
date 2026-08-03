import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  distillationTarget,
  isRetentionEligible,
  shouldRunCleanupAudit
} from "../src/maintenance-policy.mjs";
import {
  auditRetentionReceipts,
  auditNativeSessions,
  claimDriveBackup,
  confirmDriveBackup,
  evictDriveArchivedNotes,
  recordDriveIntegrity,
  retentionIntegritySample,
  retentionCandidates
} from "../src/retention-audit.mjs";

test("daily distillation becomes due at 9 AM New York for the previous day", () => {
  const before = distillationTarget(
    new Date("2026-07-27T12:59:59.000Z"),
    {},
    { hour: 9, timeZone: "America/New_York" }
  );
  assert.equal(before, undefined);

  const due = distillationTarget(
    new Date("2026-07-27T13:00:00.000Z"),
    {},
    { hour: 9, timeZone: "America/New_York" }
  );
  assert.equal(due, "2026-07-26");
});

test("daily distillation prompts once and remains complete once reviewed", () => {
  const now = new Date("2026-07-27T14:00:00.000Z");
  assert.equal(
    distillationTarget(now, { lastPromptedFor: "2026-07-26" }),
    undefined
  );
  assert.equal(
    distillationTarget(now, { completedThrough: "2026-07-26" }),
    undefined
  );
});

test("daily distillation catches up one missed day at a time", () => {
  const target = distillationTarget(
    new Date("2026-07-27T14:00:00.000Z"),
    { completedThrough: "2026-07-23" }
  );
  assert.equal(target, "2026-07-24");
});

test("native sessions become cleanup candidates after 30 days", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(
    isRetentionEligible("2026-07-01T11:59:59.000Z", now, 30),
    true
  );
  assert.equal(
    isRetentionEligible("2026-07-01T12:00:01.000Z", now, 30),
    false
  );
});

test("cleanup audit cadence is weekly", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(shouldRunCleanupAudit(now, {}), true);
  assert.equal(
    shouldRunCleanupAudit(now, {
      lastCleanupAuditAt: "2026-07-25T12:00:01.000Z"
    }),
    false
  );
  assert.equal(
    shouldRunCleanupAudit(now, {
      lastCleanupAuditAt: "2026-07-24T11:59:59.000Z"
    }),
    true
  );
});

test("retention audit reports old sessions but never deletes them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-retention-"));
  const nested = path.join(root, "project");
  await mkdir(nested);
  const oldSession = path.join(nested, "old.jsonl");
  const recentSession = path.join(nested, "recent.jsonl");
  await writeFile(oldSession, "{}\n");
  await writeFile(recentSession, "{}\n");
  const oldTime = new Date("2026-06-01T12:00:00.000Z");
  const recentTime = new Date("2026-07-20T12:00:00.000Z");
  await utimes(oldSession, oldTime, oldTime);
  await utimes(recentSession, recentTime, recentTime);

  const result = await auditNativeSessions(
    root,
    new Date("2026-07-31T12:00:00.000Z"),
    30
  );
  assert.equal(result.candidateCount, 1);
  assert.equal(result.deletionCount, 0);
  assert.equal(result.candidates[0].path, oldSession);
  assert.equal(result.candidates[0].backupState, "unverified");
  assert.equal(result.candidates[0].action, "keep");
});

async function retentionFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-journal-retention-"));
  const sessionsRoot = path.join(root, "native");
  const journalRoot = path.join(root, "journal");
  const receiptsRoot = path.join(root, "receipts");
  await mkdir(sessionsRoot);
  await mkdir(journalRoot);
  const sessionPath = path.join(sessionsRoot, "old.jsonl");
  const notePath = path.join(journalRoot, "old.md");
  await writeFile(sessionPath, '{"type":"message"}\n');
  await writeFile(
    notePath,
    [
      "---",
      "schema_version: 1",
      "representation: compressed-summary-v1",
      `source_path: ${JSON.stringify(sessionPath)}`,
      "---",
      "",
      "# Compressed session",
      "",
      "**Outcome:** retained without transcript."
    ].join("\n")
  );
  const oldTime = new Date("2026-06-01T12:00:00.000Z");
  await utimes(sessionPath, oldTime, oldTime);
  return {
    sessionsRoot,
    journalRoot,
    receiptsRoot,
    sessionPath,
    notePath,
    driveFolderId: "drive-folder-123"
  };
}

async function claimedCandidate(fixture, now = new Date("2026-07-31T12:00:00.000Z")) {
  const [candidate] = (
    await retentionCandidates({
      ...fixture,
      now,
      retentionDays: 30
    })
  ).candidates;
  const claim = await claimDriveBackup({
    receiptsRoot: fixture.receiptsRoot,
    sessionPath: candidate.sessionPath,
    notePath: candidate.notePath,
    noteSha256: candidate.noteSha256,
    backupName: candidate.backupName,
    now
  });
  return { candidate, claim };
}

test("retention exposes only a compressed summary for Drive backup", async () => {
  const fixture = await retentionFixture();
  const result = await retentionCandidates({
    ...fixture,
    now: new Date("2026-07-31T12:00:00.000Z"),
    retentionDays: 30
  });

  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].backupState, "needs-drive-backup");
  assert.equal(result.candidates[0].sessionPath, fixture.sessionPath);
  assert.equal(result.candidates[0].notePath, fixture.notePath);
  assert.match(result.candidates[0].backupContent, /compressed-summary-v1/);
  assert.doesNotMatch(result.candidates[0].backupContent, /"type":"message"/);
});

test("retention candidates are returned in stable batches of at most five", async () => {
  const fixture = await retentionFixture();
  const baseNote = await readFile(fixture.notePath, "utf8");
  const oldTime = new Date("2026-06-01T12:00:00.000Z");
  for (let index = 1; index < 7; index += 1) {
    const sessionPath = path.join(fixture.sessionsRoot, `old-${index}.jsonl`);
    const notePath = path.join(fixture.journalRoot, `old-${index}.md`);
    await writeFile(sessionPath, "{}\n");
    await writeFile(
      notePath,
      baseNote.replace(JSON.stringify(fixture.sessionPath), JSON.stringify(sessionPath))
    );
    await utimes(sessionPath, oldTime, oldTime);
  }

  const first = await retentionCandidates({
    ...fixture,
    now: new Date("2026-07-31T12:00:00.000Z"),
    retentionDays: 30
  });
  assert.equal(first.candidateCount, 7);
  assert.equal(first.returnedCount, 5);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await retentionCandidates({
    ...fixture,
    cursor: first.nextCursor,
    now: new Date("2026-07-31T12:00:00.000Z"),
    retentionDays: 30
  });
  assert.equal(second.returnedCount, 2);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.candidates, ...second.candidates].map((item) => item.sessionPath)).size,
    7
  );
});

test("Drive upload claims prevent concurrent duplicate creates and are idempotent", async () => {
  const fixture = await retentionFixture();
  const { candidate, claim } = await claimedCandidate(fixture);
  assert.equal(claim.status, "claimed");
  assert.ok(claim.claimToken);

  const concurrent = await claimDriveBackup({
    receiptsRoot: fixture.receiptsRoot,
    sessionPath: candidate.sessionPath,
    notePath: candidate.notePath,
    noteSha256: candidate.noteSha256,
    backupName: candidate.backupName,
    now: new Date("2026-07-31T12:01:00.000Z")
  });
  assert.equal(concurrent.status, "in-progress");
  assert.equal(concurrent.claimToken, undefined);

  await assert.rejects(
    confirmDriveBackup({
      ...fixture,
      sessionPath: fixture.sessionPath,
      notePath: fixture.notePath,
      claimToken: "wrong-token",
      driveFileId: "drive-file-123",
      remoteContent: candidate.backupContent,
      now: new Date("2026-07-31T12:05:00.000Z")
    }),
    /claim/
  );
  await access(fixture.sessionPath);
});

test("matching Drive content creates a receipt and deletes only the native transcript", async () => {
  const fixture = await retentionFixture();
  const { candidate, claim } = await claimedCandidate(fixture);

  const result = await confirmDriveBackup({
    ...fixture,
    sessionPath: fixture.sessionPath,
    notePath: fixture.notePath,
    claimToken: claim.claimToken,
    driveFileId: "drive-file-123",
    remoteContent: candidate.backupContent,
    now: new Date("2026-07-31T12:05:00.000Z")
  });

  assert.equal(result.deleted, true);
  await assert.rejects(access(fixture.sessionPath), { code: "ENOENT" });
  assert.match(await readFile(fixture.notePath, "utf8"), /compressed-summary-v1/);
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(receipt.driveFileId, "drive-file-123");
  assert.equal(receipt.driveFolderId, "drive-folder-123");
  assert.equal(receipt.driveFileName, candidate.backupName);
  assert.equal(receipt.representation, "compressed-summary-v1");
  assert.equal(receipt.sourcePath, fixture.sessionPath);
  assert.equal(receipt.search.title, "Compressed session");
  assert.match(receipt.search.excerpt, /retained without transcript/);

  const repeated = await claimDriveBackup({
    receiptsRoot: fixture.receiptsRoot,
    sessionPath: fixture.sessionPath,
    notePath: fixture.notePath,
    noteSha256: candidate.noteSha256,
    backupName: candidate.backupName
  });
  assert.equal(repeated.status, "already-verified");
  assert.equal(repeated.driveFileId, "drive-file-123");
});

test("missing summary or mismatched Drive content never deletes a native session", async () => {
  const fixture = await retentionFixture();
  const { claim } = await claimedCandidate(fixture);
  await assert.rejects(
    confirmDriveBackup({
      ...fixture,
      sessionPath: fixture.sessionPath,
      notePath: fixture.notePath,
      claimToken: claim.claimToken,
      driveFileId: "drive-file-123",
      remoteContent: "tampered",
      now: new Date("2026-07-31T12:05:00.000Z")
    }),
    /does not match/
  );
  await access(fixture.sessionPath);

  const missingSummary = path.join(fixture.sessionsRoot, "missing.jsonl");
  await writeFile(missingSummary, "{}\n");
  const oldTime = new Date("2026-06-01T12:00:00.000Z");
  await utimes(missingSummary, oldTime, oldTime);
  const result = await retentionCandidates({
    ...fixture,
    now: new Date("2026-07-31T12:00:00.000Z"),
    retentionDays: 30
  });
  const missing = result.candidates.find((item) => item.sessionPath === missingSummary);
  assert.equal(missing.backupState, "compressed-summary-missing");
  assert.equal(missing.action, "keep");
});

test("Drive confirmation cannot delete JSONL outside the configured native session root", async () => {
  const fixture = await retentionFixture();
  const { candidate, claim } = await claimedCandidate(fixture);

  await assert.rejects(
    confirmDriveBackup({
      ...fixture,
      sessionsRoot: path.join(fixture.sessionsRoot, "different-root"),
      sessionPath: fixture.sessionPath,
      notePath: fixture.notePath,
      claimToken: claim.claimToken,
      driveFileId: "drive-file-123",
      remoteContent: candidate.backupContent,
      now: new Date("2026-07-31T12:05:00.000Z")
    }),
    /outside the configured native session root/
  );
  await access(fixture.sessionPath);
});

test("native JSONL remains when the searchable Drive catalog cannot be updated", async () => {
  const fixture = await retentionFixture();
  const { candidate, claim } = await claimedCandidate(fixture);

  await assert.rejects(
    confirmDriveBackup({
      ...fixture,
      sessionPath: fixture.sessionPath,
      notePath: fixture.notePath,
      claimToken: claim.claimToken,
      driveFileId: "drive-file-123",
      remoteContent: candidate.backupContent,
      now: new Date("2026-07-31T12:05:00.000Z"),
      onVerified: async () => {
        throw new Error("catalog unavailable");
      }
    }),
    /catalog unavailable/
  );
  await access(fixture.sessionPath);
});

test("verified compressed Markdown moves to Drive-only storage after 90 days", async () => {
  const fixture = await retentionFixture();
  const oldTime = new Date("2026-04-01T12:00:00.000Z");
  await utimes(fixture.notePath, oldTime, oldTime);
  const { candidate, claim } = await claimedCandidate(fixture);
  await confirmDriveBackup({
    ...fixture,
    sessionPath: fixture.sessionPath,
    notePath: fixture.notePath,
    claimToken: claim.claimToken,
    driveFileId: "drive-file-evict",
    remoteContent: candidate.backupContent,
    now: new Date("2026-07-31T12:05:00.000Z")
  });

  const result = await evictDriveArchivedNotes({
    journalRoot: fixture.journalRoot,
    receiptsRoot: fixture.receiptsRoot,
    now: new Date("2026-07-31T12:10:00.000Z"),
    localRetentionDays: 90
  });
  assert.equal(result.evictedCount, 1);
  await assert.rejects(access(fixture.notePath), { code: "ENOENT" });
});

test("cold-tier eviction keeps changed or unverified Markdown", async () => {
  const fixture = await retentionFixture();
  const oldTime = new Date("2026-04-01T12:00:00.000Z");
  await utimes(fixture.notePath, oldTime, oldTime);
  const result = await evictDriveArchivedNotes({
    journalRoot: fixture.journalRoot,
    receiptsRoot: fixture.receiptsRoot,
    now: new Date("2026-07-31T12:10:00.000Z"),
    localRetentionDays: 90
  });
  assert.equal(result.evictedCount, 0);
  await access(fixture.notePath);
});

test("integrity sampling is bounded and verifies exact Drive readback", async () => {
  const fixture = await retentionFixture();
  const { candidate, claim } = await claimedCandidate(fixture);
  await confirmDriveBackup({
    ...fixture,
    sessionPath: fixture.sessionPath,
    notePath: fixture.notePath,
    claimToken: claim.claimToken,
    driveFileId: "drive-file-integrity",
    remoteContent: candidate.backupContent,
    now: new Date("2026-07-31T12:05:00.000Z")
  });

  const sample = await retentionIntegritySample(fixture.receiptsRoot, 5);
  assert.equal(sample.items.length, 1);
  assert.equal(sample.items[0].driveFileId, "drive-file-integrity");
  await assert.rejects(
    recordDriveIntegrity({
      receiptsRoot: fixture.receiptsRoot,
      driveFileId: "drive-file-integrity",
      readBackText: "tampered",
      now: new Date("2026-08-01T12:00:00.000Z")
    }),
    /does not match/
  );
  const verified = await recordDriveIntegrity({
    receiptsRoot: fixture.receiptsRoot,
    driveFileId: "drive-file-integrity",
    readBackText: candidate.backupContent,
    now: new Date("2026-08-01T12:00:00.000Z")
  });
  assert.equal(verified.integrityStatus, "verified");
});

test("receipt audit reports corrupt, invalid, and duplicate receipts without deleting them", async () => {
  const fixture = await retentionFixture();
  await mkdir(fixture.receiptsRoot, { recursive: true });
  const valid = {
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    sourcePath: fixture.sessionPath,
    notePath: fixture.notePath,
    noteSha256: "a".repeat(64),
    driveFileId: "duplicate-drive-id",
    verifiedAt: "2026-07-31T12:00:00.000Z",
    search: {
      identity: "pi:session-1",
      client: "pi",
      sessionId: "session-1",
      title: "Valid receipt",
      excerpt: "Compressed facts only."
    }
  };
  await writeFile(path.join(fixture.receiptsRoot, "valid.json"), JSON.stringify(valid));
  await writeFile(
    path.join(fixture.receiptsRoot, "duplicate.json"),
    JSON.stringify({ ...valid, sourcePath: `${fixture.sessionPath}.other` })
  );
  await writeFile(path.join(fixture.receiptsRoot, "invalid.json"), JSON.stringify({
    representation: "compressed-summary-v1",
    driveFileId: "missing-fields"
  }));
  await writeFile(path.join(fixture.receiptsRoot, "corrupt.json"), "{bad json");

  const result = await auditRetentionReceipts(fixture.receiptsRoot);
  assert.equal(result.fileCount, 4);
  assert.equal(result.validCount, 2);
  assert.equal(result.corruptCount, 1);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.issueCount, 3);
  await access(path.join(fixture.receiptsRoot, "corrupt.json"));
});
