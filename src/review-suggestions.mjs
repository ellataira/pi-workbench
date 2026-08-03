import path from "node:path";

const DEFAULT_LIMIT = 3;
export const REVIEW_SUGGESTIONS_ENTRY = "pi-review-suggestions-v1";
const INTERNAL_REVIEW_SEGMENTS = new Set([
  ".agents",
  ".codex",
  ".git",
  ".next",
  ".pi",
  "node_modules"
]);

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

export function restoreReviewFileCandidates(entries, cwd, { limit = 20 } = {}) {
  const root = path.resolve(cwd);
  const entry = [...(entries ?? [])].reverse().find(
    (candidate) =>
      candidate?.type === "custom" &&
      candidate.customType === REVIEW_SUGGESTIONS_ENTRY &&
      path.resolve(candidate.data?.cwd ?? "") === root
  );
  return uniqueAbsolutePaths(entry?.data?.files, root)
    .filter((filePath) => {
      const relative = path.relative(root, filePath);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    })
    .slice(0, limit);
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
