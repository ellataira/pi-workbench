import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { isRetentionEligible } from "./maintenance-policy.mjs";

async function filesUnder(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
    }
  }
  return output;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function frontmatterValue(text, key) {
  const match = String(text).match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].replace(/^["']|["']$/g, "");
  }
}

function plainText(text) {
  return String(text)
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/<!--.*?-->/g, "")
    .replace(/[*#`[\]()>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean).slice(0, 4)
    : [];
}

function compressedSearchMetadata(content) {
  const identity = String(frontmatterValue(content, "journal_id") || "");
  const [identityClient = "", identitySessionId = ""] = identity.split(":", 2);
  return {
    identity,
    client: String(frontmatterValue(content, "client") || identityClient),
    sessionId: String(
      frontmatterValue(content, "session_id") || identitySessionId
    ),
    repository: String(frontmatterValue(content, "repository") || ""),
    cwd: String(frontmatterValue(content, "cwd") || ""),
    title: String(content.match(/^#\s+(.+)$/m)?.[1] || "Archived session").slice(
      0,
      240
    ),
    updatedAt: String(
      frontmatterValue(content, "updated_at") ||
        frontmatterValue(content, "started_at") ||
        ""
    ),
    topics: stringList(frontmatterValue(content, "tags")),
    excerpt: plainText(content).slice(0, 1600)
  };
}

async function markdownFilesUnder(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(target);
    }
  }
  return output;
}

async function summaryIndex(root) {
  const summaries = new Map();
  for (const notePath of await markdownFilesUnder(root)) {
    const content = await readFile(notePath, "utf8");
    if (frontmatterValue(content, "representation") !== "compressed-summary-v1") continue;
    const sourcePath = frontmatterValue(content, "source_path");
    if (!path.isAbsolute(sourcePath)) continue;
    summaries.set(path.resolve(sourcePath), {
      notePath,
      content,
      noteSha256: sha256(content)
    });
  }
  return summaries;
}

function receiptPathFor(receiptsRoot, sessionPath) {
  return path.join(receiptsRoot, `${sha256(path.resolve(sessionPath))}.json`);
}

function uploadClaimPath(receiptsRoot, sessionPath) {
  return path.join(
    path.dirname(receiptsRoot),
    "retention-uploads",
    `${sha256(path.resolve(sessionPath))}.json`
  );
}

async function verifiedReceipt(receiptsRoot, sessionPath, noteSha256) {
  try {
    const receipt = JSON.parse(
      await readFile(receiptPathFor(receiptsRoot, sessionPath), "utf8")
    );
    return receipt.sourcePath === path.resolve(sessionPath) &&
      receipt.noteSha256 === noteSha256 &&
      receipt.driveFileId
      ? receipt
      : undefined;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function atomicJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, targetPath);
}

async function receiptEntries(receiptsRoot) {
  let entries;
  try {
    entries = await readdir(receiptsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const receiptPath = path.join(receiptsRoot, entry.name);
    try {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      receipts.push({ receiptPath, receipt });
    } catch {
      // Invalid receipts never authorize deletion or restoration.
    }
  }
  return receipts;
}

function validReceipt(receipt) {
  return (
    receipt?.schemaVersion === 1 &&
    receipt.representation === "compressed-summary-v1" &&
    path.isAbsolute(String(receipt.sourcePath ?? "")) &&
    path.isAbsolute(String(receipt.notePath ?? "")) &&
    /^[a-f0-9]{64}$/.test(String(receipt.noteSha256 ?? "")) &&
    Boolean(String(receipt.driveFileId ?? "")) &&
    Boolean(String(receipt.search?.identity ?? "")) &&
    Boolean(String(receipt.search?.client ?? "")) &&
    Boolean(String(receipt.search?.sessionId ?? "")) &&
    Boolean(String(receipt.search?.title ?? "")) &&
    typeof receipt.search?.excerpt === "string"
  );
}

export async function auditRetentionReceipts(receiptsRoot) {
  let entries;
  try {
    entries = await readdir(receiptsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        fileCount: 0,
        validCount: 0,
        corruptCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        issueCount: 0,
        issues: []
      };
    }
    throw error;
  }
  const issues = [];
  const valid = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const receiptPath = path.join(receiptsRoot, entry.name);
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch {
      issues.push({ receiptPath, kind: "corrupt-json" });
      continue;
    }
    if (!validReceipt(receipt)) {
      issues.push({ receiptPath, kind: "invalid-schema" });
      continue;
    }
    valid.push({ receiptPath, receipt });
  }
  const byDriveId = new Map();
  for (const item of valid) {
    const group = byDriveId.get(item.receipt.driveFileId) ?? [];
    group.push(item.receiptPath);
    byDriveId.set(item.receipt.driveFileId, group);
  }
  const duplicates = [...byDriveId.entries()].filter(([, paths]) => paths.length > 1);
  for (const [driveFileId, receiptPaths] of duplicates) {
    issues.push({ kind: "duplicate-drive-file", driveFileId, receiptPaths });
  }
  return {
    fileCount: entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json")
    ).length,
    validCount: valid.length,
    corruptCount: issues.filter((issue) => issue.kind === "corrupt-json").length,
    invalidCount: issues.filter((issue) => issue.kind === "invalid-schema").length,
    duplicateCount: duplicates.length,
    issueCount: issues.length,
    issues
  };
}

