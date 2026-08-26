import path from "node:path";

const DEFAULT_LIMIT = 3;
export const REVIEW_SUGGESTIONS_ENTRY = "pi-review-suggestions-v1";
export const REVIEW_SHORTLIST_ENTRY = "pi-review-shortlist-v1";
const INTERNAL_REVIEW_SEGMENTS = new Set([
  ".agents",
  ".codex",
  ".git",
  ".next",
  ".pi",
  ".pi-subagents",
  "node_modules"
]);

const PLAN_DOCUMENT_SEGMENTS = new Set([
  "architecture",
  "design",
  "designs",
  "plans",
  "proposals",
  "rfcs",
  "specs"
]);
const PLAN_DOCUMENT_NAME = /(?:^|[-_.])(architecture|design|plan|planning|proposal|rfc(?:-?\d+)?|roadmap|spec)(?:[-_.]|$)/i;

export function isPlanReviewDocument(filePath, root) {
  if (typeof filePath !== "string" || typeof root !== "string") return false;
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const segments = relative.split(path.sep);
  if (segments.some((segment) => INTERNAL_REVIEW_SEGMENTS.has(segment))) return false;
  const extension = path.extname(absolute).toLowerCase();
  if (extension !== ".md" && extension !== ".markdown") return false;
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  return directories.some((segment) => PLAN_DOCUMENT_SEGMENTS.has(segment))
    || PLAN_DOCUMENT_NAME.test(path.basename(absolute, extension));
}

const REVIEW_SHORTLIST_REASONS = new Set([
  "primary-change",
  "task-plan",
  "user-pinned",
  "agent-selected"
]);
const REVIEW_SHORTLIST_SOURCES = new Set(["automatic", "agent", "user"]);
const LOW_SIGNAL_REVIEW_SEGMENTS = new Set([
  "artifacts",
  "build",
  "dist",
  "fixtures",
  "generated",
  "snapshots",
  "testdata",
  "vendor"
]);
const LOW_SIGNAL_REVIEW_FILES = /^(?:package-lock\.json|pnpm-lock\.yaml|uv\.lock|yarn\.lock|go\.sum)$/i;

function localReviewPath(filePath, cwd, allowedRoot) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(path.resolve(allowedRoot), absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return "";
  if (relative.split(path.sep).some((segment) => INTERNAL_REVIEW_SEGMENTS.has(segment))) return "";
  return absolute;
}

export function updateReviewShortlist(
  previous,
  additions,
  cwd,
  { allowedRoot = cwd, limit = 8, now = new Date().toISOString() } = {}
) {
  const normalized = [];
  for (const item of [...(additions ?? []), ...(previous ?? [])]) {
    const filePath = localReviewPath(item?.filePath, cwd, allowedRoot);
    if (!filePath || normalized.some((candidate) => candidate.filePath === filePath)) continue;
    const reason = REVIEW_SHORTLIST_REASONS.has(item?.reason) ? item.reason : "agent-selected";
    const source = REVIEW_SHORTLIST_SOURCES.has(item?.source) ? item.source : "agent";
    normalized.push({
      filePath,
      reason,
      source,
      addedAt: Number.isFinite(Date.parse(item?.addedAt)) ? new Date(item.addedAt).toISOString() : now
    });
    if (normalized.length >= Math.max(1, limit)) break;
  }
  return normalized;
}

export function restoreReviewShortlist(entries, cwd, options = {}) {
  const entry = [...(entries ?? [])].reverse().find(
    (candidate) => candidate?.type === "custom" && candidate.customType === REVIEW_SHORTLIST_ENTRY
  );
  return updateReviewShortlist([], entry?.data?.items, entry?.data?.cwd ?? cwd, {
    allowedRoot: options.allowedRoot ?? cwd,
    limit: options.limit ?? 8
  });
}

