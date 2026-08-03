# Pi Workbench

This private repository is the canonical, portable source for Ella's Pi
cockpit. It provides:

New to the setup? Start with the complete [Pi + cmux quickstart](./QUICKSTART.md).

- explicit compressed session checkpoints in Obsidian;
- bounded recall and explicit global/project memory promotion;
- persistent Pi-native cmux child sessions in isolated Git worktrees;
- an orchestration policy for lightweight fan-out versus implementing workers;
- a loopback Markdown and diff review surface that can append to the Pi draft;
- a draggable, always-on-top macOS pet driven by real Pi and subagent events.

Third-party Pi packages provide MCP, background subagents, context compression,
markdown preview, structured questions, Datadog access, and the powerline.
Trajectory captures local session telemetry.

## Install or restore

Clone the private repository, install its pinned JavaScript dependencies, run
the tests, and merge its portable configuration into Pi:

```bash
git clone git@github.com:ellataira/pi-workbench.git
cd pi-workbench
npm ci
npm test
npm run bootstrap -- --replace-existing
npm run install:pi-copy-picker
npm run install:daily-review
```

`bootstrap` links the checkout at
`~/.agents/extensions/agent-journal`. If a directory or different link already
exists there, `--replace-existing` first renames it to a timestamped backup. It
merges the repository's settings, profiles, and subagent limits with existing
Pi configuration; it does not erase extra local packages, provider/model
selection, or unrelated fields.

The macOS pet is built from the tracked Swift sources. Rebuild it only on a Mac
with the required Apple build tools:

```bash
npm run build:pet
```

The Git boundary is intentional. Source, tests, documentation, and sanitized
configuration are tracked. OAuth credentials, MCP state, raw Pi sessions,
Obsidian journal content, SQLite/runtime state, caches, dependencies, and built
applications are not tracked. Journal retention and Drive rehydration continue
to operate independently of this repository. GitHub Actions runs the extension
suite and rendered-guide test for every push and pull request.

## Start and navigate

Open cmux, create or select a terminal workspace, then run:

```bash
pi
```

cmux terminals set `CMUX_WORKSPACE_ID`, which is required for the persistent
child bridge. Use cmux's workspace sidebar or tabs to move between the parent
and child terminals.

Inside Pi:

- `/workspace <path>` switches the active repository while preserving the
  conversation. Pi rebuilds cwd-bound tools and replaces repository-local
  `AGENTS.md`, `CLAUDE.md`, skills, settings, trust, and project profile with
  those from the target repository. Shared skills, MCP connections, model
  state, and global memory remain available.
- `/workspace` opens a recent-repository chooser. `/workspace show` reports the
  active and previous repository; `/workspace back` returns to the prior repository. Workspace switching
  requires a persisted Pi session and a target inside a Git repository.
- `/agents` is the single supervisor entry point. It can fan out a lightweight
  task, create an implementing agent, or manage an existing child.
- `/agents persistent <task>` creates an isolated Git worktree and starts a persistent
  Pi-native child in a new, unfocused cmux workspace. Enter it whenever you
  want to chat with or steer the child.
- `/agents list` reports only owned workspaces and whether each child is active, orphaned, dirty, or
  merged. `/agents recover`, `/agents patch`, and `/agents cleanup`
  recover the session, produce a bounded reviewable patch, or remove only a
  clean merged child.
- Ask the parent to focus, message, or interrupt a named child; it uses the
  `cmux_session` tool, which rejects unknown workspaces.
- Use `/tree` inside a child and `/resume` or its session ID to return later.
- `/subagents-fleet` shows background subagent work.
- Use background scouts/reviewers for lightweight fan-out. Use workers or
  `/agents persistent` for implementing work; every implementing child gets one worktree
  and one writer.

## Action inbox and project profiles

- `/inbox` opens a readable selector for persistent approval, blocked, completed, and failed states
  from Pi sessions, daily distillation, subagents, MCP, and automations.
  `/inbox acknowledge <id|all>` clears items explicitly; `/inbox clear
  completed` and `/inbox clear stale` remove non-actionable history.
- Paddington reads the same inbox and prioritizes failed and blocked work.
  Clicking acknowledges the item and focuses its cmux workspace when routing
  metadata is available.
- Inbox records contain only fixed state, source, reason code, timestamps, and
  routing IDs. Prompts, task names, messages, tool arguments, and transcripts
  are not accepted.
- `/profile` opens a vendor-neutral project-profile chooser. `/profile <name>` applies
  one; `/profile clear` restores the session's prior model, thinking, and tool
  state; `/profile reload` reloads configuration.
