import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendReviewDraft,
  classifyReviewFile,
  createDiffComment,
  createReviewServer,
  decorateAnnotationHtml,
  formatDiffCommentBatchDraft,
  formatAnnotationBatchDraft,
  formatMultiFileAnnotationBatchDraft,
  formatReviewDraft,
  insertMarkdownAnnotation,
  positionAnchoredOverlay,
  parseMarkdownAnnotations,
  renderMarkdownForReview,
  reviewDiskUpdateAction,
  resolveMarkdownSelection,
  scrollDeltaToPreserveAnchor,
  selectReviewSession,
  updateDiffCommentCollection,
  updateMarkdownAnnotation
} from "../src/review-surface.mjs";
import {
  readReviewSessions,
  removeReviewSession,
  writeReviewSession
} from "../src/review-session-registry.mjs";
import {
  buildGitDiffArgs,
  gitDiffReviewFilename,
  recentTurnDiffFilename,
  resolveGitReviewCwd
} from "../src/review-git-diff.mjs";
import {
  buildFileReviewChoices,
  buildReviewChooserChoices,
  buildReviewDisplayMetadata,
  buildSessionReviewTargets,
  buildReviewSuggestions,
  filterReviewableSessionFileRecords,
  mergeSessionReviewFiles,
  mergeReviewFileCandidates,
  parseReviewPathArgument,
  restoreRecentReviewFileCandidates,
  restoreRecentToolFileCandidates,
  reviewToolFilePaths,
  restoreReviewFileCandidates,
  sortSessionReviewFiles,
  automaticReviewShortlistCandidates,
  restoreReviewShortlist,
  updateReviewShortlist,
  REVIEW_SHORTLIST_ENTRY,
  REVIEW_SUGGESTIONS_ENTRY
} from "../src/review-suggestions.mjs";

test("session review excludes unsupported, oversized, missing, and non-file targets before opening", () => {
  assert.deepEqual(
    filterReviewableSessionFileRecords([
      { filePath: "/repo/docs/plan.md", mtimeMs: 40, size: 100, kind: "markdown", isFile: true },
      { filePath: "/repo/src/main.go", mtimeMs: 30, size: 200, kind: "text", isFile: true },
      { filePath: "/repo/archive.zip", mtimeMs: 20, size: 300, kind: null, isFile: true },
      { filePath: "/repo/huge.md", mtimeMs: 10, size: 6 * 1024 * 1024, kind: "markdown", isFile: true },
      { filePath: "/repo/directory", mtimeMs: 5, size: 0, kind: "text", isFile: false }
    ]),
    [
      { filePath: "/repo/docs/plan.md", mtimeMs: 40, size: 100, kind: "markdown", isFile: true },
      { filePath: "/repo/src/main.go", mtimeMs: 30, size: 200, kind: "text", isFile: true }
    ]
  );
});

test("review chooser names the last-turn files and recommends the newest file", () => {
  assert.deepEqual(
    buildReviewChooserChoices({
      changedFilePaths: [
        "/repo/src/a.ts",
        "/repo/docs/plan with spaces.md",
        "/repo/tests/a.test.ts",
        "/repo/README.md"
      ],
      cwd: "/repo",
      hasRecentDiff: true
    }),
    [
      {
        kind: "recent",
        label:
          "Changes from last Pi turn · 4 files: src/a.ts, docs/plan with spaces.md, tests/a.test.ts +1"
      },
      {
        kind: "file",
        label: "Open a complete file · Suggested: src/a.ts"
      },
      { kind: "git", value: "", label: "Git diff · Unstaged changes" },
      { kind: "git", value: "staged", label: "Git diff · Staged changes" },
      { kind: "git-base", label: "Git diff · Compare with a base…" }
    ]
  );
});

test("review metadata describes the conceptual scope instead of a generated temp file", () => {
  assert.deepEqual(
    buildReviewDisplayMetadata({
      kind: "recent",
      cwd: "/repo",
      filePaths: ["/repo/src/a.ts", "/repo/docs/plan.md"],
      sourcePath: "/tmp/pi-review/recent-turn.diff"
    }),
    {
      title: "Changes from last Pi turn",
      scope: "2 files · src/a.ts, docs/plan.md",
      sourcePath: "/tmp/pi-review/recent-turn.diff"
    }
  );
  assert.deepEqual(
    buildReviewDisplayMetadata({
      kind: "git",
      cwd: "/repo",
      gitRequest: "staged",
      sourcePath: "/tmp/pi-review/staged.diff"
    }),
    {
      title: "Git diff · Staged changes",
      scope: "/repo",
      sourcePath: "/tmp/pi-review/staged.diff"
    }
  );
});