export function automaticReviewShortlistCandidates(filePaths, cwd, { limit = 3 } = {}) {
  return uniqueAbsolutePaths(filePaths, cwd)
    .map((filePath, index) => {
      const relative = path.relative(path.resolve(cwd), filePath);
      const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
      if (!relative || relative.startsWith(`..${path.sep}`)) return null;
      if (segments.some((segment) => INTERNAL_REVIEW_SEGMENTS.has(segment))) return null;
      if (segments.some((segment) => LOW_SIGNAL_REVIEW_SEGMENTS.has(segment))) return null;
      if (LOW_SIGNAL_REVIEW_FILES.test(path.basename(filePath))) return null;
      const testLike = /(?:^|[-_.])(test|tests|spec)(?:[-_.]|$)/i.test(path.basename(filePath));
      const planLike = isPlanReviewDocument(filePath, cwd);
      return { filePath, index, score: planLike ? 60 : testLike ? 20 : 40 };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, limit))
    .map((candidate) => candidate.filePath);
}

function uniqueAbsolutePaths(filePaths, cwd) {
  if (!Array.isArray(filePaths) || !cwd) return [];
  const root = path.resolve(cwd);
  const seen = new Set();
  const unique = [];
  for (const candidate of filePaths) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const absolute = path.resolve(root, candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    unique.push(absolute);
  }
  return unique;
}

function displayReviewPath(absolute, cwd) {
  const root = path.resolve(cwd);
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    ? relative
    : absolute;
}