- `/profile writing` selects the documentation and writing mode: medium
  thinking, one writer, and verification for source accuracy, links and
  commands, and consistency across related docs.
- Global profiles live at `~/.pi/agent/project-profiles.json`. A repository can
  override them and optionally select a default with
  `<repo>/.pi/project-profiles.json`. Model selection is optional; when used it
  requires an explicit provider and model pair.

## Journal and memory

- Pi runs bounded proactive recall only for explicit continuity and
  context-finding turns, such as asking what was decided previously. Ordinary
  implementation, writing, and review prompts do not query memory. Recall is
  project-scoped when Pi is inside a Git checkout, capped at three items and
  roughly 400 tokens, and injected quietly with provenance. One to four
  normalized topic tags are stored in human-readable YAML frontmatter and in
  SQLite topic tables; topic-only matches participate in FTS recall and exact
  topic matches are ranked first.
- `journal_checkpoint` accepts only an explicit `compressed-summary-v1`
  representation. Pi saves the first durable change once per session. Later
  durable work stays pending without a timer and is saved before context
  compression or through an explicit checkpoint. Short read-only MCP lookups,
  adapter status/connection/authentication actions, review-only turns, and
  clarification requests never flush pending work; remote MCP writes remain
  substantive. `/checkpoint` saves immediately; the model does
  not independently classify completed work as a checkpoint milestone. A
  rejected automatic checkpoint is retried once
  with stricter paraphrasing before `/checkpoint` becomes the manual retry path.
- The checkpoint may contain goals, outcomes, decisions, next steps, artifact
  references, tags, and aggregate usage only. Artifact prose is rejected;
  child-task labels are stored generically rather than copying delegated text.
- Raw prompts, assistant responses, tool arguments, transcripts, role-labelled
  dialogue, and summary fields copied directly from conversation text are
  rejected and are never added to Obsidian or SQLite. Copy detection compares
  the checkpoint only with visible user and assistant prose; private reasoning
  and the checkpoint tool's own arguments are excluded from that comparison so
  a semantic checkpoint cannot reject itself. Neither excluded source is stored.
- The checkpoint backstop asks the active model for an explicit compressed
  representation; it never derives or persists a summary from a shutdown,
  compaction summary, transcript, or session-file scan. Before compaction, Pi
  pauses once when durable work is pending, asks the active model for that
  semantic checkpoint, and resumes compaction afterward. Hard context overflow
  fails open after that single attempt so recovery cannot loop or strand the
  session. The former reconciler remains paused.
- `/diary` is a compatibility route; the old diary is frozen.
- A launchd reminder runs at 09:00 America/New_York, adds the fixed
  `daily-distillation` action to Paddington's inbox, and displays a macOS
  notification. The next interactive Pi turn queues one review of the next
  unreviewed day, normally the previous day. Missed days catch up one per day.
  Pi asks which candidates
  to promote, edit, skip, or snooze. Nothing is promoted without the user's
  explicit choice. Use `/distill [YYYY-MM-DD]` to start manually.
- `/memory` is the single guided entry point for status, checkpointing, daily
  review, retention cleanup, integrity verification, and receipt audits.
- A weekly retention audit reports native Pi sessions older than 30 days.
  Use `/memory audit` for a read-only report or `/memory cleanup` to
  process stable batches of at most five. Each create/reuse first requires an
  exclusive 15-minute local upload claim, then reads the specific Drive object
  back, verifies its SHA-256 content, persists a receipt, and deletes only the
  corresponding native JSONL. Missing or mismatched summaries and active
  claims fail closed and remain local.
- Verified compressed session Markdown remains local for 90 days, then moves
  to Drive-only cold storage. Search metadata, topics, Drive file and folder
  IDs, exact archive filenames, hashes, and receipts remain local indefinitely
  and can rebuild SQLite after index loss. Retrieval uses the file ID directly;
  the folder and filename are recovery locators.
- A weekly integrity monitor checks at most five least-recently-verified Drive
  archives. Missing objects and content mismatches are recorded but never
  accepted as memory. `/memory receipts` separately reports corrupt,
  schema-invalid, and duplicate receipts without repairing or deleting them.
- Invoke the shared `agent-memory` skill for bounded recall or `/learn`-style
  promotion.
- Run `node ~/.agents/extensions/agent-journal/bin/memory-canary.mjs` for an
  isolated checkpoint plus retention/eviction/rehydration proof. Run
  `node ~/.agents/extensions/agent-journal/bin/migrate-memory.mjs --apply`
  after importing legacy journal Markdown; it sanitizes in place, creates no
  raw-content backup, replaces task-shaped legacy summaries with neutral
  metadata, merges duplicate identities, and rebuilds SQLite.