test("review exposes one command surface and removes legacy aliases", async () => {
  const source = await readFile(
    new URL("../extensions/pi-review-surface.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /registerCommand\("review"/);
  assert.match(source, /registerTool\(\{[\s\S]*name: "review_open"/);
  assert.doesNotMatch(source, /registerCommand\("review-(?:recent|last|diff)"/);
});

test("exact commit ranges remain exact instead of becoming base comparisons", () => {
  const range = `${"1".repeat(40)}^..${"1".repeat(40)}`;
  assert.deepEqual(buildGitDiffArgs(range), [
    "diff",
    "--no-ext-diff",
    range,
    "--"
  ]);
  assert.deepEqual(buildGitDiffArgs("HEAD^..HEAD"), [
    "diff",
    "--no-ext-diff",
    "HEAD^..HEAD",
    "--"
  ]);
  assert.deepEqual(buildGitDiffArgs("origin/main"), [
    "diff",
    "--no-ext-diff",
    "origin/main...HEAD",
    "--"
  ]);
});

test("programmatic Git review can target a repository outside the session cwd", () => {
  assert.equal(
    resolveGitReviewCwd("/workspace/example-repo", "../sibling-repo"),
    "/workspace/sibling-repo"
  );
  assert.equal(
    resolveGitReviewCwd("/workspace/example-repo", ""),
    "/workspace/example-repo"
  );
});

test("review persists and restores Pi-edited file suggestions across reloads", async () => {
  const source = await readFile(
    new URL("../extensions/pi-review-surface.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /restoreReviewFileCandidates\(/);
  assert.match(source, /appendEntry\(REVIEW_SUGGESTIONS_ENTRY,/);
});

test("review reloads Git-diff helpers instead of retaining stale module exports", async () => {
  const source = await readFile(
    new URL("../extensions/pi-review-surface.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /from "\.\.\/src\/review-git-diff\.mjs"/
  );
  assert.match(
    source,
    /importFreshSourceModule\(reviewGitDiffPath\)/
  );
});

test("file review choices suggest changed files before manual path entry", () => {
  assert.deepEqual(
    buildFileReviewChoices(
      ["/repo/docs/a.md", "/repo/src/b.ts", "/repo/docs/a.md"],
      "/repo"
    ),
    [
      { label: "Suggested · docs/a.md", value: "/repo/docs/a.md" },
      { label: "Recently changed · src/b.ts", value: "/repo/src/b.ts" },
      { label: "Enter another file path…", value: undefined }
    ]
  );
  assert.deepEqual(buildFileReviewChoices([], "/repo"), [
    { label: "Enter a file path…", value: undefined }
  ]);
});

test("review file candidates use only Pi-edited files when that list exists", () => {
  assert.deepEqual(
    mergeReviewFileCandidates(
      ["/repo/docs/recent.md"],
      [
        "src/changed.ts",
        ".agents/runtime/internal.json",
        "node_modules/generated.js",
        "docs/recent.md",
        "tests/new.test.ts",
        "src/changed.ts"
      ],
      "/repo",
      { limit: 3 }
    ),
    ["/repo/docs/recent.md"]
  );
});

test("review file candidates fall back to bounded non-internal Git changes", () => {
  assert.deepEqual(
    mergeReviewFileCandidates(
      [],
      [
        "src/changed.ts",
        ".agents/runtime/internal.json",
        "node_modules/generated.js",
        "tests/new.test.ts",
        "src/changed.ts"
      ],
      "/repo",
      { limit: 2 }
    ),
    ["/repo/src/changed.ts", "/repo/tests/new.test.ts"]
  );
});

test("session review files accumulate across turns without internal artifacts", () => {
  assert.deepEqual(
    mergeSessionReviewFiles(
      ["/repo/docs/older.md", "/repo/src/shared.ts"],
      [
        "/repo/src/new.ts",
        "/repo/.pi-subagents/artifacts/output.md",
        "/repo/node_modules/generated.js",
        "/repo/src/shared.ts"
      ],
      "/repo"
    ),
    [
      "/repo/src/new.ts",
      "/repo/src/shared.ts",
      "/repo/docs/older.md"
    ]
  );
});

test("session review targets show explicit modes then session-only files by recency", () => {
  assert.deepEqual(
    buildSessionReviewTargets({
      cwd: "/Users/ella/repo-a",
      home: "/Users/ella",
      filePaths: [
        "/Users/ella/repo-a/docs/plan.md",
        "/Users/ella/repo-b/docs/plan.md",
        "/Users/ella/repo-a/README.md"
      ],
      recentFilePaths: [
        "/Users/ella/repo-a/docs/plan.md",
        "/Users/ella/repo-b/docs/plan.md"
      ],
      modes: [
        { key: "recent", filePath: "/tmp/recent.diff", empty: false },
        { key: "staged", filePath: "/tmp/staged.diff", empty: true },
        { key: "commit", filePath: "/tmp/commit.diff", empty: false },
        { key: "branch", filePath: "/tmp/branch.diff", empty: false }
      ]
    }),
    [
      {
        filePath: "/tmp/recent.diff",
        group: "Review modes",
        label: "Last Pi turn",
        display: { title: "Last Pi turn", scope: "Exact changes from the immediately preceding Pi turn" }
      },
      {
        filePath: "/tmp/staged.diff",
        group: "Review modes",
        label: "Staged · no changes",
        display: { title: "Staged changes", scope: "Git index compared with HEAD" }
      },
      {
        filePath: "/tmp/commit.diff",
        group: "Review modes",
        label: "Latest commit",
        display: { title: "Latest commit", scope: "HEAD^..HEAD" }
      },
      {
        filePath: "/tmp/branch.diff",
        group: "Review modes",
        label: "Branch vs main",
        display: { title: "Branch vs main", scope: "origin/main...HEAD" }
      },
      {
        filePath: "/Users/ella/repo-a/docs/plan.md",
        group: "Recent edits · newest first",
        label: "01 · plan.md — docs/plan.md",
        display: { title: "plan.md", scope: "Edited last Pi turn · docs/plan.md" }
      },
      {
        filePath: "/Users/ella/repo-b/docs/plan.md",
        group: "Recent edits · newest first",
        label: "02 · plan.md — ~/repo-b/docs/plan.md",
        display: { title: "plan.md", scope: "Edited last Pi turn · ~/repo-b/docs/plan.md" }
      },
      {
        filePath: "/Users/ella/repo-a/README.md",
        group: "Recent edits · newest first",
        label: "03 · README.md — README.md",
        display: { title: "README.md", scope: "Edited earlier this session · README.md" }
      }
    ]
  );
});

test("relevant files are pinned separately without scanning unrelated plans", () => {
  const targets = buildSessionReviewTargets({
    cwd: "/repo",
    home: "/Users/ella",
    filePaths: ["/repo/docs/migration-plan.md", "/repo/src/controller.py"],
    recentFilePaths: ["/repo/src/controller.py"],
    relevantFilePaths: ["/repo/docs/migration-plan.md"]
  });
  assert.deepEqual(targets.map(({ filePath, group }) => ({ filePath, group })), [
    { filePath: "/repo/docs/migration-plan.md", group: "Relevant files · 1" },
    { filePath: "/repo/src/controller.py", group: "Recent edits · newest first" }
  ]);
});

test("review shortlist persists only bounded local path metadata", () => {
  const updated = updateReviewShortlist([], [
    { filePath: "/repo/src/controller.py", reason: "primary-change", source: "automatic" },
    { filePath: "/repo/docs/plan.md", reason: "task-plan", source: "agent" },
    { filePath: "/outside/secret.md", reason: "task-plan", source: "agent" }
  ], "/repo", { allowedRoot: "/repo", now: "2026-08-24T12:00:00.000Z" });
  assert.deepEqual(updated.map(({ filePath, reason, source }) => ({ filePath, reason, source })), [
    { filePath: "/repo/src/controller.py", reason: "primary-change", source: "automatic" },
    { filePath: "/repo/docs/plan.md", reason: "task-plan", source: "agent" }
  ]);
  assert.deepEqual(
    restoreReviewShortlist([{
      type: "custom",
      customType: REVIEW_SHORTLIST_ENTRY,
      data: { cwd: "/repo", items: updated, prompt: "must not survive" }
    }], "/repo", { allowedRoot: "/repo" }),
    updated
  );
});

test("automatic review relevance excludes noisy support files", () => {
  assert.deepEqual(
    automaticReviewShortlistCandidates([
      "/repo/uv.lock",
      "/repo/src/controller.py",
      "/repo/src/controller_test.py",
      "/repo/generated/schema.md",
      "/repo/docs/campaign-plan.md"
    ], "/repo"),
    ["/repo/docs/campaign-plan.md", "/repo/src/controller.py", "/repo/src/controller_test.py"]
  );
});

test("recent session edits span turns while older files stay collapsed", () => {
  const files = Array.from({ length: 11 }, (_, index) => `/repo/file-${index}.md`);
  const targets = buildSessionReviewTargets({
    cwd: "/repo",
    home: "/Users/ella",
    filePaths: files,
    recentFilePaths: [files[0], files[1]],
    recentEditsLimit: 8
  });
  assert.deepEqual(targets.slice(0, 8).map((target) => target.group),
    Array(8).fill("Recent edits · newest first"));
  assert.deepEqual(targets.slice(8).map((target) => target.group),
    Array(3).fill("Older this session · 3 files"));
  assert.match(targets[0].display.scope, /Edited last Pi turn/);
  assert.match(targets[2].display.scope, /Edited earlier this session/);
});

test("session review file recency uses modification time with stable ties", () => {
  assert.deepEqual(
    sortSessionReviewFiles([
      { filePath: "/repo/older.md", mtimeMs: 10 },
      { filePath: "/repo/new-a.md", mtimeMs: 30 },
      { filePath: "/repo/new-b.md", mtimeMs: 30 },
      { filePath: "/repo/middle.md", mtimeMs: 20 }
    ]),
    [
      "/repo/new-a.md",
      "/repo/new-b.md",
      "/repo/middle.md",
      "/repo/older.md"
    ]
  );
});

test("session review does not backfill its file list from repository Git status", async () => {
  const source = await readFile(
    new URL("../extensions/pi-review-surface.ts", import.meta.url),
    "utf8"
  );
  const body = source.match(/async function openSessionReview[\s\S]*?\n\t}/)?.[0] ?? "";
  assert.doesNotMatch(body, /reviewFileCandidates/);
});

test("session review files can span repositories inside one approved root", () => {
  assert.deepEqual(
    mergeSessionReviewFiles(
      ["/Users/ella/repo-a/docs/a.md"],
      ["/Users/ella/repo-b/src/b.ts", "/private/outside.txt"],
      "/Users/ella/repo-b",
      { allowedRoot: "/Users/ella" }
    ),
    ["/Users/ella/repo-b/src/b.ts", "/Users/ella/repo-a/docs/a.md"]
  );
});

test("last-turn review suggestions survive extension reload for the same workspace", () => {
  assert.deepEqual(
    restoreReviewFileCandidates(
      [
        {
          type: "custom",
          customType: REVIEW_SUGGESTIONS_ENTRY,
          data: {
            cwd: "/repo",
            files: ["/repo/src/older.ts"]
          }
        },
        {
          type: "custom",
          customType: REVIEW_SUGGESTIONS_ENTRY,
          data: {
            cwd: "/repo",
            files: [
              "/repo/docs/current.md",
              "/repo/src/current.ts",
              "/outside/ignore.md"
            ]
          }
        }
      ],
      "/repo"
    ),
    ["/repo/docs/current.md", "/repo/src/current.ts"]
  );
});

test("latest targeted files remain distinct from cumulative session history", () => {
  assert.deepEqual(
    restoreRecentReviewFileCandidates([
      {
        type: "custom",
        customType: REVIEW_SUGGESTIONS_ENTRY,
        data: {
          cwd: "/repo",
          files: ["/repo/old.md", "/repo/latest.md"],
          recentFiles: ["/repo/latest.md"]
        }
      }
    ], "/repo"),
    ["/repo/latest.md"]
  );
});

test("legacy sessions recover only latest-turn tool paths across repositories", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "old request" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", name: "edit", arguments: { path: "/Users/ella/old.md" } }
    ] } },
    { type: "message", message: { role: "user", content: "latest request" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", name: "edit", arguments: { path: "/Users/ella/episode/a.yaml" } },
      { type: "toolCall", name: "write", arguments: { path: "/Users/ella/episode/b.md" } }
    ] } },
    { type: "message", message: { role: "user", content: "open review" } },
    { type: "message", message: { role: "assistant", content: "review opened" } }
  ];
  assert.deepEqual(
    restoreRecentToolFileCandidates(entries, "/Users/ella/repo", {
      allowedRoot: "/Users/ella"
    }),
    ["/Users/ella/episode/a.yaml", "/Users/ella/episode/b.md"]
  );
});

test("review tool paths include every file in an apply_patch call", () => {
  assert.deepEqual(
    reviewToolFilePaths("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: docs/one.md",
        "*** Add File: /Users/ella/episode/two.yaml",
        "*** Delete File: old/three.txt",
        "*** End Patch"
      ].join("\n")
    }),
    ["docs/one.md", "/Users/ella/episode/two.yaml", "old/three.txt"]
  );
  assert.deepEqual(reviewToolFilePaths("edit", { path: "src/one.ts" }), ["src/one.ts"]);
  assert.deepEqual(reviewToolFilePaths("read", { path: "src/one.ts" }), []);
});

