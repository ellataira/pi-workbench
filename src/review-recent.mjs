import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100;

function isInternalReviewPath(relative) {
  const segments = path.normalize(relative).split(path.sep);
  return (
    segments[0] === ".git" ||
    segments[0] === ".next" ||
    segments[0] === ".pi-subagents" ||
    segments.includes("node_modules") ||
    (segments[0] === ".agents" && segments[1] === "runtime") ||
    (segments[0] === ".claude" && segments[1] === "worktrees")
  );
}

function limits(options = {}) {
  return {
    maxFileBytes: Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
    maxTotalBytes: Math.max(1, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES),
    maxDiffBytes: Math.max(1, options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES),
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  };
}

async function git(cwd, args, options = {}) {
  return execFileAsync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_DIFF_BYTES,
    timeout: options.timeout ?? 15_000
  });
}

function listedPaths(output) {
  return String(output ?? "")
    .split("\0")
    .filter(Boolean)
    .filter((entry) => {
      if (path.isAbsolute(entry)) return false;
      const normalized = path.normalize(entry);
      return (
        normalized !== ".." &&
        !normalized.startsWith(`..${path.sep}`) &&
        !isInternalReviewPath(normalized)
      );
    });
}

function relativePath(root, absolute) {
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

async function readBoundedFile(filePath, state) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { record: null };
    throw error;
  }
  if (!metadata.isFile()) return { skipped: true };
  if (
    metadata.size > state.options.maxFileBytes ||
    state.bytes + metadata.size > state.options.maxTotalBytes
  ) {
    return { skipped: true };
  }
  const content = await readFile(filePath);
  state.bytes += content.byteLength;
  return { record: { content } };
}

async function readGitFile(baseline, relative, state) {
  const object = `${baseline.gitRef}:${relative}`;
  try {
    const sizeResult = await git(baseline.root, ["cat-file", "-s", object]);
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    if (
      !Number.isFinite(size) ||
      size > state.options.maxFileBytes ||
      state.bytes + size > state.options.maxTotalBytes
    ) {
      return { skipped: true };
    }
    const contentResult = await git(
      baseline.root,
      ["cat-file", "blob", object],
      {
        encoding: null,
        maxBuffer: state.options.maxFileBytes + 1
      }
    );
    const content = Buffer.from(contentResult.stdout);
    state.bytes += content.byteLength;
    return { record: { content } };
  } catch (error) {
    if (error?.code === 128 || error?.code === 1) return { record: null };
    const stderr = String(error?.stderr ?? "");
    if (/does not exist|not a valid object name|path .* exists on disk/i.test(stderr)) {
      return { record: null };
    }
    throw error;
  }
}

async function snapshotPaths(baseline, relativePaths, target, state) {
  for (const relative of relativePaths.slice(0, baseline.options.maxFiles)) {
    const result = await readBoundedFile(path.join(baseline.root, relative), state);
    if (result.skipped) baseline.skipped.add(relative);
    else target.set(relative, result.record);
  }
  for (const relative of relativePaths.slice(baseline.options.maxFiles)) {
    baseline.skipped.add(relative);
  }
}

export async function beginRecentTurn(cwd, options = {}) {
  const requestedRoot = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
  const baseline = {
    root: requestedRoot,
    gitRef: null,
    trackedBefore: new Map(),
    untrackedBefore: new Map(),
    directBefore: new Map(),
    skipped: new Set(),
    options: limits(options)
  };

  try {
    const rootResult = await git(requestedRoot, ["rev-parse", "--show-toplevel"]);
    baseline.root = await realpath(rootResult.stdout.trim());
    const headResult = await git(baseline.root, ["rev-parse", "HEAD"]);
    baseline.gitRef = headResult.stdout.trim();
    const [trackedResult, untrackedResult] = await Promise.all([
      git(
        baseline.root,
        ["diff", "--name-only", "-z", baseline.gitRef, "--"],
        { maxBuffer: baseline.options.maxDiffBytes }
      ),
      git(
        baseline.root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { maxBuffer: baseline.options.maxDiffBytes }
      )
    ]);
    const state = { bytes: 0, options: baseline.options };
    await snapshotPaths(
      baseline,
      listedPaths(trackedResult.stdout),
      baseline.trackedBefore,
      state
    );
    await snapshotPaths(
      baseline,
      listedPaths(untrackedResult.stdout),
      baseline.untrackedBefore,
      state
    );
  } catch {
    baseline.gitRef = null;
    baseline.root = requestedRoot;
  }
  return baseline;
}