function isPathUnder(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function auditNativeSessions(
  sessionsRoot,
  now = new Date(),
  retentionDays = 30
) {
  const candidates = [];
  for (const filePath of await filesUnder(sessionsRoot)) {
    const info = await stat(filePath);
    if (!isRetentionEligible(info.mtime.toISOString(), now, retentionDays)) continue;
    candidates.push({
      path: filePath,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      retentionDays,
      backupState: "unverified",
      action: "keep"
    });
  }
  candidates.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
  return {
    scannedAt: now.toISOString(),
    retentionDays,
    candidateCount: candidates.length,
    deletionCount: 0,
    candidates
  };
}

export async function retentionCandidates({
  sessionsRoot,
  journalRoot,
  receiptsRoot,
  now = new Date(),
  retentionDays = 30,
  cursor,
  limit = 5
}) {
  const summaries = await summaryIndex(journalRoot);
  const candidates = [];
  for (const sessionPath of await filesUnder(sessionsRoot)) {
    const info = await stat(sessionPath);
    if (!isRetentionEligible(info.mtime.toISOString(), now, retentionDays)) continue;
    const resolvedSessionPath = path.resolve(sessionPath);
    const summary = summaries.get(resolvedSessionPath);
    if (!summary) {
      candidates.push({
        sessionPath: resolvedSessionPath,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        retentionDays,
        backupState: "compressed-summary-missing",
        action: "keep"
      });
      continue;
    }
    const receipt = await verifiedReceipt(
      receiptsRoot,
      resolvedSessionPath,
      summary.noteSha256
    );
    candidates.push({
      sessionPath: resolvedSessionPath,
      notePath: summary.notePath,
      noteSha256: summary.noteSha256,
      backupName: `agent-journal-${sha256(resolvedSessionPath).slice(0, 16)}.md`,
      backupContent: summary.content,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      retentionDays,
      backupState: receipt ? "drive-verified" : "needs-drive-backup",
      driveFileId: receipt?.driveFileId,
      action: receipt ? "delete-native-session" : "backup-and-verify"
    });
  }
  candidates.sort(
    (left, right) =>
      left.modifiedAt.localeCompare(right.modifiedAt) ||
      left.sessionPath.localeCompare(right.sessionPath)
  );
  let cursorKey;
  if (cursor) {
    try {
      cursorKey = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    } catch {
      throw new Error("invalid retention cursor");
    }
    if (
      typeof cursorKey?.modifiedAt !== "string" ||
      typeof cursorKey?.sessionPath !== "string"
    ) {
      throw new Error("invalid retention cursor");
    }
  }
  const remaining = cursorKey
    ? candidates.filter(
        (item) =>
          item.modifiedAt > cursorKey.modifiedAt ||
          (item.modifiedAt === cursorKey.modifiedAt &&
            item.sessionPath > cursorKey.sessionPath)
      )
    : candidates;
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 5));
  const batch = remaining.slice(0, boundedLimit);
  const hasMore = remaining.length > batch.length;
  const last = batch.at(-1);
  return {
    scannedAt: now.toISOString(),
    retentionDays,
    candidateCount: candidates.length,
    verifiedCount: candidates.filter((item) => item.backupState === "drive-verified")
      .length,
    returnedCount: batch.length,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              modifiedAt: last.modifiedAt,
              sessionPath: last.sessionPath
            })
          ).toString("base64url")
        : undefined,
    candidates: batch
  };
}