test("review suggestions are relative, quoted, unique, and bounded", () => {
  assert.deepEqual(
    buildReviewSuggestions([
      "/repo/src/a.ts",
      "/repo/docs/plan with spaces.md",
      "/repo/src/a.ts",
      "/outside/note.md",
      "/repo/src/ignored.ts"
    ], "/repo"),
    [
      "/review src/a.ts",
      '/review "docs/plan with spaces.md"',
      "/review /outside/note.md"
    ]
  );
  assert.deepEqual(buildReviewSuggestions([], "/repo"), []);
  const unusual = buildReviewSuggestions(['/repo/a\'b"c.md'], "/repo")[0];
  assert.equal(
    parseReviewPathArgument(unusual.slice("/review ".length)),
    'a\'b"c.md'
  );
});

test("anchored overlays stay beside their passage and inside the viewport", () => {
  assert.deepEqual(
    positionAnchoredOverlay({
      anchor: { left: 200, right: 300, top: 250, bottom: 270 },
      viewport: { width: 800, height: 600 },
      overlay: { width: 120, height: 40 },
      headerBottom: 48,
      align: "center",
      preferred: "above"
    }),
    { left: 190, top: 202 }
  );
  assert.deepEqual(
    positionAnchoredOverlay({
      anchor: { left: 760, right: 790, top: 560, bottom: 580 },
      viewport: { width: 800, height: 600 },
      overlay: { width: 300, height: 180 },
      headerBottom: 48,
      preferred: "below"
    }),
    { left: 488, top: 372 }
  );
  assert.equal(scrollDeltaToPreserveAnchor(220, 310), 90);
  assert.equal(scrollDeltaToPreserveAnchor(220, Number.NaN), 0);
});

test("disk updates reload only clean or unchanged submitted reviews", () => {
  const base = {
    changed: true,
    savedContent: "disk",
    editorContent: "disk",
    submittedContent: null,
    annotationCount: 0
  };
  assert.equal(reviewDiskUpdateAction({ ...base, changed: false }), "none");
  assert.equal(reviewDiskUpdateAction(base), "reload-clean");
  assert.equal(
    reviewDiskUpdateAction({
      ...base,
      editorContent: "disk [an: review]",
      submittedContent: "disk [an: review]",
      annotationCount: 1
    }),
    "reload-submitted"
  );
  assert.equal(
    reviewDiskUpdateAction({
      ...base,
      editorContent: "edited locally",
      annotationCount: 0
    }),
    "conflict"
  );
  assert.equal(
    reviewDiskUpdateAction({
      ...base,
      editorContent: "disk [an: changed after submit]",
      submittedContent: "disk [an: original submission]",
      annotationCount: 1
    }),
    "conflict"
  );
});

test("review files are classified conservatively", () => {
  assert.equal(classifyReviewFile("/tmp/plan.md"), "markdown");
  assert.equal(classifyReviewFile("/tmp/change.patch"), "diff");
  assert.equal(classifyReviewFile("/tmp/main.go"), "text");
  assert.equal(classifyReviewFile("/tmp/archive.zip"), null);
});

test("markdown annotations are inserted after the exact selected range", () => {
  const source = "Keep this sentence.\n";
  const selected = "this sentence";
  const start = source.indexOf(selected);
  const result = insertMarkdownAnnotation(
    source,
    start,
    start + selected.length,
    "Clarify   the invariant.\nPlease."
  );

  assert.equal(
    result.content,
    "Keep this sentence [an: Clarify the invariant. Please.].\n"
  );
  assert.deepEqual(result.selection, { start, end: start + selected.length });

  const pending = insertMarkdownAnnotation(
    source,
    start,
    start + selected.length,
    "",
    { allowEmpty: true }
  );
  assert.equal(pending.content, "Keep this sentence [an: ].\n");
  assert.equal(parseMarkdownAnnotations(pending.content)[0].comment, "");
  assert.match(
    decorateAnnotationHtml("<p>Keep this sentence [an: ].</p>"),
    /data-annotation-index="0"/
  );
  assert.throws(
    () => insertMarkdownAnnotation(source, start, start + selected.length, ""),
    /comment is required/
  );
});