- Invoke the shared `code-review` skill for a focused read-only review of the
  requested diff or current working tree.
- Invoke the shared `review-changes` skill for a heavyweight read-only review
  of any working tree, commit, branch, range, pull request, or file set. It
  adapts to repository-native instructions and tracks complete file coverage.
- Session archive:
  `~/Documents/Obsidian Vault/ella.taira/agent-journal/sessions`
- Promoted memory:
  `~/Documents/Obsidian Vault/ella.taira/agent-journal/memory`
- Daily link rollups:
  `~/Documents/Obsidian Vault/ella.taira/agent-journal/daily`

Pi's own local session store is the sole history-bearing boundary. It remains
enabled for 30 days because Pi-native `/tree` and `/resume` require it. This
package may read
native session metadata and aggregate usage, but it never copies conversation
content into the journal, memory store, child registry, or search index.
Journal Markdown, maintenance state, SQLite, WAL, and SHM files are owner-only.
Drive retention follows the same boundary: only compressed journal Markdown is
uploaded. Raw session JSONL, prompts, responses, and tool calls never leave the
native store. The verification receipt and bounded search metadata are retained
permanently; the local compressed note follows the 90-day hot-storage window.

If a compressed note is later absent locally, its searchable SQLite metadata
remains cold-tier aware. A relevant proactive-recall hit tells Pi to retrieve
the registered Drive file, verify its recorded SHA-256, atomically restore the
Markdown, and resume local retrieval. Irrelevant Drive archives are not fetched,
and failed authentication or verification never creates a local note.

When bounded local recall returns no result for an explicit context-finding
query, Pi may search `google-workspace` for at most three arbitrary
Drive candidates. It fetches only the most relevant file needed, treats Drive
content as untrusted data, cites Drive provenance, and never promotes arbitrary
Drive content into memory automatically.

## Floating macOS pet

Pi automatically opens `dist/PiPet.app`. Paddington is a transparent,
borderless native macOS panel that remains above normal windows, joins every
Space, and is allowed alongside full-screen apps.

- Drag Paddington anywhere; the position persists.
- While idle, Paddington uses the v2 look-direction rows to follow the pointer.
- Dragging right or left uses the matching directional movement row.
- Lifecycle animations follow Codex playback: the state row plays three times,
  then settles into the slower idle loop. macOS Reduce Motion shows one frame.
- Click Paddington to focus the originating cmux workspace. A completed state
  is acknowledged by the same click.
- Right-click to hide or quit the companion.
- `/pet` reports status. `/pet on` relaunches/enables it and `/pet off` stops
  publishing the current Pi session.
- Allow notifications when macOS asks if you want a completion alert.

Pi writes only fixed lifecycle metadata under
`~/.agents/runtime/pi-pet/sessions`: protocol version, client, session ID,
process ID, phase, aggregate tool/child counts, cmux workspace/surface IDs, and
timestamp. Prompts, responses, tool arguments, task names, and transcripts are
not accepted by the protocol. Clean shutdown removes the session record; the
companion prunes records left by crashed processes. Concurrent lifecycle events
use distinct atomic temporary files. `/reload` refreshes the runtime
implementation, and subagent emissions are awaited so pet I/O failures cannot
escape as unhandled promise rejections or terminate Pi.

The companion aggregates all live Pi parents and children. Attention priority
is failure, waiting for input, completion, review, active work, then idle.
Click-to-focus does not grant the desktop app direct cmux socket access. The
companion writes a fixed-field session focus request, and only the matching Pi
process already authorized inside cmux may execute it.
Build it after source or Paddington changes with:

```bash
cd ~/.agents/extensions/agent-journal
npm run build:pet
```

## UI, MCP, and telemetry

- `/mcp` is the only user-facing connector and authentication entry point. It
  shows Pi's self-contained MCP servers; external Claude, Codex, and
  Cursor configs are not imported because same-name entries merge field by
  field. Servers are lazy and exposed through one proxy tool by default.
- `google-workspace` is a lazy, pinned HTTP bridge for Drive, Docs,
  Sheets, and Slides retrieval. Retrieved file content is untrusted data;
  creating, overwriting, deleting, or sharing always requires confirmation.
