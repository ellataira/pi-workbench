# Changelog

This file records user-visible Pi Workbench changes. The README stays concise
and current; the quickstart holds complete usage details.

## 2026-09-16

- Added reliable Escape interruption after autocomplete closes during active Pi
  work, with a guarded installer and no change to idle prompt editing.

## 2026-09-11

- Improved `/review` navigation, Markdown preview/editing, and comment context
  while preserving bounded file discovery and raw-HTML safety.
- Added a guarded Pi native patch so Escape still interrupts active work after
  closing autocomplete, without changing idle prompt-editing behavior.
- Fixed daily memory promotion reminders so a missed review date reappears
  after 24 hours until it is completed.
- Changed the privacy-safe Pi health audit from monthly to twice monthly on the
  1st and 15th so maintenance regressions are caught sooner.

## 2026-08-31

- Named `/resume` `Alt+Enter` cloned sessions and their cmux workspaces with a
  clear `-clone` suffix derived from the selected session.
- Made Markdown review comments session-level across the review workspace, so
  comments on multiple documents survive file switches and submit to Pi as one
  combined batch.
- Cleared submitted Markdown review comments per file once the addressed file
  changes on disk, while preserving unsubmitted comments across navigation.
- Kept open `/review` localhost pages watching for safe disk refreshes even
  when the review window is backgrounded, and added a visible last-refreshed
  timestamp.
- Kept open `/review` localhost sidebars refreshing after later agent turns, so
  new session/relevant files appear without reopening the review popout.
- Expanded `/review` relevant-file discovery from a tiny three-file automatic
  set to a bounded task-sized set while retaining generated, vendored,
  lockfile, and internal-artifact filters.
- Made successful Markdown **Save** return the review panel to rendered preview
  so the saved document can be verified visually immediately.
- Added a visible review-panel toast after comments or selections are inserted
  into Pi.
- Allowed Markdown-authored `<details>` and `<summary>` blocks to render in the
  review preview while continuing to escape other raw HTML and unsafe
  attributes.
- Preserved approximate scroll position when toggling `/review` Markdown files
  between rendered preview and source editing.
- Showed the highlighted Markdown excerpt for each inline review comment in
  both the review tray and the batch text inserted into Pi.
- Reused the existing `/review` browser surface with an in-page URL replacement
  so refresh/reopen updates the current tab instead of adding another tab.
- Improved background-run visibility and immediate `/copy` clipboard behavior
  while preserving prompt and transcript privacy.

## 2026-08-29

- Refined Agent Center background-run visibility and `/copy` clipboard behavior
  while preserving prompt and transcript privacy.

## 2026-08-28

- Marked child-side user answers in the parent progress widget so supervisors
  do not duplicate a question already answered in the child tab.
- Included active background `pi-subagents` in `/agents`, `/agents list`,
  `/agents status`, and the Agent Center widget without reading task prompts or
  transcripts.
- Kept `/copy` pointed at the last response with copyable CLI so later
  prose-only turns do not evict the recommended command.
- Made `/copy` immediately copy the suggested command to the clipboard before
  opening the picker, so `Cmd+V` works without an extra selection.

## 2026-08-26

- Made the GitHub repository private and removed organization-specific service
  endpoints, workload identifiers, repository names, and local paths from the
  tracked tree.
- Kept the optional Workspace connector endpoint in machine-local Pi
  configuration under a generic server name and added a privacy regression
  test for future syncs.
- Reworked Agent Center navigation so supervisors can follow, message, review,
  and open persistent children without unexpected tab switching.
- Made `/review` session-scoped and recency-aware, with explicit last-turn,
  last-commit, branch-from-main, staged, unstaged, and complete-file modes.
- Improved review popout reuse, live file refresh, relevant-file pinning, and
  inline Markdown and diff comment presentation.
- Prevented stale pet failure states from remaining visible indefinitely.

## 2026-08-23

- Added safer persistent-agent lifecycle handling, detached conversation forks,
  supervisor recovery, and clearer child progress visibility.
- Added session rename, end, rewind, multiline command copying, and resume-pane
  cloning workflows.
- Pinned and hardened `pi-subagents` so raw child inputs, transcripts, and
  metadata are not retained.
- Added the reusable persona-panel skill and expanded review relevance tracking.

## 2026-08-19

- Added the visible, user-controlled pair-programming terminal with bounded
  automatic output observation and Tab-completed command suggestions.
- Added the unified session review popout, recent-turn diffs, and inline comment
  batching into Pi.
- Added monthly health audits, aggregate usage statistics, and action-inbox
  reporting without prompt or transcript storage.
- Added resume cloning and expanded memory, MCP, pet, and review diagnostics.

## 2026-08-10

- Improved checkpoint cadence, compaction safety, proactive recall limits, and
  daily memory review reliability.
- Added immediate submitted-prompt rendering and the initial pair-terminal and
  Pi health-audit foundations.
- Improved MCP recovery guidance and review-diff reliability.

## 2026-08-04

- Reserved context for automatic compaction before model context exhaustion.

## 2026-08-03

- Created the portable Pi Workbench with compressed memory, review tools,
  orchestration, project profiles, MCP configuration, daily review, and the
  native lifecycle pet.
- Added portable bootstrap behavior and GitHub Actions coverage.
- Made MCP definitions portable while keeping credentials and runtime state out
  of Git.