export async function captureRecentPath(baseline, filePath) {
  const requested = path.resolve(filePath);
  const absolute = await realpath(requested).catch(async () => {
    const parent = await realpath(path.dirname(requested)).catch(
      () => path.dirname(requested)
    );
    return path.join(parent, path.basename(requested));
  });
  const relative = relativePath(baseline.root, absolute);
  if (
    !relative ||
    isInternalReviewPath(relative) ||
    baseline.directBefore.has(relative)
  ) return false;

  const state = {
    bytes: [...baseline.directBefore.values()].reduce(
      (total, record) => total + (record?.content?.byteLength ?? 0),
      0
    ),
    options: baseline.options
  };
  const result = await readBoundedFile(absolute, state);
  if (result.skipped) {
    baseline.skipped.add(relative);
    return false;
  }
  baseline.directBefore.set(relative, result.record);
  return true;
}

async function currentGitCandidates(baseline) {
  const candidates = new Set([
    ...baseline.trackedBefore.keys(),
    ...baseline.untrackedBefore.keys(),
    ...baseline.directBefore.keys()
  ]);
  const [tracked, untracked] = await Promise.all([
    git(
      baseline.root,
      ["diff", "--name-only", "-z", baseline.gitRef, "--"],
      { maxBuffer: baseline.options.maxDiffBytes }
    ),
    git(
      baseline.root,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { maxBuffer: baseline.options.maxDiffBytes }
    )
  ]);
  for (const relative of listedPaths(tracked.stdout)) candidates.add(relative);
  for (const relative of listedPaths(untracked.stdout)) candidates.add(relative);
  return candidates;
}

async function beforeRecord(baseline, relative, state) {
  if (baseline.trackedBefore.has(relative)) {
    return { record: baseline.trackedBefore.get(relative) };
  }
  if (baseline.untrackedBefore.has(relative)) {
    return { record: baseline.untrackedBefore.get(relative) };
  }
  if (baseline.gitRef) {
    const fromGit = await readGitFile(baseline, relative, state);
    if (fromGit.record || fromGit.skipped) return fromGit;
  }
  if (baseline.directBefore.has(relative)) {
    return { record: baseline.directBefore.get(relative) };
  }
  return { record: null };
}

function sameRecord(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.compare(left.content, right.content) === 0;
}

async function writeRecord(root, relative, record) {
  if (!record) return;
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, record.content, { mode: 0o600 });
}

function normalizeDiffPaths(diff) {
  return String(diff)
    .split("\n")
    .map((line) => {
      if (!/^(?:diff --git |--- |\+\+\+ |Binary files )/.test(line)) {
        return line;
      }
      return line
        .replace(/\ba\/(?:before|after)\//g, "a/")
        .replace(/\bb\/(?:before|after)\//g, "b/");
    })
    .join("\n");
}

async function createUnifiedDiff(records, maxDiffBytes) {
  if (!records.length) return "";
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-review-turn-"));
  const beforeRoot = path.join(temporary, "before");
  const afterRoot = path.join(temporary, "after");
  try {
    await Promise.all([
      mkdir(beforeRoot, { recursive: true, mode: 0o700 }),
      mkdir(afterRoot, { recursive: true, mode: 0o700 })
    ]);
    for (const entry of records) {
      await writeRecord(beforeRoot, entry.relative, entry.before);
      await writeRecord(afterRoot, entry.relative, entry.after);
    }
    try {
      const result = await git(
        temporary,
        ["diff", "--no-index", "--no-ext-diff", "--", "before", "after"],
        { maxBuffer: maxDiffBytes }
      );
      return normalizeDiffPaths(result.stdout);
    } catch (error) {
      if (error?.code === 1) return normalizeDiffPaths(error.stdout);
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function finishRecentTurn(baseline) {
  const candidates = baseline.gitRef
    ? await currentGitCandidates(baseline)
    : new Set(baseline.directBefore.keys());
  const ordered = [...candidates].sort().slice(0, baseline.options.maxFiles);
  for (const relative of [...candidates].sort().slice(baseline.options.maxFiles)) {
    baseline.skipped.add(relative);
  }

  const beforeState = { bytes: 0, options: baseline.options };
  const afterState = { bytes: 0, options: baseline.options };
  const records = [];
  for (const relative of ordered) {
    const before = await beforeRecord(baseline, relative, beforeState);
    const after = await readBoundedFile(
      path.join(baseline.root, relative),
      afterState
    );
    if (before.skipped || after.skipped) {
      baseline.skipped.add(relative);
      continue;
    }
    if (sameRecord(before.record, after.record)) continue;
    records.push({
      relative,
      before: before.record,
      after: after.record
    });
  }

  return {
    diff: await createUnifiedDiff(records, baseline.options.maxDiffBytes),
    changedPaths: records.map((entry) => entry.relative),
    skippedPaths: [...baseline.skipped].sort()
  };
}
