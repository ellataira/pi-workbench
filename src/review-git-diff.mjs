import { createHash } from "node:crypto";
import path from "node:path";

export function resolveGitReviewCwd(sessionCwd, requestedCwd = "") {
  return path.resolve(sessionCwd, String(requestedCwd).trim() || ".");
}

export function buildGitDiffArgs(requested = "") {
  const mode = String(requested).trim();
  if (!mode || mode === "unstaged") {
    return ["diff", "--no-ext-diff", "--"];
  }
  if (mode === "staged") {
    return ["diff", "--cached", "--no-ext-diff", "--"];
  }
  if (
    mode.startsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@^~+-]*$/.test(mode)
  ) {
    throw new Error("Invalid diff base");
  }
  return [
    "diff",
    "--no-ext-diff",
    mode.includes("..") ? mode : `${mode}...HEAD`,
    "--"
  ];
}

export function gitDiffReviewFilename(cwd, gitArgs) {
  const identity = JSON.stringify({
    cwd: path.resolve(cwd),
    gitArgs: [...gitArgs]
  });
  return `${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.diff`;
}

export function recentTurnDiffFilename(sessionId, sequence) {
  const identity = JSON.stringify({
    sessionId: String(sessionId),
    sequence: Number(sequence)
  });
  return `${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.diff`;
}
