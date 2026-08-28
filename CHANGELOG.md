# Changelog

This file records user-visible Pi Workbench changes. The README stays concise
and current; the quickstart holds complete usage details.

## 2026-08-28

- Marked child-side user answers in the parent progress widget so supervisors
  do not duplicate a question already answered in the child tab.

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