function quoteReviewPath(filePath) {
  if (!/[\s'"]/.test(filePath)) return filePath;
  if (!filePath.includes('"')) return `"${filePath}"`;
  if (!filePath.includes("'")) return `'${filePath}'`;
  return JSON.stringify(filePath);
}

export function parseReviewPathArgument(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function buildReviewChooserChoices({
  changedFilePaths,
  cwd,
  hasRecentDiff
}) {
  const files = uniqueAbsolutePaths(changedFilePaths, cwd);
  const displayed = files.map((filePath) => displayReviewPath(filePath, cwd));
  const preview = displayed.slice(0, 3).join(", ");
  const remainder = displayed.length > 3 ? ` +${displayed.length - 3}` : "";
  const choices = [];
  if (hasRecentDiff) {
    choices.push({
      kind: "recent",
      label: `Changes from last Pi turn · ${displayed.length} file${displayed.length === 1 ? "" : "s"}${preview ? `: ${preview}${remainder}` : ""}`
    });
  }
  choices.push({
    kind: "file",
    label: displayed.length
      ? `Open a complete file · Suggested: ${displayed[0]}`
      : "Open a complete file"
  });
  choices.push(
    { kind: "git", value: "", label: "Git diff · Unstaged changes" },
    { kind: "git", value: "staged", label: "Git diff · Staged changes" },
    { kind: "git-base", label: "Git diff · Compare with a base…" }
  );
  return choices;
}

export function buildReviewDisplayMetadata({
  kind,
  cwd,
  filePaths = [],
  sourcePath,
  gitRequest = ""
}) {
  const relativeFiles = [...new Set(filePaths)]
    .map((filePath) => displayReviewPath(path.resolve(cwd, filePath), cwd));
  if (kind === "recent") {
    const preview = relativeFiles.slice(0, 3).join(", ");
    const extra = relativeFiles.length > 3 ? ` +${relativeFiles.length - 3}` : "";
    return {
      title: "Changes from last Pi turn",
      scope: `${relativeFiles.length} ${relativeFiles.length === 1 ? "file" : "files"}${preview ? ` · ${preview}${extra}` : ""}`,
      sourcePath
    };
  }
  if (kind === "git") {
    const labels = {
      staged: "Staged changes",
      "": "Unstaged changes"
    };
    return {
      title: `Git diff · ${labels[gitRequest] ?? `Compared with ${gitRequest}`}`,
      scope: cwd,
      sourcePath
    };
  }
  return {
    title: path.basename(sourcePath),
    scope: sourcePath,
    sourcePath
  };
}

export function buildFileReviewChoices(filePaths, cwd, { limit = 5 } = {}) {
  const files = uniqueAbsolutePaths(filePaths, cwd).slice(0, limit);
  const choices = files.map((filePath, index) => ({
    label: `${index === 0 ? "Suggested" : "Recently changed"} · ${displayReviewPath(filePath, cwd)}`,
    value: filePath
  }));
  choices.push({
    label: files.length ? "Enter another file path…" : "Enter a file path…",
    value: undefined
  });
  return choices;
}

export function mergeReviewFileCandidates(
  recentFilePaths,
  gitFilePaths,
  cwd,
  { limit = 20 } = {}
) {
  const recent = uniqueAbsolutePaths(recentFilePaths, cwd).slice(0, limit);
  if (recent.length) return recent;
  const fallback = uniqueAbsolutePaths(gitFilePaths, cwd).filter((filePath) => {
    const relative = path.relative(path.resolve(cwd), filePath);
    return !relative
      .split(path.sep)
      .some((segment) => INTERNAL_REVIEW_SEGMENTS.has(segment));
  });
  return fallback.slice(0, limit);
}

export function mergeSessionReviewFiles(
  previousFilePaths,
  changedFilePaths,
  cwd,
  { limit = 100, allowedRoot = cwd } = {}
) {
  const root = path.resolve(cwd);
  const allowed = path.resolve(allowedRoot);
  return uniqueAbsolutePaths(
    [...(changedFilePaths ?? []), ...(previousFilePaths ?? [])],
    root
  ).filter((filePath) => {
    const relative = path.relative(allowed, filePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      return false;
    }
    const segments = relative.split(path.sep);
    if (segments.some((segment) => INTERNAL_REVIEW_SEGMENTS.has(segment))) {
      return false;
    }
    return !(segments[0] === ".agents" && segments[1] === "runtime");
  }).slice(0, Math.max(1, limit));
}

function sessionDisplayPath(filePath, cwd, home) {
  const relative = path.relative(path.resolve(cwd), filePath);
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
    return relative;
  }
  const homeRelative = path.relative(path.resolve(home), filePath);
  if (homeRelative && homeRelative !== ".." && !homeRelative.startsWith(`..${path.sep}`)) {
    return `~/${homeRelative}`;
  }
  return filePath;
}

const SESSION_REVIEW_MODES = {
  recent: {
    label: "Last Pi turn",
    title: "Last Pi turn",
    scope: "Exact changes from the immediately preceding Pi turn"
  },
  staged: {
    label: "Staged",
    title: "Staged changes",
    scope: "Git index compared with HEAD"
  },
  commit: {
    label: "Latest commit",
    title: "Latest commit",
    scope: "HEAD^..HEAD"
  },
  branch: {
    label: "Branch vs main",
    title: "Branch vs main",
    scope: "origin/main...HEAD"
  }
};

export function buildSessionReviewTargets({
  cwd,
  home,
  filePaths = [],
  recentFilePaths = [],
  relevantFilePaths = [],
  recentEditsLimit = 8,
  modes = []
}) {
  const targets = [];
  for (const mode of modes) {
    const definition = SESSION_REVIEW_MODES[mode?.key];
    if (!definition || typeof mode?.filePath !== "string" || !mode.filePath) continue;
    targets.push({
      filePath: mode.filePath,
      group: "Review modes",
      label: `${mode.label ?? definition.label}${
        mode.unavailable ? " · unavailable" : mode.empty ? " · no changes" : ""
      }`,
      display: {
        title: mode.title ?? definition.title,
        scope: mode.scope ?? definition.scope
      }
    });
  }
  const relevant = uniqueAbsolutePaths(relevantFilePaths, cwd);
  const relevantSet = new Set(relevant);
  relevant.forEach((filePath, index) => {
    const displayPath = sessionDisplayPath(filePath, cwd, home);
    targets.push({
      filePath,
      group: `Relevant files · ${relevant.length}`,
      label: `R${String(index + 1).padStart(2, "0")} · ${path.basename(filePath)} — ${displayPath}`,
      display: {
        title: path.basename(filePath),
        scope: `Saved for review · ${displayPath}`
      }
    });
  });
  const files = uniqueAbsolutePaths(filePaths, cwd)
    .filter((filePath) => !relevantSet.has(filePath));
  const recentSet = new Set(uniqueAbsolutePaths(recentFilePaths, cwd));
  const visibleCount = Math.min(files.length, Math.max(1, recentEditsLimit));
  const olderCount = files.length - visibleCount;
  files.forEach((filePath, index) => {
    const displayPath = sessionDisplayPath(filePath, cwd, home);
    const rank = String(index + 1).padStart(2, "0");
    const isRecentEdit = index < visibleCount;
    targets.push({
      filePath,
      group: isRecentEdit
        ? "Recent edits · newest first"
        : `Older this session · ${olderCount} ${olderCount === 1 ? "file" : "files"}`,
      label: `${rank} · ${path.basename(filePath)} — ${displayPath}`,
      display: {
        title: path.basename(filePath),
        scope: recentSet.has(filePath)
          ? `Edited last Pi turn · ${displayPath}`
          : isRecentEdit
            ? `Edited earlier this session · ${displayPath}`
            : `Older session edit · ${displayPath}`
      }
    });
  });
  return targets;
}

export function sortSessionReviewFiles(records) {
  return (Array.isArray(records) ? records : [])
    .map((record, index) => ({
      filePath: record?.filePath,
      mtimeMs: Number(record?.mtimeMs),
      index
    }))
    .filter((record) => typeof record.filePath === "string" && Number.isFinite(record.mtimeMs))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.index - right.index)
    .map((record) => record.filePath);
}

export function filterReviewableSessionFileRecords(
  records,
  { maxBytes = 5 * 1024 * 1024 } = {}
) {
  return (Array.isArray(records) ? records : []).filter((record) =>
    record?.isFile === true &&
    typeof record.filePath === "string" &&
    Boolean(record.kind) &&
    Number.isFinite(record.size) &&
    record.size >= 0 &&
    record.size <= maxBytes
  );
}

export function restoreReviewFileCandidates(entries, cwd, {
  limit = 20,
  allowedRoot = cwd
} = {}) {
  const root = path.resolve(cwd);
  const allowed = path.resolve(allowedRoot);
  const entry = [...(entries ?? [])].reverse().find(
    (candidate) =>
      candidate?.type === "custom" &&
      candidate.customType === REVIEW_SUGGESTIONS_ENTRY
  );
  return uniqueAbsolutePaths(entry?.data?.files, entry?.data?.cwd ?? root)
    .filter((filePath) => {
      const relative = path.relative(allowed, filePath);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    })
    .slice(0, limit);
}

export function restoreRecentReviewFileCandidates(entries, cwd, options = {}) {
  const root = path.resolve(cwd);
  const allowed = path.resolve(options.allowedRoot ?? cwd);
  const limit = options.limit ?? 20;
  const entry = [...(entries ?? [])].reverse().find(
    (candidate) =>
      candidate?.type === "custom" &&
      candidate.customType === REVIEW_SUGGESTIONS_ENTRY &&
      Array.isArray(candidate?.data?.recentFiles)
  );
  return uniqueAbsolutePaths(entry?.data?.recentFiles, entry?.data?.cwd ?? root)
    .filter((filePath) => {
      const relative = path.relative(allowed, filePath);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    })
    .slice(0, limit);
}

export function reviewToolFilePaths(toolName, args = {}) {
  if (!["edit", "write", "apply_patch"].includes(toolName)) return [];
  const paths = [];
  const direct = typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : "";
  if (direct.trim()) paths.push(direct);
  if (toolName === "apply_patch" && typeof args.patch === "string") {
    for (const match of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      paths.push(match[1]);
    }
  }
  return [...new Set(paths)];
}

export function restoreRecentToolFileCandidates(entries, cwd, {
  limit = 100,
  allowedRoot = cwd
} = {}) {
  const branch = Array.isArray(entries) ? entries : [];
  let filePaths = [];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry?.message?.role === "user") {
      if (filePaths.length) break;
      continue;
    }
    if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
    const entryPaths = [];
    for (const item of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (item?.type !== "toolCall") continue;
      entryPaths.push(...reviewToolFilePaths(item.name, item.arguments));
    }
    filePaths = [...entryPaths, ...filePaths];
  }
  return mergeSessionReviewFiles([], filePaths, cwd, { limit, allowedRoot });
}

export function buildReviewSuggestions(filePaths, cwd, {
  limit = DEFAULT_LIMIT
} = {}) {
  if (!cwd || limit <= 0) return [];
  return uniqueAbsolutePaths(filePaths, cwd).slice(0, limit).map((absolute) => {
    const displayPath = displayReviewPath(absolute, cwd);
    return `/review ${quoteReviewPath(displayPath)}`;
  });
}