test("markdown annotations render, edit, and remove as a staged review set", () => {
  const source =
    "First claim [an: Add evidence].\nSecond claim [an: Clarify scope].\n";
  const annotations = parseMarkdownAnnotations(source);

  assert.deepEqual(
    annotations.map(({ comment, context, lineNumber }) => ({
      comment,
      context,
      lineNumber
    })),
    [
      { comment: "Add evidence", context: "First claim", lineNumber: 1 },
      { comment: "Clarify scope", context: "Second claim", lineNumber: 2 }
    ]
  );
  assert.match(
    decorateAnnotationHtml("<p>First claim [an: Add evidence].</p>"),
    /class="annotation"[^>]*data-annotation-index="0"[^>]*>.*class="annotation-comment">Add evidence<\/span><\/button>/
  );
  assert.match(
    decorateAnnotationHtml("<p>[an: First] and [an: Second]</p>"),
    /data-annotation-index="0"[\s\S]*data-annotation-index="1"/
  );

  const edited = updateMarkdownAnnotation(source, 0, "Cite the benchmark.");
  assert.match(edited.content, /\[an: Cite the benchmark\.\]/);
  assert.deepEqual(
    edited.annotations.map((annotation) => annotation.comment),
    ["Cite the benchmark.", "Clarify scope"]
  );

  const removed = updateMarkdownAnnotation(edited.content, 1, null);
  assert.doesNotMatch(removed.content, /Clarify scope/);
  assert.deepEqual(
    removed.annotations.map((annotation) => annotation.comment),
    ["Cite the benchmark."]
  );
});

test("markdown annotation batches become one bounded Pi draft addition", () => {
  const draft = formatAnnotationBatchDraft({
    sourcePath: "/repo/plan.md",
    annotations: [
      { context: "First claim", comment: "Add evidence.", lineNumber: 12 },
      { context: "Second claim", comment: "Clarify scope.", lineNumber: 27 }
    ]
  });

  assert.match(draft, /2 inline comments/);
  assert.match(draft, /1\. Line 12: Add evidence\./);
  assert.match(draft, /Context: First claim/);
  assert.match(draft, /2\. Line 27: Clarify scope\./);
  assert.ok(draft.length < 2_000);
  assert.throws(
    () => formatMultiFileAnnotationBatchDraft({
      documents: [
        {
          sourcePath: "/repo/first.md",
          annotations: [{ context: "First", comment: "", lineNumber: 1 }]
        },
        {
          sourcePath: "/repo/second.md",
          annotations: [{ context: "Second", comment: "Clarify.", lineNumber: 2 }]
        }
      ]
    }),
    /unfinished inline comment/
  );
});

test("rendered Markdown selections map back through formatting and repeated text", () => {
  const formatted = "This is **important text** in the plan.\n";
  assert.deepEqual(
    resolveMarkdownSelection(formatted, {
      text: "This is important text",
      prefix: "",
      suffix: " in the plan."
    }),
    {
      start: 0,
      end: formatted.indexOf("**", formatted.indexOf("**") + 2) + 2
    }
  );

  const repeated = "First retry is safe.\n\nSecond retry is safe.\n";
  const secondStart = repeated.indexOf("retry", repeated.indexOf("retry") + 1);
  assert.deepEqual(
    resolveMarkdownSelection(repeated, {
      text: "retry is safe.",
      prefix: "Second ",
      suffix: ""
    }),
    { start: secondStart, end: secondStart + "retry is safe.".length }
  );
  assert.throws(
    () => resolveMarkdownSelection(repeated, {
      text: "retry is safe.",
      prefix: "",
      suffix: ""
    }),
    /ambiguous/
  );

  const firstAnnotated = insertMarkdownAnnotation(
    "Repeat this.\nFirst context.\nRepeat this.\nSecond context.\n",
    0,
    "Repeat this".length,
    "Existing comment"
  ).content;
  const secondSelection = resolveMarkdownSelection(firstAnnotated, {
    text: "Repeat this",
    prefix: "First context.",
    suffix: "Second context."
  });
  assert.equal(
    firstAnnotated.slice(secondSelection.start, secondSelection.end),
    "Repeat this"
  );

  const acrossAnnotation = "Alpha [an: Existing comment] beta.\n";
  const acrossSelection = resolveMarkdownSelection(acrossAnnotation, {
    text: "Alpha beta.",
    prefix: "",
    suffix: ""
  });
  assert.equal(acrossSelection.start, 0);
  assert.equal(acrossSelection.end, acrossAnnotation.length - 1);

  const table = [
    "| Name | Value |",
    "| --- | --- |",
    "| Alpha | One |",
    "| Beta | Two |",
    ""
  ].join("\n");
  const multiLineTableSelection = resolveMarkdownSelection(table, {
    text: "Alpha One Beta Two",
    prefix: "Name Value",
    suffix: ""
  });
  assert.equal(
    table.slice(multiLineTableSelection.start, multiLineTableSelection.end),
    "Alpha | One |\n| Beta | Two"
  );

  const wrappedInlineCode = [
    "`nccl_test.mfu` is a DogStatsD workload signal. When its 30-second value",
    "range exceeds `range_epsilon`, lookback forwards retained GPU context. The",
    "monitor metric is admitted automatically; it does not need to appear under",
    "`dogstatsd.metric_names`."
  ].join("\n");
  const wrappedInlineCodeText = [
    "nccl_test.mfu is a DogStatsD workload signal. When its 30-second value",
    "range exceeds range_epsilon, lookback forwards retained GPU context. The",
    "monitor metric is admitted automatically; it does not need to appear under",
    "dogstatsd.metric_names."
  ].join(" ");
  const wrappedInlineCodeSelection = resolveMarkdownSelection(wrappedInlineCode, {
    text: wrappedInlineCodeText,
    prefix: "",
    suffix: ""
  });
  assert.deepEqual(wrappedInlineCodeSelection, {
    start: 1,
    end: wrappedInlineCode.length
  });
});

