import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  beginRecentTurn,
  captureRecentPath,
  finishRecentTurn
} from "../src/review-recent.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-recent-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "review@example.com"]);
  await git(root, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "tracked.md"), "committed\n", "utf8");
  await git(root, ["add", "tracked.md"]);
  await git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]);
  return root;
}

test("recent review compares the exact dirty worktree before and after one turn", async () => {
  const root = await createRepository();
  try {
    await writeFile(path.join(root, "tracked.md"), "before turn\n", "utf8");
    const baseline = await beginRecentTurn(root);

    await writeFile(
      path.join(root, "tracked.md"),
      "after turn\na/before/literal stays content\n",
      "utf8"
    );
    const result = await finishRecentTurn(baseline);

    assert.deepEqual(result.changedPaths, ["tracked.md"]);
    assert.match(result.diff, /--- a\/tracked\.md/);
    assert.match(result.diff, /\+after turn/);
    assert.match(result.diff, /\+a\/before\/literal stays content/);
    assert.match(result.diff, /-before turn/);
    assert.doesNotMatch(result.diff, /-committed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent review includes shell and subagent-shaped new, deleted, and untracked changes", async () => {
  const root = await createRepository();
  try {
    await writeFile(path.join(root, "notes.md"), "old untracked\n", "utf8");
    const baseline = await beginRecentTurn(root);

    await writeFile(path.join(root, "notes.md"), "new untracked\n", "utf8");
    await writeFile(path.join(root, "created.md"), "created this turn\n", "utf8");
    await rm(path.join(root, "tracked.md"));
    const result = await finishRecentTurn(baseline);

    assert.deepEqual(result.changedPaths, ["created.md", "notes.md", "tracked.md"]);
    assert.match(result.diff, /\+created this turn/);
    assert.match(result.diff, /-old untracked/);
    assert.match(result.diff, /\+new untracked/);
    assert.match(result.diff, /-committed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a no-change turn clears recent review content", async () => {
  const root = await createRepository();
  try {
    const baseline = await beginRecentTurn(root);
    assert.deepEqual(await finishRecentTurn(baseline), {
      diff: "",
      changedPaths: [],
      skippedPaths: []
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Git fallback compares directly captured files without scanning a directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-recent-plain-"));
  try {
    const target = path.join(root, "doc.md");
    await writeFile(target, "before\n", "utf8");
    const baseline = await beginRecentTurn(root);
    await captureRecentPath(baseline, target);

    await writeFile(target, "after\n", "utf8");
    const result = await finishRecentTurn(baseline);

    assert.deepEqual(result.changedPaths, ["doc.md"]);
    assert.match(result.diff, /-before/);
    assert.match(result.diff, /\+after/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent review remains bounded when a changed file is too large", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-recent-bounded-"));
  try {
    const target = path.join(root, "large.md");
    await writeFile(target, "before\n", "utf8");
    const baseline = await beginRecentTurn(root, { maxFileBytes: 16 });
    await captureRecentPath(baseline, target);

    await writeFile(target, "x".repeat(32), "utf8");
    const result = await finishRecentTurn(baseline);

    assert.equal(result.diff, "");
    assert.deepEqual(result.changedPaths, []);
    assert.deepEqual(result.skippedPaths, ["large.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent review ignores internal subagent artifacts before applying limits", async () => {
  const root = await createRepository();
  try {
    const artifactRoot = path.join(root, ".pi-subagents", "artifacts");
    await mkdir(artifactRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        writeFile(path.join(artifactRoot, `${index}.json`), "internal\n", "utf8")
      )
    );
    const baseline = await beginRecentTurn(root, { maxFiles: 10 });
    await writeFile(path.join(root, "tracked.md"), "review this\n", "utf8");
    const result = await finishRecentTurn(baseline);

    assert.deepEqual(result.changedPaths, ["tracked.md"]);
    assert.deepEqual(result.skippedPaths, []);
    assert.match(result.diff, /\+review this/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