- `/datadog setup` configures the Datadog-native MCP plugin.
- `/ctx-stats` shows context-mode savings.
- `/preview <path>` previews Markdown.
- `/review` is the single review entry point. With no argument it opens a
  contextual chooser for the last Pi turn, a complete file, an unstaged or
  staged Git diff, or a comparison with a requested base. The chooser names
  the files in the last-turn diff and recommends recently changed files for
  complete-file review. `/review <path>` bypasses the chooser and opens that
  file directly. Markdown opens as a rendered GFM preview; select rendered text
  and choose the nearby **Comment** action to
  open a textbox beside that exact passage. Completing it creates an inline
  `[an: ...]` chip that can be edited or removed in place. **Edit source**
  exposes the raw Markdown editor, while the collapsible tray remains the batch
  overview. Unfinished comments cannot be saved or submitted. Text files are
  read-only. Rendered annotation chips use compact 12px pink styling with an
  explicitly left-aligned comment element, including when text wraps. Each new
  selection remains armed through transient browser selection collapse and
  snapshots its action before focus changes, so adding later comments remains
  reliable after the preview already contains annotations. **Update & add
  another** saves the active comment and arms the next rendered selection,
  opening its editor automatically without depending on a second bubble click.
  Existing annotation chips are non-selectable and removed from both the
  selected text and its mapping context, so a later selection may cross an
  earlier comment without producing a source-mapping error. Multi-line
  selections also use a bounded word-sequence fallback when rendered block or
  table spacing differs from the Markdown source. Inline-code spans are
  projected literally, so wrapped identifiers containing underscores map back
  without treating their characters as emphasis markers.
  `npm run test:e2e-review` validates both the ordinary second-bubble workflow
  and **Update & add another**, plus selections spanning rendered lines and
  wrapped inline-code identifiers, using native mouse selections in isolated
  headless Chrome.
- The **Changes from last Pi turn** choice opens one combined diff containing
  only changes made during
  the immediately preceding Pi turn. It compares the actual pre-turn worktree
  with the settled worktree, so earlier dirty changes are excluded unless the
  turn modifies them. Git-visible shell, formatter, commit, and subagent
  changes are included; bounded untracked files and directly touched non-Git
  files are supported.
- After a changed turn, Pi shows **Review ready — run /review** and a compact
  list of the files included in that view. A no-change turn clears the previous
  diff instead of silently retaining stale work.
- The Git choices open generated unstaged, staged, or base-comparison diffs
  with persistent line comments. Direct forms use `/review git`,
  `/review git staged`, or `/review git <base>`.
  Double-clicking a supported file in cmux routes through the same surface when
  a live Pi session is available.
- “Add comments to Pi” appends the complete staged Markdown review as one
  bounded draft addition without submitting it. Every comment includes its
  current Markdown source line so Pi can locate it without relying on the
  context string alone. The window then waits for the disk version to change
  and reloads the updated file while remaining open for verification. Submitted
  transient annotations are cleared and the
  approximate scroll position is preserved. Clean read-only views also follow
  disk updates. Unsubmitted comments or source edits are never discarded
  automatically; **Reload from disk** appears instead. Annotations change the
  file only when **Save** is chosen. `/reload` loads fresh review code; a page
  opened before that command must be replaced once with `/review` or
  `/review <path>`.
  Ordinary selections remain transient. Diff
  persistence stores only the explicit comment, file/line/side anchor, and a
  context hash; it never stores selected diff text, prompts, or transcripts.
- Markdown saves are atomic. A stale browser view never overwrites a newer
  on-disk file; the UI displays the error and offers an explicit, destructive
  **Reload from disk** action. `Cmd-S`/`Ctrl-S` saves, `Cmd-Enter`/`Ctrl-Enter`
  updates the active inline comment, and `Escape` closes it. Selection actions
  and comment editors are viewport-bounded and keep the annotated passage at
  its existing scroll position while the preview refreshes.
- `/powerline` configures the footer. Its default preset shows model, context,
  tokens, and cost; fixed-editor and mouse capture are disabled for cmux.
- `/pet [on|off|status]` controls the floating lifecycle pet.
- `trajectory status` shows current/recent session metrics.

## Provider boundary

No orchestration or memory policy names a required model provider. Child
commands inherit normal Pi configuration, and the AI Gateway model catalog is
an adapter layer. Open-weight providers can be added later without changing the
journal, memory, cmux, or subagent contracts.

## Validation

Run:

```bash
cd ~/.agents/extensions/agent-journal
npm test
npm run build:pet
pi list
trajectory doctor
```

The `Agent journal reconciler` automation is paused. It must not be enabled
until it has a genuine compressed-summary producer; raw session backfill is not
supported.