test("GFM rendering covers structured Markdown while escaping raw HTML", async () => {
  const html = await renderMarkdownForReview([
    "# Heading",
    "",
    "- [x] complete",
    "- [ ] pending",
    "",
    "| Name | Value |",
    "| --- | ---: |",
    "| latency | 12 |",
    "",
    "> quoted",
    "",
    "~~removed~~ and **strong** and [link](https://example.com).",
    "",
    "[unsafe](javascript:alert(1))",
    "",
    "```js",
    "const value = 1;",
    "```",
    "",
    "<script>alert('no')</script>"
  ].join("\n"));

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<input[^>]*checked[^>]*type="checkbox"/);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<del>removed<\/del>/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("diff comments persist anchors and hashes but never copied diff text", () => {
  const comment = createDiffComment({
    sourcePath: "/repo/change.diff",
    filePath: "pkg/example.go",
    side: "new",
    startLine: 12,
    endLine: 14,
    comment: "Handle the error before returning.",
    selectedText: "+secret implementation detail\n+another line"
  }, { now: "2026-07-28T12:00:00.000Z", id: "comment-1" });

  assert.match(comment.contextHash, /^[a-f0-9]{16}$/);
  assert.deepEqual(comment, {
    id: "comment-1",
    sourcePath: "/repo/change.diff",
    filePath: "pkg/example.go",
    side: "new",
    startLine: 12,
    endLine: 14,
    comment: "Handle the error before returning.",
    contextHash: comment.contextHash,
    createdAt: "2026-07-28T12:00:00.000Z",
    resolved: false
  });
  assert.equal("selectedText" in comment, false);
});

test("diff comments can be edited, removed, and batched without copied source", () => {
  const comments = [
    createDiffComment({
      sourcePath: "/repo/change.diff",
      filePath: "pkg/example.go",
      side: "new",
      startLine: 12,
      endLine: 14,
      comment: "Original note",
      selectedText: "+private code"
    }, { id: "comment-1" })
  ];
  const updated = updateDiffCommentCollection(comments, {
    id: "comment-1",
    comment: "Updated note"
  });
  assert.equal(updated[0].comment, "Updated note");
  assert.equal(
    formatDiffCommentBatchDraft({
      sourcePath: "/repo/change.diff",
      comments: updated
    }),
    "Diff review batch from /repo/change.diff (1 inline comment):\n" +
      "1. pkg/example.go:12-14 (new): Updated note"
  );
  assert.doesNotMatch(formatDiffCommentBatchDraft({
    sourcePath: "/repo/change.diff",
    comments: updated
  }), /private code/);
  assert.deepEqual(
    updateDiffCommentCollection(updated, { id: "comment-1", remove: true }),
    []
  );
});

test("review draft formatting is bounded and preserves an existing Pi draft", () => {
  const addition = formatReviewDraft({
    sourcePath: "/repo/plan.md",
    selection: "A".repeat(20_000),
    comment: "Tighten this claim.",
    maxSelectionChars: 120
  });

  assert.match(addition, /plan\.md/);
  assert.match(addition, /Tighten this claim/);
  assert.ok(addition.length < 500);
  assert.equal(
    appendReviewDraft("existing direction", addition),
    `existing direction\n\n${addition}`
  );
});

test("review session routing prefers the exact cmux workspace then the longest cwd", () => {
  const sessions = [
    {
      workspaceId: "workspace-a",
      cwd: "/repo",
      updatedAt: "2026-07-28T12:00:00.000Z"
    },
    {
      workspaceId: "workspace-b",
      cwd: "/repo/service",
      updatedAt: "2026-07-28T11:00:00.000Z"
    }
  ];

  assert.equal(
    selectReviewSession(sessions, {
      workspaceId: "workspace-a",
      filePath: "/repo/service/file.md"
    }),
    sessions[0]
  );
  assert.equal(
    selectReviewSession(sessions, {
      workspaceId: "",
      filePath: "/repo/service/file.md"
    }),
    sessions[1]
  );
});

test("one review workspace navigates a large session file set from a sidebar", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-set-"));
  const commentsPath = path.join(root, "comments.json");
  const filePaths = Array.from({ length: 12 }, (_, index) =>
    path.join(root, index === 0 ? "values.yaml" : `file-${index}.md`)
  );
  await Promise.all(filePaths.map((filePath, index) =>
    writeFile(filePath, index === 0 ? "enabled: true\n" : `# File ${index}\n`, "utf8")
  ));
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async () => {}
  });
  t.after(() => service.close());

  const opened = await service.openFiles(filePaths.map((filePath, index) => ({
    filePath,
    group: index < 8 ? "Recent edits · newest first" : "Older this session · 4 files",
    label: index === 0 ? "01 · values.yaml — charts/values.yaml" : undefined
  })));
  assert.equal(opened.count, 12);
  const html = await (await fetch(opened.url)).text();
  assert.match(html, /class="review-sidebar"/);
  assert.match(html, /Recent edits · newest first/);
  assert.match(html, /<details class="nav-group"/);
  assert.match(html, /<summary>Older this session · 4 files<\/summary>/);
  assert.match(html, /@media\(max-width:800px\)/);
  assert.match(html, /class="nav-name">01 · values\.yaml<\/span><small>charts\/values\.yaml<\/small>/);
  assert.match(html, />file-11\.md<\/a>/);
});

test("an open session workspace exposes newly edited files without reopening", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-live-set-"));
  const paths = ["first.md", "second.md", "third.md"].map((name) => path.join(root, name));
  await Promise.all(paths.map((filePath) => writeFile(filePath, `# ${path.basename(filePath)}\n`, "utf8")));
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath: path.join(root, "comments.json"),
    onAppendDraft: async () => {}
  });
  t.after(() => service.close());
  const opened = await service.openFiles(paths.slice(0, 2), { workspaceKey: "live" });
  await service.setWorkspace(paths, { workspaceKey: "live" });
  const response = await fetch(`${service.baseUrl}/api/${opened.capability}/navigation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).navigation.map((item) => item.label),
    ["first.md", "second.md", "third.md"]
  );
});

test("a clean diff view reloads when its generated session diff changes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-live-diff-"));
  const diffPath = path.join(root, "session.diff");
  await writeFile(diffPath, "--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath: path.join(root, "comments.json"),
    onAppendDraft: async () => {}
  });
  t.after(() => service.close());
  const opened = await service.openFile(diffPath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(diffPath, "--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+newer\n", "utf8");
  const stateResponse = await fetch(`${service.baseUrl}/api/${opened.capability}/file-state`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal((await stateResponse.json()).changed, true);
  const reloadResponse = await fetch(`${service.baseUrl}/api/${opened.capability}/reload`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.match((await reloadResponse.json()).content, /\+newer/);
});

test("review command defaults to the cumulative session workspace and reuses a cmux popout", async () => {
  const [source, surfaceSource] = await Promise.all([
    readFile(new URL("../extensions/pi-review-surface.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/review-surface.mjs", import.meta.url), "utf8")
  ]);
  assert.match(source, /openSessionReview\(ctx\)/);
  assert.match(source, /mergeSessionReviewFiles\(/);
  assert.match(source, /cmux", \["--json", "new-window"\]/);
  assert.match(source, /browser", "--surface", reviewSurfaceId, "navigate"/);
  assert.match(source, /recentFiles:/);
  assert.match(source, /buildSessionReviewTargets: buildSessionTargetList/);
  assert.match(source, /filterReviewableSessionFileRecords/);
  assert.match(source, /classifyReviewFile/);
  assert.match(source, /reviewable file/);
  assert.match(source, /skipped/);
  assert.match(source, /recentFilePaths:/);
  assert.match(source, /reviewShortlist/);
  assert.match(source, /relevantFilePaths/);
  assert.match(surfaceSource, /startsWith\("Earlier this session"\)/);
  assert.match(source, /"HEAD\^\.\.HEAD"/);
  assert.match(source, /"origin\/main"/);
});

test("loopback review service saves markdown atomically and keeps draft text transient", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-surface-"));
  const markdownPath = path.join(root, "plan.md");
  const imagePath = path.join(root, "pixel.png");
  const commentsPath = path.join(root, "comments.json");
  await writeFile(markdownPath, "# Plan\n\nOriginal.\n", "utf8");
  await writeFile(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  );
  const drafts = [];
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async (text) => drafts.push(text)
  });
  t.after(() => service.close());

  const opened = await service.openFile(markdownPath);
  const page = await fetch(opened.url);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'nonce-[A-Za-z0-9_-]+'/
  );
  assert.doesNotMatch(
    page.headers.get("content-security-policy"),
    /script-src 'unsafe-inline'/
  );
  const pageHtml = await page.text();
  assert.match(pageHtml, /Pi Review/);
  assert.match(pageHtml, /Review comments/);
  assert.match(pageHtml, /id="inline-editor"/);
  assert.match(pageHtml, /id="inline-update-next"/);
  assert.match(pageHtml, /id="selection-action"/);
  assert.match(pageHtml, /--annotation-bg:#fff0f7/);
  assert.match(pageHtml, /\.annotation\{[^}]*font:500 12px/);
  assert.match(pageHtml, /\.annotation\{[^}]*text-align:left/);
  assert.match(pageHtml, /\.annotation\{[^}]*border-left:3px solid var\(--annotation-border\)/);
  assert.match(pageHtml, /\.annotation\{[^}]*border-radius:3px/);
  assert.doesNotMatch(pageHtml, /\.annotation\{[^}]*border-radius:999px/);
  assert.match(pageHtml, /\.annotation-comment\{[^}]*text-align:left/);
  assert.match(pageHtml, /\.inline-comment\{[^}]*text-align:left/);
  assert.match(pageHtml, /\.inline-comment\{[^}]*border-left:3px solid var\(--annotation-border\)/);
  assert.match(pageHtml, /\.inline-comment\{[^}]*border-radius:3px/);
  assert.match(pageHtml, /actionSelection=renderedSelection/);
  assert.match(pageHtml, /rangeTextWithoutAnnotations/);
  assert.match(pageHtml, /const text=rangeTextWithoutAnnotations\(range\)\.trim\(\)/);
  assert.match(pageHtml, /\.annotation\{[^}]*user-select:none/);
  assert.match(pageHtml, /preview\.addEventListener\("pointerup"/);
  assert.match(pageHtml, /function clearRenderedSelection/);
  assert.match(pageHtml, /commentMode=true/);
  assert.match(pageHtml, /Comment saved — select another passage/);
  assert.match(pageHtml, /if\(!selection\|\|selection\.rangeCount!==1\|\|selection\.isCollapsed\)\{return null\}/);
  assert.match(pageHtml, /wireInlineAnnotations/);
  assert.match(pageHtml, /id="reload-file"/);
  assert.match(pageHtml, /file-state/);
  assert.match(pageHtml, /reviewSubmittedContent/);
  assert.match(pageHtml, /Updated after review/);
  assert.match(pageHtml, /id="refresh-state"/);
  assert.match(pageHtml, /Last refreshed/);
  assert.match(pageHtml, /touchRefreshStatus/);
  assert.doesNotMatch(pageHtml, /if\(document\.hidden\|\|checkingFileState\)return/);
  assert.match(pageHtml, /Save failed:/);
  assert.match(pageHtml, /openInlineEditorAt/);
  assert.match(pageHtml, /draft-batch/);
  assert.match(pageHtml, /annotation-update/);
  assert.match(pageHtml, /workspaceAnnotationCount/);

  const renderResponse = await fetch(`${service.baseUrl}/api/${opened.capability}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "![pixel](pixel.png)" })
  });
  assert.equal(renderResponse.status, 200);
  const rendered = await renderResponse.json();
  assert.match(rendered.html, new RegExp(`/asset/${opened.capability}\\?path=pixel\\.png`));
  const assetResponse = await fetch(
    `${service.baseUrl}/asset/${opened.capability}?path=pixel.png`
  );
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get("content-type"), "image/png");

  const before = await stat(markdownPath);
  const draftResponse = await fetch(`${service.baseUrl}/api/${opened.capability}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selection: "Original.",
      comment: "Make this measurable."
    })
  });
  assert.equal(draftResponse.status, 204);
  assert.equal(drafts.length, 1);
  assert.equal(await readFile(markdownPath, "utf8"), "# Plan\n\nOriginal.\n");

  const saveResponse = await fetch(`${service.baseUrl}/api/${opened.capability}/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "# Plan\n\nUpdated.\n",
      expectedMtimeMs: before.mtimeMs
    })
  });
  assert.equal(saveResponse.status, 200);
  assert.equal(await readFile(markdownPath, "utf8"), "# Plan\n\nUpdated.\n");
});