export async function claimDriveBackup({
  receiptsRoot,
  sessionPath,
  notePath,
  noteSha256,
  backupName,
  now = new Date(),
  claimTtlMinutes = 15
}) {
  const verified = await verifiedReceipt(receiptsRoot, sessionPath, noteSha256);
  if (verified) {
    return {
      status: "already-verified",
      driveFileId: verified.driveFileId
    };
  }
  const claimPath = uploadClaimPath(receiptsRoot, sessionPath);
  const lockPath = `${claimPath}.lock`;
  await mkdir(path.dirname(claimPath), { recursive: true });
  try {
    await writeFile(lockPath, `${process.pid}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      let lockInfo;
      try {
        lockInfo = await stat(lockPath);
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      if (
        lockInfo &&
        now.getTime() - lockInfo.mtimeMs >
          Number(claimTtlMinutes) * 60 * 1000
      ) {
        await rm(lockPath, { force: true });
        return claimDriveBackup({
          receiptsRoot,
          sessionPath,
          notePath,
          noteSha256,
          backupName,
          now,
          claimTtlMinutes
        });
      }
      return { status: "in-progress" };
    }
    throw error;
  }
  try {
    let existing;
    try {
      existing = JSON.parse(await readFile(claimPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (
      existing?.status === "claimed" &&
      Date.parse(existing.expiresAt) > now.getTime()
    ) {
      return {
        status: "in-progress",
        backupName: existing.backupName,
        expiresAt: existing.expiresAt
      };
    }
    const claimToken = randomUUID();
    const claim = {
      schemaVersion: 1,
      status: "claimed",
      claimToken,
      sourcePath: path.resolve(sessionPath),
      notePath: path.resolve(notePath),
      noteSha256: String(noteSha256),
      backupName: String(backupName),
      claimedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + Number(claimTtlMinutes) * 60 * 1000
      ).toISOString()
    };
    await atomicJson(claimPath, claim);
    return {
      status: "claimed",
      claimToken,
      backupName: claim.backupName,
      expiresAt: claim.expiresAt
    };
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function confirmDriveBackup({
  sessionsRoot,
  sessionPath,
  notePath,
  claimToken,
  driveFileId,
  driveFolderId,
  remoteContent,
  journalRoot,
  receiptsRoot,
  onVerified,
  now = new Date(),
  retentionDays = 30
}) {
  if (!String(driveFileId ?? "").trim()) {
    throw new Error("Drive file ID is required");
  }
  if (!String(driveFolderId ?? "").trim()) {
    throw new Error("Drive folder ID is required");
  }
  const resolvedSessionPath = path.resolve(sessionPath);
  let claim;
  try {
    claim = JSON.parse(
      await readFile(uploadClaimPath(receiptsRoot, resolvedSessionPath), "utf8")
    );
  } catch {
    throw new Error("active Drive upload claim was not found");
  }
  if (
    claim.status !== "claimed" ||
    claim.claimToken !== claimToken ||
    claim.sourcePath !== resolvedSessionPath ||
    claim.notePath !== path.resolve(notePath)
  ) {
    throw new Error("Drive upload claim is invalid");
  }
  const resolvedSessionsRoot = path.resolve(sessionsRoot);
  const relativeSessionPath = path.relative(resolvedSessionsRoot, resolvedSessionPath);
  if (
    !relativeSessionPath ||
    relativeSessionPath.startsWith("..") ||
    path.isAbsolute(relativeSessionPath) ||
    path.extname(resolvedSessionPath) !== ".jsonl"
  ) {
    throw new Error("native session is outside the configured native session root");
  }
  const info = await stat(resolvedSessionPath);
  if (!isRetentionEligible(info.mtime.toISOString(), now, retentionDays)) {
    throw new Error("native session is not retention eligible");
  }
  const summary = (await summaryIndex(journalRoot)).get(resolvedSessionPath);
  if (!summary || path.resolve(notePath) !== path.resolve(summary.notePath)) {
    throw new Error("matching compressed summary was not found");
  }
  if (
    claim.noteSha256 !== summary.noteSha256 ||
    claim.backupName !== `agent-journal-${sha256(resolvedSessionPath).slice(0, 16)}.md`
  ) {
    throw new Error("Drive upload claim does not match the compressed summary");
  }
  if (sha256(remoteContent) !== summary.noteSha256) {
    throw new Error("Drive content does not match the compressed summary");
  }

  const receiptPath = receiptPathFor(receiptsRoot, resolvedSessionPath);
  const receipt = {
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    sourcePath: resolvedSessionPath,
    notePath: summary.notePath,
    noteSha256: summary.noteSha256,
    driveFileId: String(driveFileId),
    driveFolderId: String(driveFolderId),
    driveFileName: claim.backupName,
    verifiedAt: now.toISOString(),
    search: compressedSearchMetadata(summary.content)
  };
  await atomicJson(receiptPath, receipt);
  if (onVerified) await onVerified(receipt);
  await rm(resolvedSessionPath);
  await atomicJson(uploadClaimPath(receiptsRoot, resolvedSessionPath), {
    ...claim,
    status: "completed",
    driveFileId: receipt.driveFileId,
    completedAt: now.toISOString()
  });
  return {
    deleted: true,
    deletedPath: resolvedSessionPath,
    receiptPath,
    driveFileId: receipt.driveFileId,
    noteSha256: receipt.noteSha256
  };
}

export async function evictDriveArchivedNotes({
  journalRoot,
  receiptsRoot,
  now = new Date(),
  localRetentionDays = 90
}) {
  const evicted = [];
  const kept = [];
  const cutoff = now.getTime() - Number(localRetentionDays) * 24 * 60 * 60 * 1000;
  for (const { receiptPath, receipt } of await receiptEntries(receiptsRoot)) {
    const notePath = path.resolve(String(receipt.notePath ?? ""));
    if (
      receipt.representation !== "compressed-summary-v1" ||
      !receipt.driveFileId ||
      !/^[a-f0-9]{64}$/.test(String(receipt.noteSha256 ?? "")) ||
      !isPathUnder(journalRoot, notePath)
    ) {
      kept.push({ notePath, reason: "invalid-receipt" });
      continue;
    }
    let info;
    let content;
    try {
      [info, content] = await Promise.all([stat(notePath), readFile(notePath, "utf8")]);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (info.mtimeMs > cutoff) {
      kept.push({ notePath, reason: "within-local-retention" });
      continue;
    }
    if (sha256(content) !== receipt.noteSha256) {
      kept.push({ notePath, reason: "local-content-changed" });
      continue;
    }
    await rm(notePath);
    const updated = { ...receipt, evictedAt: now.toISOString() };
    await atomicJson(receiptPath, updated);
    evicted.push({ notePath, driveFileId: receipt.driveFileId });
  }
  return {
    checkedAt: now.toISOString(),
    localRetentionDays,
    evictedCount: evicted.length,
    keptCount: kept.length,
    evicted,
    kept
  };
}

export async function retentionIntegritySample(receiptsRoot, limit = 5) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 5));
  const receipts = (await receiptEntries(receiptsRoot))
    .filter(
      ({ receipt }) =>
        receipt.driveFileId &&
        /^[a-f0-9]{64}$/.test(String(receipt.noteSha256 ?? ""))
    )
    .sort((left, right) =>
      String(left.receipt.lastIntegrityAt ?? "").localeCompare(
        String(right.receipt.lastIntegrityAt ?? "")
      )
    )
    .slice(0, boundedLimit)
    .map(({ receipt }) => ({
      driveFileId: receipt.driveFileId,
      expectedSha256: receipt.noteSha256,
      lastIntegrityAt: receipt.lastIntegrityAt,
      integrityStatus: receipt.integrityStatus
    }));
  const receiptAudit = await auditRetentionReceipts(receiptsRoot);
  return {
    limit: boundedLimit,
    items: receipts,
    receiptIssues: {
      corruptCount: receiptAudit.corruptCount,
      invalidCount: receiptAudit.invalidCount,
      duplicateCount: receiptAudit.duplicateCount,
      issueCount: receiptAudit.issueCount
    }
  };
}

export async function recordDriveIntegrity({
  receiptsRoot,
  driveFileId,
  readBackText,
  status = "verified",
  now = new Date()
}) {
  const match = (await receiptEntries(receiptsRoot)).find(
    ({ receipt }) => receipt.driveFileId === driveFileId
  );
  if (!match) throw new Error("Drive archive receipt was not found");
  const { receiptPath, receipt } = match;
  if (status === "verified" && sha256(readBackText) !== receipt.noteSha256) {
    await atomicJson(receiptPath, {
      ...receipt,
      lastIntegrityAt: now.toISOString(),
      integrityStatus: "mismatch"
    });
    throw new Error("Drive integrity content does not match the recorded SHA-256");
  }
  const integrityStatus = status === "verified" ? "verified" : "unavailable";
  const updated = {
    ...receipt,
    lastIntegrityAt: now.toISOString(),
    integrityStatus
  };
  await atomicJson(receiptPath, updated);
  return {
    driveFileId,
    checkedAt: updated.lastIntegrityAt,
    integrityStatus
  };
}