test("an open review page can recover its capability after the loopback server reloads", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-reload-"));
  const markdownPath = path.join(root, "plan.md");
  const commentsPath = path.join(root, "comments.json");
  await writeFile(markdownPath, "# Reload-safe review\n", "utf8");

  const first = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async () => {}
  });
  t.after(() => first.close());
  const opened = await first.openFile(markdownPath);
  const pageHtml = await (await fetch(opened.url)).text();
  const recoveryToken = pageHtml.match(/"recoveryToken":"([a-f0-9]+)"/)?.[1];
  const sourcePath = pageHtml.match(/"sourcePath":"([^"]+)"/)?.[1];
  assert.ok(recoveryToken);
  assert.ok(sourcePath);
  const recovery = first.recoveryState;
  await first.close();

  const second = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async () => {},
    port: recovery.port,
    recoverySecret: recovery.secret
  });
  t.after(() => second.close());
  assert.equal(second.baseUrl, first.baseUrl);

  const rejectedResponse = await fetch(`${second.baseUrl}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourcePath: path.join(root, "other.md"),
      recoveryToken
    })
  });
  assert.equal(rejectedResponse.status, 401);

  const recoveredResponse = await fetch(`${second.baseUrl}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourcePath,
      recoveryToken
    })
  });
  assert.equal(recoveredResponse.status, 200);
  const recovered = await recoveredResponse.json();
  assert.match(recovered.capability, /^[a-f0-9]+$/);

  const saveResponse = await fetch(
    `${second.baseUrl}/api/${recovered.capability}/save`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "# Recovered and saved\n",
        expectedMtimeMs: recovered.mtimeMs
      })
    }
  );
  assert.equal(saveResponse.status, 200);
  assert.equal(await readFile(markdownPath, "utf8"), "# Recovered and saved\n");
  assert.match(pageHtml, /recoverCapability/);
});

test("a recovered review page regains its cumulative session sidebar", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-workspace-reload-"));
  const firstPath = path.join(root, "first.md");
  const secondPath = path.join(root, "second.md");
  const commentsPath = path.join(root, "comments.json");
  await writeFile(firstPath, "# First\n", "utf8");
  await writeFile(secondPath, "# Second\n", "utf8");

  const first = await createReviewServer({
    allowedRoots: [root], commentsPath, onAppendDraft: async () => {}
  });
  t.after(() => first.close());
  const opened = await first.openFiles([firstPath, secondPath], {
    workspaceKey: "session-1"
  });
  const pageHtml = await (await fetch(opened.url)).text();
  const recoveryToken = pageHtml.match(/"recoveryToken":"([a-f0-9]+)"/)?.[1];
  const workspaceToken = pageHtml.match(/"workspaceToken":"([a-f0-9]+)"/)?.[1];
  const sourcePath = pageHtml.match(/"sourcePath":"([^"]+)"/)?.[1];
  const recovery = first.recoveryState;
  assert.ok(recoveryToken);
  assert.ok(workspaceToken);
  assert.ok(sourcePath);
  await first.close();

  const second = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async () => {},
    port: recovery.port,
    recoverySecret: recovery.secret
  });
  t.after(() => second.close());
  await second.setWorkspace([firstPath, secondPath], { workspaceKey: "session-1" });
  const response = await fetch(`${second.baseUrl}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourcePath,
      recoveryToken,
      workspaceToken,
      workspaceIndex: 0
    })
  });
  assert.equal(response.status, 200);
  const recovered = await response.json();
  const navigation = await fetch(
    `${second.baseUrl}/api/${recovered.capability}/navigation`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
  );
  assert.equal(navigation.status, 200);
  assert.deepEqual(
    (await navigation.json()).navigation.map((item) => item.label),
    ["first.md", "second.md"]
  );
});

test("loopback review service rejects paths outside its roots and stale saves", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-review-outside-"));
  const markdownPath = path.join(root, "plan.md");
  const outsidePath = path.join(outside, "secret.md");
  await writeFile(markdownPath, "original\n", "utf8");
  await writeFile(outsidePath, "outside\n", "utf8");
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath: path.join(root, "comments.json"),
    onAppendDraft: async () => {}
  });
  t.after(() => service.close());

  await assert.rejects(service.openFile(outsidePath), /outside the allowed roots/);

  const opened = await service.openFile(markdownPath);
  const original = await stat(markdownPath);
  const initialStateResponse = await fetch(
    `${service.baseUrl}/api/${opened.capability}/file-state`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  assert.equal(initialStateResponse.status, 200);
  assert.equal((await initialStateResponse.json()).changed, false);

  await writeFile(markdownPath, "changed elsewhere\n", "utf8");
  const changedStateResponse = await fetch(
    `${service.baseUrl}/api/${opened.capability}/file-state`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  assert.equal(changedStateResponse.status, 200);
  assert.equal((await changedStateResponse.json()).changed, true);

  const response = await fetch(`${service.baseUrl}/api/${opened.capability}/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "stale overwrite\n",
      expectedMtimeMs: original.mtimeMs
    })
  });

  assert.equal(response.status, 409);
  assert.equal(await readFile(markdownPath, "utf8"), "changed elsewhere\n");

  const reloadResponse = await fetch(`${service.baseUrl}/api/${opened.capability}/reload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(reloadResponse.status, 200);
  const reloaded = await reloadResponse.json();
  assert.equal(reloaded.content, "changed elsewhere\n");
  assert.deepEqual(reloaded.annotations, []);
  assert.equal(reloaded.mtimeMs, (await stat(markdownPath)).mtimeMs);
});

test("loopback review service stages editable annotations and appends one batch draft", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-annotations-"));
  const markdownPath = path.join(root, "plan.md");
  await writeFile(markdownPath, "First claim.\nSecond claim.\n", "utf8");
  const drafts = [];
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath: path.join(root, "comments.json"),
    onAppendDraft: async (text) => drafts.push(text)
  });
  t.after(() => service.close());
  const opened = await service.openFile(markdownPath);
  const endpoint = (action) =>
    `${service.baseUrl}/api/${opened.capability}/${action}`;
  const post = (action, body) => fetch(endpoint(action), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const source = "First claim.\nSecond claim.\n";
  const selected = "First claim";
  const pendingResponse = await post("annotate-selection", {
    content: source,
    text: "Second claim.",
    prefix: "First claim.",
    suffix: "",
    comment: ""
  });
  assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json();
  assert.equal(pending.annotations[0].comment, "");
  assert.match(pending.content, /Second claim\. \[an: \]/);
  const pendingSaveResponse = await post("save", {
    content: pending.content,
    expectedMtimeMs: (await stat(markdownPath)).mtimeMs
  });
  assert.equal(pendingSaveResponse.status, 400);
  assert.match((await pendingSaveResponse.json()).error, /unfinished inline comment/);

  const stagedResponse = await post("annotate", {
    content: source,
    start: 0,
    end: selected.length,
    comment: "Add evidence."
  });
  assert.equal(stagedResponse.status, 200);
  const staged = await stagedResponse.json();
  assert.match(staged.content, /First claim \[an: Add evidence\.\]/);
  assert.equal(staged.annotations[0].context, "First claim");

  const editedResponse = await post("annotation-update", {
    content: staged.content,
    index: 0,
    comment: "Cite the benchmark."
  });
  assert.equal(editedResponse.status, 200);
  const edited = await editedResponse.json();
  assert.match(edited.content, /\[an: Cite the benchmark\.\]/);

  const batchResponse = await post("draft-batch", {
    annotations: edited.annotations
  });
  assert.equal(batchResponse.status, 204);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0], /Markdown review batch/);
  assert.match(drafts[0], /Cite the benchmark/);
  assert.equal(await readFile(markdownPath, "utf8"), source);

  const before = await stat(markdownPath);
  const firstSaveResponse = await post("save", {
    content: edited.content,
    expectedMtimeMs: before.mtimeMs
  });
  assert.equal(firstSaveResponse.status, 200);
  const firstSave = await firstSaveResponse.json();
  assert.equal(await readFile(markdownPath, "utf8"), edited.content);

  const secondContent = `${edited.content}\nSaved twice.\n`;
  const secondSaveResponse = await post("save", {
    content: secondContent,
    expectedMtimeMs: firstSave.mtimeMs
  });
  assert.equal(secondSaveResponse.status, 200);
  assert.equal(await readFile(markdownPath, "utf8"), secondContent);
});

test("session Markdown review batches survive file switches across documents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-multi-doc-"));
  const firstPath = path.join(root, "first.md");
  const secondPath = path.join(root, "second.md");
  await writeFile(firstPath, "First claim.\n", "utf8");
  await writeFile(secondPath, "Second claim.\n", "utf8");
  const drafts = [];
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath: path.join(root, "comments.json"),
    onAppendDraft: async (text) => drafts.push(text)
  });
  t.after(() => service.close());

  const first = await service.openFiles([firstPath, secondPath], {
    workspaceKey: "session-review"
  });
  const post = (capability, action, body = {}) => fetch(
    `${service.baseUrl}/api/${capability}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  const firstAnnotated = await post(first.capability, "annotate", {
    content: "First claim.\n",
    start: 0,
    end: "First claim".length,
    comment: "Clarify first."
  });
  assert.equal(firstAnnotated.status, 200);
  assert.equal((await firstAnnotated.json()).workspaceAnnotationCount, 1);

  const navigationResponse = await post(first.capability, "navigation");
  const secondUrl = (await navigationResponse.json()).navigation[1].url;
  const secondPage = await fetch(secondUrl);
  const secondCapability = secondPage.url.match(/\/review\/([a-f0-9]+)$/)?.[1];
  assert.ok(secondCapability);
  const secondHtml = await secondPage.text();
  assert.match(secondHtml, /second\.md/);

  const secondAnnotated = await post(secondCapability, "annotate", {
    content: "Second claim.\n",
    start: 0,
    end: "Second claim".length,
    comment: "Clarify second."
  });
  assert.equal(secondAnnotated.status, 200);
  assert.equal((await secondAnnotated.json()).workspaceAnnotationCount, 2);

  const firstAgainPage = await fetch(first.url);
  const firstAgainHtml = await firstAgainPage.text();
  assert.match(firstAgainHtml, /Clarify first\./);

  const batchResponse = await post(secondCapability, "draft-batch");
  assert.equal(batchResponse.status, 204);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0], /Markdown review batch \(2 inline comments across 2 files\):/);
  assert.match(drafts[0], /File: .*first\.md/);
  assert.match(drafts[0], /Line 1: Clarify first\./);
  assert.match(drafts[0], /File: .*second\.md/);
  assert.match(drafts[0], /Line 1: Clarify second\./);
  assert.equal(await readFile(firstPath, "utf8"), "First claim.\n");
  assert.equal(await readFile(secondPath, "utf8"), "Second claim.\n");

  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(firstPath, "First claim addressed.\n", "utf8");
  await writeFile(secondPath, "Second claim addressed.\n", "utf8");

  const firstAfterAddressed = await fetch(first.url);
  const firstAfterAddressedHtml = await firstAfterAddressed.text();
  assert.match(firstAfterAddressedHtml, /First claim addressed\./);
  assert.doesNotMatch(firstAfterAddressedHtml, /Clarify first\./);

  const secondAfterAddressed = await fetch(secondPage.url);
  const secondAfterAddressedHtml = await secondAfterAddressed.text();
  assert.match(secondAfterAddressedHtml, /Second claim addressed\./);
  assert.doesNotMatch(secondAfterAddressedHtml, /Clarify second\./);
});

test("loopback review service edits, removes, and batches inline diff comments", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-diff-comments-"));
  const diffPath = path.join(root, "change.diff");
  const commentsPath = path.join(root, "comments.json");
  await writeFile(
    diffPath,
    "diff --git a/file.go b/file.go\n--- a/file.go\n+++ b/file.go\n@@ -1 +1 @@\n-old\n+new\n",
    "utf8"
  );
  const drafts = [];
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async (text) => drafts.push(text)
  });
  t.after(() => service.close());
  const opened = await service.openFile(diffPath);
  const post = (action, body = {}) => fetch(
    `${service.baseUrl}/api/${opened.capability}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const createdResponse = await post("comment", {
    filePath: "file.go",
    side: "new",
    startLine: 1,
    endLine: 1,
    comment: "First note",
    selectedText: "+new"
  });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()).comment;

  const updatedResponse = await post("comment-update", {
    id: created.id,
    comment: "Use the validated value."
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json()).comments[0].comment, "Use the validated value.");

  const batchResponse = await post("draft-comments");
  assert.equal(batchResponse.status, 204);
  assert.match(drafts[0], /file\.go:1 \(new\): Use the validated value\./);

  const removedResponse = await post("comment-remove", { id: created.id });
  assert.equal(removedResponse.status, 200);
  assert.deepEqual((await removedResponse.json()).comments, []);
});

test("concurrent diff comments are serialized and never persist selected text", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-comments-"));
  const diffPath = path.join(root, "change.diff");
  const commentsPath = path.join(root, "comments.json");
  await writeFile(
    diffPath,
    "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n@@ -1 +1 @@\n-old\n+new\n",
    "utf8"
  );
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async () => {}
  });
  t.after(() => service.close());
  const opened = await service.openFile(diffPath);

  const addComment = (line, comment, selectedText) => fetch(
    `${service.baseUrl}/api/${opened.capability}/comment`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filePath: "main.go",
        side: "new",
        startLine: line,
        endLine: line,
        comment,
        selectedText
      })
    }
  );
  const responses = await Promise.all([
    addComment(1, "First comment.", "+private first line"),
    addComment(2, "Second comment.", "+private second line")
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);

  const persisted = await readFile(commentsPath, "utf8");
  const parsed = JSON.parse(persisted);
  assert.equal(parsed.comments.length, 2);
  assert.deepEqual(
    parsed.comments.map((comment) => comment.comment).sort(),
    ["First comment.", "Second comment."]
  );
  assert.doesNotMatch(persisted, /private (first|second) line/);
  assert.equal(parsed.comments.every((comment) => !("selectedText" in comment)), true);
});

test("review session registry is owner-only, bounded to metadata, and filters stale processes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-registry-"));
  const live = {
    schemaVersion: 1,
    sessionId: "live-session",
    pid: 123,
    cwd: "/repo",
    workspaceId: "workspace-a",
    surfaceId: "surface-a",
    baseUrl: "http://127.0.0.1:1234",
    bridgeToken: "secret-token",
    updatedAt: "2026-07-28T12:00:00.000Z",
    prompt: "must not be stored"
  };
  const stale = {
    ...live,
    sessionId: "stale-session",
    pid: 456,
    updatedAt: "2026-06-01T12:00:00.000Z"
  };
  const livePath = await writeReviewSession(root, live);
  await writeReviewSession(root, stale);

  const persisted = JSON.parse(await readFile(livePath, "utf8"));
  assert.equal(persisted.prompt, undefined);
  assert.deepEqual(Object.keys(persisted).sort(), [
    "baseUrl",
    "bridgeToken",
    "cwd",
    "pid",
    "schemaVersion",
    "sessionId",
    "surfaceId",
    "updatedAt",
    "workspaceId"
  ]);
  assert.equal((await stat(livePath)).mode & 0o777, 0o600);

  const sessions = await readReviewSessions(root, {
    now: new Date("2026-07-28T13:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60 * 1000,
    isProcessAlive: (pid) => pid === 123
  });
  assert.deepEqual(sessions.map((session) => session.sessionId), ["live-session"]);

  await removeReviewSession(root, "live-session");
  assert.deepEqual(
    await readReviewSessions(root, {
      now: new Date("2026-07-28T13:00:00.000Z"),
      isProcessAlive: () => true
    }),
    []
  );
});

test("git diff review arguments are explicit and reject option injection", () => {
  assert.deepEqual(buildGitDiffArgs(""), ["diff", "--no-ext-diff", "--"]);
  assert.deepEqual(buildGitDiffArgs("unstaged"), ["diff", "--no-ext-diff", "--"]);
  assert.deepEqual(buildGitDiffArgs("staged"), ["diff", "--cached", "--no-ext-diff", "--"]);
  assert.deepEqual(
    buildGitDiffArgs("origin/main"),
    ["diff", "--no-ext-diff", "origin/main...HEAD", "--"]
  );
  assert.throws(() => buildGitDiffArgs("--output=/tmp/copy"), /Invalid diff base/);
  assert.throws(() => buildGitDiffArgs("main other"), /Invalid diff base/);
  assert.equal(
    gitDiffReviewFilename("/repo", buildGitDiffArgs("staged")),
    gitDiffReviewFilename("/repo", buildGitDiffArgs("staged"))
  );
  assert.notEqual(
    gitDiffReviewFilename("/repo", buildGitDiffArgs("staged")),
    gitDiffReviewFilename("/repo", buildGitDiffArgs("unstaged"))
  );
  assert.match(gitDiffReviewFilename("/repo", buildGitDiffArgs("staged")), /^[a-f0-9]{24}\.diff$/);
  assert.match(recentTurnDiffFilename("session", 3), /^[a-f0-9]{24}\.diff$/);
  assert.notEqual(
    recentTurnDiffFilename("session", 2),
    recentTurnDiffFilename("session", 3)
  );
});

test("registers and documents the review surface without doc-copy drift", async () => {
  const [packageJson, extension, readme, quickstart, publicReadme, publicQuickstart] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../extensions/pi-review-surface.ts", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../QUICKSTART.md", import.meta.url), "utf8"),
      readFile(new URL("../html-guide/public/README.md", import.meta.url), "utf8"),
      readFile(new URL("../html-guide/public/QUICKSTART.md", import.meta.url), "utf8")
    ]);

  assert.match(packageJson, /pi-review-surface\.ts/);
  assert.match(packageJson, /pi-review-open\.mjs/);
  assert.doesNotMatch(extension, /registerCommand\("review-(?:recent|last|diff)"/);
  assert.match(extension, /What would you like to review\?/);
  assert.match(extension, /Which complete file do you want to review\?/);
  assert.match(extension, /Session review ready — run \/review/);
  assert.match(extension, /importFreshSourceModule/);
  assert.match(extension, /review-suggestions\.mjs/);
  assert.match(extension, /appendEntry\("pi-review-open-metrics"/);
  assert.doesNotMatch(
    extension,
    /from "\.\.\/src\/review-suggestions\.mjs"/
  );
  assert.doesNotMatch(extension, /review-surface\.mjs\?reload=/);
  assert.match(readme, /`\/review` is the single review entry point/);
  assert.match(quickstart, /Running `\/review` with no argument opens the cumulative session review workspace/);
  assert.match(quickstart, /\*\*Review modes\*\*/);
  assert.match(quickstart, /`HEAD\^\.\.HEAD`/);
  assert.match(quickstart, /`origin\/main\.\.\.HEAD`/);
  assert.match(quickstart, /file sidebar/);
  assert.match(quickstart, /\*\*Relevant files\*\*/);
  assert.match(quickstart, /Add to Pi/);
  assert.match(quickstart, /not the selected diff text/i);
  assert.equal(publicReadme, readme);
  assert.equal(publicQuickstart, quickstart);
});
