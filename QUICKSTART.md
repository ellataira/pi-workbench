# Pi + cmux quickstart

This is the practical guide to Ella's local Pi cockpit. It covers native Pi
features plus the installed cmux supervisor, subagents, MCP servers, context
management, memory, pet, telemetry, previews, and shared skills.

The setup is model-provider neutral. Datadog integrations are optional adapters,
not dependencies of the orchestration or memory design.

## Install from the private repository

```bash
git clone git@github.com:ellataira/pi-workbench.git
cd pi-workbench
npm ci
npm test
npm run bootstrap -- --replace-existing
npm run install:pi-copy-picker
npm run install:daily-review
```

The checkout becomes the canonical extension source through the
`~/.agents/extensions/agent-journal` link. Bootstrap backs up an existing
extension before replacing it and merges portable configuration without
removing machine-specific packages or model settings. Restart Pi or run
`/reload` afterward.

Git stores the implementation and sanitized configuration only. It never
stores OAuth data, MCP state, prompts, transcripts, Pi sessions, Obsidian
journal entries, memory databases, runtime state, caches, dependencies, or
compiled applications. `npm run build:pet` is optional and requires the Apple
build tools.

## New command quick reference

Run `/reload` once in Pi sessions that were already open when these extensions
changed.

| Entry point | Interactive behavior | Useful direct forms |
|---|---|---|
| `/review` | Choose the last-turn diff, a recently changed file, or a Git diff | `/review <path>`, `/review git`, `/review git staged`, `/review git <base>` |
| `/rewind` | Choose an earlier user message, restore it to the editor, and preserve the abandoned branch | `/tree` for the complete native tree |
| `/copy` | Choose a fenced or inline CLI command from the latest response, or the entire response | `/copy-command` is the vendor-neutral fallback |
| `/agents` | Choose lightweight fan-out, persistent implementation, or an existing agent | `/agents persistent <task>`, `/agents background <task>`, `/agents list`, `/agents recover <id>` |
| `/memory` | Inspect status or choose checkpoint, daily review, cleanup, or integrity work | `/checkpoint`, `/distill`, `/memory audit`, `/memory cleanup`, `/memory integrity` |
| `/inbox` | Select an action item, focus its cmux workspace, or acknowledge it | `/inbox list`, `/inbox clear completed`, `/inbox clear stale` |
| `/workspace` | Choose a recent repository or enter another path | `/workspace <path>`, `/workspace back`, `/workspace show` |
| `/profile` | Choose a vendor-neutral working profile with visible behavior | `/profile writing`, `/profile implementation`, `/profile clear`, `/profile reload` |
| `/mcp` | Inspect, authenticate, reconnect, and discover connector tools | `/mcp reconnect <server>` |
| `/pet` | Show the companion’s launch, session, cmux, lifecycle, and child state | `/pet on`, `/pet off`, `/pet status` |

The removed implementation-detail commands—`/child`, `/cmux-children`,
`/worktrees`, `/worktree`, `/review-recent`, `/review-last`, `/review-diff`,
and the `/retention-*` family—are now handled by the guided entry points above.

## First 10 minutes

### 1. Start a parent session

Open a cmux terminal in a Git repository and run:

```bash
pi --name "short task name"
```

Running inside cmux matters: `/agents persistent` needs the `CMUX_WORKSPACE_ID` that cmux
sets. Plain `pi` works outside cmux, but persistent child tabs do not.

Useful first commands:

```text
/refresh-models
/model
/session
```

- `/refresh-models` refreshes the provider-neutral model catalog. Press `s` in
  its UI to save changes.
- `/model` chooses a model. `Ctrl+L` opens the same picker.
- `/session` shows the active session's file, ID, name, and usage.

Then describe the outcome you want in normal language. Pi can inspect files,
edit code, run commands, use MCP, and choose a shared skill without requiring a
slash command.

Pi loads `AGENTS.md` and `CLAUDE.md` project instructions by default. It also
discovers shared and project-local skills, so the same vendor-neutral
instructions can follow you across Pi, Codex, and Claude-compatible setups.

#### Switch repositories without restarting

Use a persisted Pi session to move the active conversation into another Git
repository:

```text
/workspace
/workspace ~/Desktop/another-repo
/workspace back
```

The conversation and its active branch are preserved. Shared skills from
`~/.agents/skills`, extensions, MCP connections, model state, and global memory
remain available. Pi rebuilds cwd-bound tools for the target repository and
loads that target repository's `AGENTS.md`, `CLAUDE.md`, project-local skills,
settings, trust decision, project profile, and repository-scoped proactive
memory. Source-repository instructions do not remain active after the switch.

Internally, Pi creates a new native session file under the target repository's
session directory because tools and resource discovery are cwd-bound. The UI
handoff remains continuous, and `/workspace back` uses bounded local metadata
to return. The custom journal still stores only compressed checkpoints; no
additional transcript or prompt copy is added to Obsidian or SQLite.

### 2. Choose the right kind of work

| Need | Use |
|---|---|
| One focused task | Ask the current Pi session |
| A quick parallel research or review pass | Ask Pi to use background subagents, or use `/parallel` |
| An implementing child you want to enter and chat with | `/agents` or `/agents persistent <task>` |
| Several distinct review perspectives | `/skill:persona-panel` |
| A durable compressed record of the session | `/checkpoint` |
| Recall an earlier decision | Ask naturally or use `/skill:agent-memory` |

The key boundary is simple:

- `/agents` guides both execution shapes. Background subagents are for
  lightweight fan-out; implementing children use one isolated Git worktree and
  one writer.

### 3. Finish cleanly

Before leaving important work:

```text
/checkpoint
```

This asks the agent to submit a compact session summary to the journal. It does
not save prompts, responses, tool arguments, or a transcript.

Pi's native session remains available for:

```text
/tree
/resume
```

Native Pi sessions are the sole conversation-history store. The custom journal
never copies their conversation content.

## What is installed

| Package | Role |
|---|---|
| Local `refresh-models` | Refreshes AI Gateway and local Ollama model catalogs |
| Local `agent-journal` | Compressed journal, memory, cmux supervisor, review surface, and lifecycle pet |
| `pi-mcp-adapter@2.12.1` | Lazy MCP discovery, auth, prompts, and tool calls |
| `pi-subagents@0.35.1` | Background agents, chains, parallel runs, profiles, and cost |
| `context-mode@1.0.169` | Working-context compression, indexing, and retrieval |
| `pi-markdown-preview@0.10.1` | Terminal, browser, and PDF previews |
| `pi-powerline-footer@0.7.0` | Model, context, token, cost, and shell status |
| `rpiv-ask-user-question@2.1.0` | Structured interactive questions |
| `@datadog/pi-plugin@0.1.4` | Optional Datadog MCP adapter |

Trajectory is a separate local telemetry CLI rather than a Pi package.

Fable is not in the active package list. The installed pet is a native,
always-on-top Paddington companion controlled by `/pet [on|off|status]`.

## Everyday Pi controls

### Files, shell, and input

| Action | How |
|---|---|
| Mention a file | Type `@` and fuzzy-search |
| Complete a path | `Tab` |
| Multiline prompt | `Shift+Enter` |
| Open an external editor | `Ctrl+G` |
| Paste an image | Paste or drag it into the terminal |
| Run shell and show output to the model | `!command` |
| Run shell without sending output to the model | `!!command` |
| Copy the last response | `Ctrl+X` |

Native model-callable tools:

| Tool | Purpose |
|---|---|
| `read` | Read files |
| `bash` | Run shell commands |
| `edit` | Make targeted text replacements |
| `write` | Create or replace a file |
| `grep` | Search file contents; disabled by default |
| `find` | Find paths; disabled by default |
| `ls` | List directories; disabled by default |

The default tool set is `read,bash,edit,write`. Start Pi with a custom set when
you need tighter or broader access:

```bash
pi --tools read,grep,find,ls
pi --exclude-tools write,edit
pi --no-tools
```

### Steering work in progress

| Input while Pi is busy | Result |
|---|---|
| `Enter` | Queue a steering message after the current tool calls |
| `Alt+Enter` | Queue a follow-up after all current work |
| `Escape` | Abort and restore queued text |
| `Alt+Up` | Bring a queued message back into the editor |

### Models and thinking

| Action | Command/key |
|---|---|
| Choose a model | `/model` or `Ctrl+L` |
| Cycle reasoning level | `Shift+Tab` |
| Cycle scoped models | `Ctrl+P` / `Shift+Ctrl+P` |
| Configure scoped models | `/scoped-models` |
| Refresh available models | `/refresh-models` |
| List models from the shell | `pi --list-models` |

The orchestration, journal, and skills do not require a particular provider.
Open-weight providers can be added later without redesigning those layers.

## Sessions, branching, and context

### Native session commands

| Command | Purpose |
|---|---|
| `/new` | Start a new session |
| `/name <name>` | Name the current session |
| `/session` | Show current session information |
| `/resume` | Open the session picker |
| `/tree` | Navigate or branch within the current session |
| `/fork` | Create a new session file from an earlier user message |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Summarize older context to reclaim space |
| `/copy` | Pick a CLI command substring or the complete latest response |
| `/rewind` | Restore an earlier user message for editing without changing files |
| `/export [file]` | Export a session as HTML |
| `/import <file>` | Import a conversation |
| `/share` | Upload the session as a private GitHub gist and create a shareable page |

Pi stores native sessions under `~/.pi/agent/sessions/`.

Use `/tree` when the alternatives belong to one line of thought. Use `/fork`
when the new direction should become an independently resumable session.

`/export`, `/import`, and `/share` operate on conversation-bearing native
sessions. They are outside the compressed-journal contract and can create or
transmit another transcript copy. Avoid them unless that is explicitly what you
intend.

The `/resume` picker supports:

- `Ctrl+P`: current directory versus all paths
- `Ctrl+S`: change sort order
- `Ctrl+N`: named sessions only
- `Ctrl+R`: rename
- `Ctrl+D`: move a session to trash

### Context-mode

Context-mode automatically reduces large tool results and lets the agent index,
search, and retrieve code, documents, URLs, and command output efficiently.

Useful commands:

```text
/ctx-stats
/ctx-doctor
```

Available tools include:

- `ctx_batch_execute`, `ctx_execute`, and `ctx_execute_file`
- `ctx_index`, `ctx_search`, and `ctx_fetch_and_index`
- `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, and `ctx_purge`

`ctx_purge` deletes the context-mode index, so use it deliberately.

Privacy boundary: context-mode is for code, docs, URLs, and tool output. Do not
index conversations, prompts, or transcripts with `ctx_index`. Its working
index is separate from the durable compressed journal.

## cmux supervisor and implementing children

### Spawn a child you can enter

From a parent Pi session inside a Git repository:

```text
/agents persistent Implement the parser fix and its tests
```

The supervisor:

1. creates an isolated Git worktree;
2. starts a persistent Pi-native child in a new cmux workspace;
3. records only the owned workspace and session metadata; and
4. leaves the new workspace unfocused so the parent can keep working.

Use cmux's sidebar or tabs to enter the child. It is a normal Pi session: chat
with it, steer it, use `/tree`, and resume it later.

```text
/agents list
```

This lists only workspaces created by this supervisor.

The parent can also use the `cmux_session` tool:

| Action | Purpose |
|---|---|
| `spawn` | Create an owned child |
| `list` | List owned children |
| `focus` | Focus an owned child workspace |
| `send` | Send input to an owned child |
| `interrupt` | Interrupt an owned child |
| `status` | Inspect owned worktree lifecycle state |
| `recover` | Reopen an orphaned child session in its existing worktree |
| `prepare-patch` | Write a bounded reviewable patch without applying it |
| `cleanup` | Remove only a clean, merged, inactive child |

The tool rejects unknown cmux workspaces. `/agents persistent` also requires a Git
repository because implementing children must have isolated worktrees.

Manage the owned worktrees directly:

```text
/agents list
/agents recover <session-id>
/agents patch <session-id>
/agents cleanup <session-id>
```

Cleanup fails if the cmux workspace is active, the worktree is dirty, or the
branch is not merged into the repository's current `HEAD`. It also refuses to
run outside cmux, where workspace liveness cannot be verified. Patch
preparation refuses untracked files and caps output at 10 MiB. It never applies
the patch; review the returned file first.

### Background subagents

The installed `subagent` tool runs bounded background agents. Your configuration
defaults to asynchronous execution, permits four concurrent agents, allows up
to twelve spawns per parent session, and limits nesting to one level.

Ask naturally, or use:

```text
/run <agent> <task>
/parallel scout "inspect parser" -> reviewer "inspect tests"
/chain scout "find cause" -> reviewer "pressure-test the proposal"
/run-chain <chain-name> -- <task>
```

Inspect and manage them with:

```text
/subagents-fleet
/subagent-cost
/subagents-stop
/subagents-doctor
/subagents-profiles
/subagents-models
```

Other advanced commands include `/subagents-watchdog`,
`/subagents-load-profile`, `/subagents-refresh-provider-models`,
`/subagents-generate-profiles`, `/subagents-check-profile`,
`/prompt-workflow`, and `/chain-prompts`.

Do not send two implementing agents into the same checkout. Use `/agents persistent` for an
implementation you want to supervise interactively.

## Durable journal and memory

### Create a checkpoint

Pi automatically queues one hidden checkpoint turn for the first durable change
once per session. Later durable work stays pending without a timer and is saved
before context compression or through an explicit checkpoint. Greetings,
slash commands, failed/aborted runs, short trivial answers, review-only turns,
clarification requests, short read-only MCP lookups, and adapter
status/connection/authentication actions never flush pending work. Remote MCP
writes and other substantive tool work do. `/checkpoint` saves
immediately; the model does not independently
classify completed work as a checkpoint milestone.

Before Pi compacts context, pending durable work gets one checkpoint attempt
first. Pi then resumes compaction. If the checkpoint turn itself hits a hard
context overflow, compaction fails open after that one attempt so the session
can recover. The follow-up cannot recursively trigger itself. If the first
automatic checkpoint is rejected by the no-transcript guard, Pi retries once
with stricter, category-level paraphrasing before asking you to use
`/checkpoint`.

Use the manual command to retry or force a milestone checkpoint:

```text
/checkpoint
```

The agent calls `journal_checkpoint` with a `compressed-summary-v1` record.
Allowed content includes:

- goals and outcomes;
- decisions and next steps;
- artifact paths, URLs, stable artifact IDs, and tags; and
- aggregate token or usage information.

The contract rejects:

- raw prompts or assistant responses;
- transcripts or role-labelled dialogue; and
- tool arguments or copied conversation text.

Prose is not accepted in the artifact list, and child sessions use generic
stored link labels rather than copying delegated task text. Promoted memories
carry the same representation marker and reject transcript-shaped dialogue.
Journal Markdown and SQLite state are owner-only on disk.

The copy detector checks visible user and assistant prose. It ignores private
reasoning and the `journal_checkpoint` call's own arguments to avoid rejecting
the checkpoint against itself; those sources are still never persisted.

Journal paths:

```text
~/Documents/Obsidian Vault/ella.taira/agent-journal/sessions
~/Documents/Obsidian Vault/ella.taira/agent-journal/memory
~/Documents/Obsidian Vault/ella.taira/agent-journal/daily
```

The old diary is frozen. `/skill:diary` is only a compatibility route into the
same compressed journal.

### Recall and promote memory

Pi quietly queries SQLite only when a request asks for prior context,
continuity, an earlier decision, or a previous artifact. Ordinary
implementation, writing, and review turns skip memory entirely. Inside a Git
checkout recall is scoped to that repository; outside a checkout it
automatically considers promoted global memories only. Recall is capped at
three results and approximately 400 tokens, retains provenance, and fails open
if the index is unavailable.

Use normal language:

```text
What did we decide about the sender shutdown design?
Find related sessions about metric lookback.
Promote this lesson into project memory.
```

Or invoke:

```text
/skill:agent-memory
```

Recall is bounded and provenance-linked. Stable lessons can be promoted into
small global or project memories. Full transcripts are neither retrieved nor
promoted.

Topic tags are retrieval data, not decoration. Pi merges one to four stable
lowercase-kebab-case topics from later checkpoints into the session note's YAML
frontmatter, mirrors them into SQLite topic tables, and includes them in FTS5.
An exact topic match is ranked ahead of a prose-only match. YAML remains the
human-readable Obsidian representation; proactive queries use SQLite rather
than reparsing every Markdown file.

Rebuild topic rows and FTS content from the durable Markdown files with:

```bash
~/.agents/skills/agent-memory/scripts/agent-memory reindex
```

After importing legacy notes, enforce the compressed contract and rebuild the
entire disk index with:

```bash
node ~/.agents/extensions/agent-journal/bin/migrate-memory.mjs --apply
```

The migration rewrites notes in place, creates no raw-content backup, removes
prompt-shaped labels and task-shaped legacy summary text, merges duplicate
identities, and preserves compliant compressed checkpoint sections.

### Daily promotion review

At 09:00 America/New_York, launchd adds a daily-review item to Paddington and
shows a macOS notification. The next interactive Pi turn starts one review of
the next unreviewed calendar day, normally the previous day. Missed days catch
up one per day. Pi retrieves only compressed
session candidates, shows their scope, topics, and provenance, then asks which
ones to promote, edit, skip, or snooze. Promotion always requires an explicit
user choice.

Start or retry a review manually:

```text
/distill
/distill 2026-07-26
```

Completing the review records only the reviewed date, completion timestamp, and
promoted memory IDs under `~/.agents/state/agent-journal/maintenance.json`.

Reinstall the exact-time reminder after moving this package:

```bash
~/.agents/extensions/agent-journal/scripts/install-daily-review-reminder.sh
```

### Local retention

Native Pi session JSONL remains locally resumable for 30 days. Once per week,
Pi audits older files and records the candidate count. The audit is read-only
and fail-closed.

Run the same read-only audit manually:

```text
/memory audit
```

Run the user-approved backup and cleanup workflow:

```text
/memory cleanup
```

For each eligible session, Pi locates the matching
`compressed-summary-v1` Markdown note by its exact `source_path`. Candidates
are processed in stable batches of at most five. Before searching or creating
a Drive object, Pi must acquire an exclusive 15-minute local upload claim;
concurrent runs skip an active claim. It then creates or reuses a uniquely
named Drive text file containing only that compressed note, reads the same
Drive object back, and asks the local verifier to compare its SHA-256 content.
Only the matching claim plus an exact content match and concrete Drive file ID
produce a permanent receipt under
`~/.agents/state/agent-journal/retention-receipts/` and deletes the native
JSONL. The receipt and bounded search metadata remain indefinitely; compressed
Markdown follows the 90-day local window described below.

The job never uploads native JSONL. Missing summaries, Drive authentication
errors, mismatched content, files younger than 30 days, and partial runs all
remain local for a later retry. It does not empty Trash or delete Drive files.
The weekly audit reminds you to invoke `/memory cleanup`; Drive creation is
not performed without that explicit command.

Audit receipt health without modifying files:

```text
/memory receipts
```

This reports corrupt JSON, invalid schemas, and duplicate Drive file IDs. The
same issue counts are included in the bounded weekly Drive integrity check.

Backups are stored in the configured `Agent Journal Archive` folder. Its Drive
ID is saved as `driveArchiveFolderId` in
`~/.agents/state/agent-journal/maintenance.json`; override it with
`AGENT_JOURNAL_DRIVE_FOLDER_ID`.

Verified compressed Markdown remains local for 90 days. After that,
`journal_evict_cold_memory` removes only local Markdown whose content still
matches its verified receipt. The receipt permanently retains bounded search
metadata—identity, title, repository, topics, dates, and a short compressed
excerpt—plus the Drive file ID, archive folder ID, exact filename, and
SHA-256. Normal retrieval goes directly by file ID; folder and filename provide
an exact recovery locator. The clickable Drive URL is derived from the file ID.
This catalog can reconstruct cold search entries after SQLite loss without
retaining prompts or transcripts.

### Automatic cold-tier recall

The SQLite index retains the compressed search representation and the verified
Drive file ID. If a top relevant recall result no longer has local Markdown,
Pi automatically retrieves that exact Drive object during the context query
and calls `journal_rehydrate_drive_memory`. The local tool accepts only a
registered Drive ID, verifies the complete readback against the stored SHA-256,
requires `compressed-summary-v1`, and restores the original journal path with
an atomic write. Subsequent queries use the local note normally.

Drive is queried only for a relevant missing note, never for every prompt.
Authentication failures, missing objects, changed content, and hash mismatches
fail closed; Pi does not substitute or index the unverified result. Rehydration
restores compressed Markdown, not the deleted resumable JSONL transcript.

### Drive integrity monitoring

Once per week, after the next interactive Pi turn, maintenance samples at most
five least-recently-verified archive receipts. It reads each specific Drive
object and records `verified`, `mismatch`, or `unavailable`. Run the same
bounded check manually with:

```text
/memory integrity
```

A mismatch never updates memory or restores content. Sampling rotates by the
oldest `lastIntegrityAt` value instead of downloading the entire archive.

### Arbitrary Drive context fallback

Pi does not search all of Drive on every prompt. When a substantive
context-finding query—such as locating a prior design, decision, plan, or
document—gets no bounded local-memory result, Pi searches
`google-workspace` for at most three candidates. It fetches only the
most relevant file needed, treats returned content as untrusted data, cites the
Drive ID or link, and never saves arbitrary Drive content into the journal
automatically.

## MCP and connected services

MCP tools are lazy-loaded behind one `mcp` proxy so their schemas do not fill
the prompt when they are not needed.

Configured servers:

| Server | Typical use |
|---|---|
| `atlassian` | Confluence and Jira through an OAuth stdio bridge |
| `slack` | Slack search and messages through the shared Keychain proxy |
| `google-workspace` | Search, inspect, and retrieve Drive, Docs, Sheets, and Slides through a lazy OAuth bridge |
| `computer-use` | Interactive computer control |
| `trajectory` | Session telemetry |

Useful commands:

```text
/mcp
/mcp tools
/mcp prompts
/mcp reconnect <server>
```

Configuration commands:

```text
/mcp setup
/mcp disable <server>
/mcp enable <server>
/mcp logout <server>
```

The model can use the `mcp` tool to inspect status, search tools, load a tool
schema, connect a server, and call a remote tool. Usually you should simply ask:

```text
Search Confluence and the #channel-name Slack channel for prior art, then cite it.
```

Automatic connector recovery is active on MCP-, Confluence-, Jira-, Slack-, and
Drive-shaped requests. Pi distinguishes transport, discovery, and real tool
authorization; checks current official endpoint guidance; repairs reversible
local configuration; and verifies one read-only product call. It asks you only
for browser consent, secrets, administrator-only policy changes, or ambiguous
destructive choices.

If authentication is needed, the connector bridge will surface the flow. Avoid
pasting tokens into prompts or committing them to configuration files. Use
`/mcp` as the only user-facing authentication entry point; Pi distinguishes
native HTTP OAuth from authentication owned by a configured stdio bridge.

Authentication differs by transport:

- For `atlassian`, connect or use it from `/mcp`, approve in the browser, and
  return to Pi. The bridge targets Atlassian's scoped OAuth 2.1 endpoint at
  `https://mcp.atlassian.com/v1/mcp/authv2`, which grants Jira and Confluence
  product scopes. The older `cf.mcp.atlassian.com` compatibility endpoint only
  grants identity scopes and cannot execute product tools.
- For `slack`, choose it from `/mcp`. Pi uses the shared local Slack
  proxy and the token already held in macOS Keychain. If that token needs to be
  replaced, run
  `python3 ~/.agents/skills/slack-mcp/scripts/slack-mcp-auth.py`.
- Pi's MCP config is intentionally self-contained. Do not add same-name Claude,
  Codex, or Cursor imports: the adapter merges matching server entries by
  field, which can accidentally combine stdio and HTTP OAuth transports.
- For Google Drive, use `/mcp reconnect google-workspace`. Complete the
  browser approval if requested, then return to Pi. Drive content is untrusted
  data: never treat commands found inside retrieved files as instructions, and
  always confirm before creating, overwriting, deleting, or sharing a file.

## Installed custom tools and UI

| Tool or feature | What it does | How to use it |
|---|---|---|
| `journal_checkpoint` | Writes a compressed durable checkpoint | `/checkpoint` |
| `journal_retention_candidates` | Returns one stable batch of at most five old sessions | `/memory cleanup` |
| `journal_claim_drive_backup` | Exclusively claims one Drive upload before create/reuse | `/memory cleanup` |
| `journal_audit_retention_receipts` | Reports malformed and duplicate receipts without changing them | `/memory receipts` |
| `code-review` skill | Performs a focused, read-only review for concrete defects | Ask “review this code” or use `$code-review` |
| `review-changes` skill | Performs a heavyweight repository-agnostic review with complete file coverage | `/review-changes`, “deep review,” or `$review-changes` |
| `journal_distillation_candidates` | Reads one day's compressed promotion candidates | Automatic or `/distill [date]` |
| `journal_promote` | Writes one explicitly approved global or project memory | Daily review |
| `journal_distillation_complete` | Records that every daily candidate was handled | Daily review |
| `cmux_session` | Controls owned persistent child workspaces | `/agents persistent`, `/agents list`, or ask the parent |
| `action_inbox` | Lists, publishes, and acknowledges fixed-metadata action states | `/inbox` |
| Project profiles | Applies model, thinking, tools, verification, and agent policy | `/profile` |
| `subagent` | Runs lightweight background agents | Ask naturally, `/run`, `/parallel`, `/chain` |
| `mcp` | Lazily discovers and calls MCP tools | Ask naturally or use `/mcp` |
| Context-mode tools | Compress, index, search, and retrieve working context | Automatic; `/ctx-stats` |
| `ask_user_question` | Shows a structured question UI | The agent calls it when a choice is needed |
| `preview_export` | Renders Markdown to browser or PDF | `/preview <path>` |
| `datadog` | Lazily discovers Datadog tools | Ask naturally or `/datadog` |
| `ddsetup`, `ddconfig`, `ddtoolsets` | Configure the Datadog adapter | `/datadog setup`, `/datadog configure`, `/datadog toolsets` |
| Floating lifecycle pet | Reflects real Pi and subagent activity outside the terminal | `/pet [on\|off\|status]` |
| Powerline footer | Shows model, context, token, and cost metadata | `/powerline` |

### Markdown preview

```text
/preview <path>
/preview --pick
/preview --browser
/preview --pdf
/preview-clear-cache
```

Aliases `/preview-browser` and `/preview-pdf` are also available.

### Editable Markdown and diff review

From Pi:

```text
/review
/review docs/plan.md
```

Running `/review` with no argument opens a contextual chooser:

- **Changes from last Pi turn** names the files included in the exact
  turn-scoped diff.
- **Open a complete file** recommends the first recently changed file, lists
  the other recent files, and then offers manual path entry. Pi stores only the
  edited file paths in the session so those suggestions survive `/reload`. When
  no Pi-edited list exists, it falls back to a bounded set of unstaged, staged,
  and untracked Git files while excluding agent/runtime and dependency folders
  such as `.agents`, `.codex`, `.pi`, `.git`, `.next`, and `node_modules`.
- **Git diff · Unstaged changes** opens the working-tree diff.
- **Git diff · Staged changes** opens the index diff.
- **Git diff · Compare with a base…** asks for a base such as `origin/main`.

`/review <path>` bypasses the quiz and opens that file directly. Direct Git
forms are `/review git`, `/review git staged`, and `/review git <base>`.

The review command opens a loopback-only browser pane in rendered-preview mode. Select
text in the rendered document and choose the nearby **Comment** action. A
focused textbox opens beside that exact passage. Enter the comment and choose
**Update**; it becomes an `[an: ...]` chip at that location. Click the chip to
edit or remove it again. **Edit source** exposes the raw Markdown editor when
you need to change document text directly; **Preview** returns to the rendered
document. An open review pane automatically reconnects to the same local review
session after `/reload`; the file-scoped recovery token does not grant access to
other local files.

The preview uses GitHub-flavored Markdown, including headings, lists and task
lists, tables, blockquotes, links, emphasis, fenced code, and document-relative
images. Raw HTML is displayed as text instead of executed, unsafe link
protocols are blocked, and relative images may only load from the document's
directory tree.

Every marker also appears in the collapsible **Review comments** tray for batch
review; its **Locate**, **Update**, and **Remove** controls remain available.
Choose **Add N comments to Pi** to append the complete review batch to the Pi
editor in one operation; Pi does not submit it automatically. Each batch item
includes its current Markdown source line alongside the comment and context.
Save and batch submission stay disabled until every opened inline textbox is
completed or removed. The selection action uses the final rendered selection rectangle, and
the comment editor is kept inside the viewport. Adding a marker preserves the
passage's screen position instead of expanding the tray or scrolling the page
away from it. Inline chips use compact 12px pink styling in both light and dark
mode, and wrapped comment text remains explicitly left-aligned. Existing
annotation chips are non-selectable and excluded from both later
selected text and mapping context, so a selection can cross an earlier comment
without copying its label or causing a Markdown source-mapping error. The
source mapper also falls back to a bounded word sequence for multi-line
selections when rendered block or table spacing differs from Markdown syntax.
Inline-code spans are projected literally, so wrapped identifiers containing
underscores are not mistaken for emphasis markers. The
floating action keeps a valid selection armed through transient browser
selection collapse and snapshots the passage before focus changes. It clears
only when a new selection starts, the preview refreshes, or the action is
submitted, so second and subsequent comments follow the same workflow as the
first. For deterministic batch review, choose **Update & add another** in the
comment editor. It saves the current comment, closes its editor, and arms the
next selection; selecting another rendered passage opens the next editor
automatically.

Run the native browser regression directly with:

```text
cd ~/.agents/extensions/agent-journal
npm run test:e2e-review
```

It launches isolated headless Chrome without adding a browser dependency,
performs six native rendered-text selections, verifies the ordinary second
floating-comment flow, **Update & add another**, and a selection spanning
rendered lines and wrapped inline-code identifiers, confirms all six
annotations exist in both the preview and staged Markdown source, then verifies
that a submitted review reloads when the disk version changes.

After **Add N comments to Pi**, the window enters **Waiting for file changes**.
It checks the disk version every two seconds while visible. When Pi or another
editor updates the file, the submitted review reloads automatically, clears its
transient annotations, preserves the approximate scroll position, and remains
open for verification. A clean preview also follows disk updates. Unsubmitted
comments and direct Markdown edits are never discarded automatically;
**Reload from disk** appears instead.

Review pages created by the current extension automatically reconnect after
`/reload` using a file-scoped recovery capability. A pane created before that
recovery support was installed must be reopened once with `/review` or
`/review <path>`. Normal file-version updates then refresh in place.

The annotated Markdown changes on disk only when **Save** is chosen. Saves use
an atomic replacement and report **Saved to disk** on success. If another
process changed the file, the stale viewer cannot overwrite it: the exact error
appears in the header and **Reload from disk** becomes available. That action
requires confirmation because it discards the viewer's unsaved changes.
`Cmd-S`/`Ctrl-S` saves, `Cmd-Enter`/`Ctrl-Enter` updates the active inline
comment, and `Escape` closes it. Non-Markdown text files are read-only.

After a Pi turn settles, choose **Changes from last Pi turn** under `/review`
to open one combined diff containing only changes made during that turn. The
baseline is the actual worktree at turn
start, so older dirty edits do not appear unless the turn modifies them.
Git-visible changes from shell commands, formatters, commits, and subagents are
included, along with bounded untracked files. Directly touched files provide a
bounded fallback outside Git repositories.

When the turn changed files, Pi shows **Review ready — run /review** below the
editor and includes a compact preview of the files covered by that view:

```text
/review
Changes from last Pi turn · 2 files: pkg/collector/runner.go, docs/design notes.md
```

Inside the chooser, **Open a complete file** offers those files directly. The
next turn replaces the widget. If it makes no changes, Pi clears the prior
diff so the last-turn choice never points to an older turn. Turn snapshots are bounded to
100 files, 1 MiB per file, and 5 MiB total; oversized or unsupported files are
reported and omitted. Ignored Git files are not scanned unless Pi directly
touches them.

The Git choices create a temporary review file from the unstaged diff, the
index, or a safe Git base such as `origin/main` using `<base>...HEAD`. Select
one line, or Shift-click a range, and a pink anchored editor opens beside the
selection. Saved comments render as clickable pink inline bubbles and can be
edited or removed before **Add N comments to Pi** submits the line-numbered
batch. The same surface is available directly through `/review git`.

For a selection outside a staged Markdown batch, **Add to Pi** appends the
selected text and optional comment to the active Pi editor. It does not submit
the draft. Selected text exists only in the browser request and Pi editor; it
is not written to the review registry or comment store. Diff comments persist
only the explicit comment,
file/line/side anchor, timestamp, and context hash—not the selected diff text,
prompt, or transcript.

### Rewind and command copying

`/rewind` lists recent user messages newest-first. Choosing one restores that
message to the editor so it can be changed and resubmitted. Pi preserves the
abandoned conversation branch and does not roll back filesystem changes.

`/copy` scans only the latest visible Pi response for fenced shell blocks and
command-shaped inline code, then opens a picker. Each command in a shell block
is offered separately; backslash-continued commands stay together. Choose one
command or **Entire response**; nothing is executed. The picker remains available as
`/copy-command` on compatible runtimes that reserve `/copy`. This Pi build uses
a guarded native delegation installed by:

```bash
cd ~/.agents/extensions/agent-journal
npm run install:pi-copy-picker
```

Re-run the installer after a Pi upgrade if `/copy` returns to copying the whole
response directly. It fails closed if the native handler shape changes.

cmux file-explorer double-clicks use this same surface through the configured
preferred-editor bridge. Routing prefers a live Pi session in the same cmux
workspace, then the session whose working directory most specifically contains
the file. If no live Pi review session exists, the bridge exits nonzero so cmux
can use its normal fallback. After changing the config or package, run
`/reload` in Pi and `cmux config reload` from a cmux terminal.

### Footer and floating pet

```text
/powerline
/powerline <preset>
/powerline placement above
/powerline mouse-scroll toggle
/pet status
/pet off
/pet on
```

The current footer is below the editor and shows the default model/context/token
and cost view. Fixed-editor mode and mouse capture are off to cooperate with
cmux. The duplicate last-prompt reminder is disabled, so submitted messages
remain in the chronological conversation stream instead of appearing again as
a `↳` row below the footer. Advanced footer commands include `/stash-history`, `/bash-mode`,
`/bash-reset`, and `/vibe`.

Paddington is a separate native macOS window rather than a terminal widget. It
is transparent, draggable, always on top, visible across Spaces, and allowed
beside full-screen apps. It starts with Pi, shows aggregate parent/subagent
state plus the persistent action inbox, and keeps completion, approval,
blocked, and failed states visible until clicked. Failed and blocked work has
priority. Clicking acknowledges the selected inbox item and focuses the
originating cmux workspace when routing metadata exists; right-clicking offers
hide and quit. Lifecycle snapshots use unique atomic temporary files, refresh
their runtime implementation on `/reload`, and await subagent writes so a pet
filesystem failure cannot terminate Pi.

Its animation behavior matches the Codex v2 pet contract: idle pointer tracking
uses all 16 look-direction cells, horizontal dragging uses the right/left
movement rows, lifecycle rows play three times before settling into the slowed
idle loop, completion uses the review row, and macOS Reduce Motion freezes on
the first meaningful frame.

Allow Pi Pet notifications when macOS asks if you want completion alerts.
Lifecycle files under `~/.agents/runtime/pi-pet/sessions` contain fixed metadata
only—never prompts, responses, task names, tool arguments, or transcripts.
The adjacent `inbox.json` follows the same contract and uses an interprocess
lock plus atomic owner-only writes so Pi and scheduled jobs cannot overwrite
one another.
Clean exits remove their record, and the companion prunes crashed-process
records.
Click-to-focus uses a fixed-field request handled by the matching Pi process;
the desktop companion is not given direct access to cmux's protected socket.

### Datadog adapter

```text
/datadog
/datadog setup [site]
/datadog configure
/datadog toolsets
```

This adapter is optional and vendor-specific. The rest of the cockpit continues
to work without it.

### Telemetry

From the shell:

```bash
trajectory status
trajectory doctor
```

Use the footer for live model, context, token, and cost visibility. Use
Trajectory for current and recent session-level telemetry.

### Project profiles

```text
/profile
/profile implementation
/profile quick-fix
/profile research
/profile writing
/profile sensitive
/profile clear
/profile reload
```

The installed profiles do not pin a provider or model. They set bounded
thinking, verification categories, concurrency guidance, and the one-writer
policy. Add both `provider` and `model` to a profile only when a repository
needs a pinned model. A repository-local file overrides a global profile with
the same name rather than merging individual fields, keeping changes explicit.

Use `/profile writing` for documentation and writing. It keeps one writer,
uses medium thinking, and requires source accuracy, valid links and commands,
and consistency with related README, quickstart, specification, and runbook
content.

## Shared skills

Pi discovers shared skills from `~/.agents/skills`. Ask naturally or invoke one
explicitly as `/skill:<name>`.

| Skill | Use it for |
|---|---|
| `agent-memory` | Recall compressed prior-session summaries or promote a stable lesson |
| `plan` | Break work into ordered, verifiable tasks |
| `research` | Explore a repository and external docs before changing code |
| `scope` | Define what is in and out after research |
| `review-plan` | Premortem and pressure-test an implementation plan |
| `review-changes` | Review the current uncommitted diff |
| `session-summary` | Produce a handoff-oriented end-of-session summary |
| `persona-panel` | Get distinct reviewing or brainstorming perspectives |
| `dd-agent-review` | Apply Ella's Datadog Agent Go review checklist |
| `create-pr-description` | Generate and update the current branch's PR description |
| `workspace-scp` | Copy files from a Datadog workspace |
| `sync-dotfiles` | Sync shared agent configuration to the dotfiles repository |
| `claude-config` | Change shared skills or Claude compatibility settings |
| `diary` | Compatibility route from the frozen diary to the compressed journal |
| `slack-mcp` | Maintain the older Claude/Space Jam Slack MCP setup |

Typical engineering sequence:

```text
/skill:research
/skill:scope
/skill:plan
/skill:review-plan
```

After implementation:

```text
/skill:review-changes
/skill:dd-agent-review
/skill:create-pr-description
/checkpoint
```

Skills can cause the agent to ask questions or impose a workflow contract.
Their instructions apply only when the skill is selected.

## Native command reference

In addition to the commands described above:

| Command | Purpose |
|---|---|
| `/login`, `/logout` | Manage provider authentication |
| `/llama` | Configure the llama.cpp provider |
| `/settings` | Open Pi settings |
| `/trust` | Manage directory trust |
| `/reload` | Reload extensions, skills, prompts, and themes |
| `/workspace [path|back|show]` | Choose, show, or switch the active Git repository while preserving the conversation |
| `/review [path|git [staged|base]]` | Choose a contextual review view or open a file/Git diff directly |
| `/agents [persistent|background|list|focus|recover|patch|cleanup]` | Guide or directly manage background and persistent agents |
| `/memory [status|checkpoint|distill|audit|cleanup|integrity|receipts]` | Guide or directly manage memory and retention |
| `/hotkeys` | Show keybindings |
| `/changelog` | Show release changes |
| `/quit` | Exit Pi |

Useful shell modes:

```bash
pi -p "one-shot prompt"
pi -c
pi -r
pi --session <path>
pi --session-id <id>
pi --fork <path-or-id>
pi --no-session
pi --provider <provider> --model <model>
pi --thinking <level>
pi --models <patterns>
pi --mode text|json|rpc
pi --offline
```

- `-p` prints a one-shot result.
- `-c` continues the most recent session.
- `-r` opens the session picker.
- `--no-session` disables native persistence, so `/resume` and durable session
  navigation will not be available for that run.
- `--offline` prevents network-dependent package/model refresh behavior.

Less-common startup controls:

```bash
pi --no-builtin-tools
pi --extension <path>
pi --skill <path>
pi --no-extensions
pi --no-skills
pi --no-context-files
pi --approve
pi --no-approve
```

- `--no-builtin-tools` keeps extension tools but disables Pi's built-ins.
- `--extension` and `--skill` explicitly load a resource.
- `--no-extensions`, `--no-skills`, and `--no-context-files` disable automatic
  discovery. The last flag also disables `AGENTS.md` and `CLAUDE.md`.
- `--approve` trusts project-local resources for that run; `--no-approve`
  ignores them. `/trust` saves a longer-lived project decision.

Package management:

```bash
pi list
pi install <package>
pi update
pi remove <package>
pi config
```

## Five practical recipes

### Research first, then implement

```text
Research how this subsystem currently handles shutdown. Cite the exact files and
tests. Do not edit yet.
```

Then:

```text
/skill:scope
/skill:plan
/skill:review-plan
/agents persistent Implement the approved shutdown plan with tests first
```

### Search Confluence and Slack

```text
Use the atlassian and slack MCP servers to find prior art for <topic>. Search
channel <name or ID>, compare the recommendations, and include source links.
```

Check `/mcp` first if a server appears disconnected.

### Parallel read-only review

```text
/parallel scout "find concurrency risks in this diff" -> reviewer "check tests and docs"
```

Watch it with `/subagents-fleet`; inspect aggregate cost with `/subagent-cost`.

### Supervise an implementation

```text
/agents persistent Add the new parser behavior, tests first, and update affected docs
```

Open the child tab in cmux to chat directly. Keep the parent free for review,
coordination, or a separate workstream.

### End a meaningful session

```text
/skill:review-changes
/name parser shutdown fix
```

The automatic checkpoint backstop runs once for the first durable change in a
session. It also runs before compaction when newer unsaved durable work exists.
If Pi warns that it could
not save the checkpoint, run `/checkpoint` manually. Later, use
`/resume` for the native session or ask `agent-memory` to recall the compressed
durable record.

## Troubleshooting

| Symptom | Check |
|---|---|
| `/agents persistent` says cmux is unavailable | Start Pi from a cmux terminal |
| `/agents persistent` says no Git repository | `cd` into the target repository |
| `/workspace` rejects the target | Use an existing directory inside a Git repository; ephemeral `--no-session` runs cannot switch |
| Repository-local context looks stale after switching | Run `/workspace` to confirm the active root, then `/reload` |
| Child work is unclear | `/agents list`, then enter its cmux tab |
| Background agent seems stuck | `/subagents-fleet`, `/subagents-doctor`, `/subagents-stop` |
| MCP server is missing or disconnected | `/mcp`, then `/mcp reconnect <server>` |
| Atlassian needs authentication | `/mcp reconnect atlassian`; approve in the browser and return to Pi |
| Slack needs authentication | Use `/mcp`; if the shared proxy token must be replaced, run `python3 ~/.agents/skills/slack-mcp/scripts/slack-mcp-auth.py` |
| Google Drive needs authentication | `/mcp reconnect google-workspace`; approve in the browser and return to Pi |
| Pi unexpectedly starts Slack OAuth | Remove same-name MCP config imports, `/reload`, then `/mcp reconnect slack` |
| Context behavior looks wrong | `/ctx-stats`, then `/ctx-doctor` |
| Automatic checkpoint was not saved | Run `/checkpoint`; copied conversation text is rejected and must be paraphrased |
| Recalled memory looks irrelevant | Ask for the prior decision explicitly; automatic recall runs only for continuity/context queries and is capped at roughly 400 tokens |
| Daily promotion review did not appear | Check `launchctl print gui/$(id -u)/com.ellataira.pi-daily-memory-review`, then use `/distill` |
| Topic edits are missing from recall | Run `~/.agents/skills/agent-memory/scripts/agent-memory reindex` |
| Retention candidates remain local | Run `/memory audit`; reconnect `google-workspace`, then invoke `/memory cleanup`. Missing/mismatched summaries intentionally fail closed |
| Extension or skill change is not visible | `/reload` |
| Review panel predates the last `/reload` | Run `/review` or `/review <path>` once; subsequent file-version updates refresh that page in place |
| Double-click opens the normal file app | Start or reload Pi, then run `cmux config reload` inside cmux; `/review <path>` verifies the Pi surface directly |
| Review UI says the file changed on disk | Reopen the file before saving; stale browser content is never allowed to overwrite a newer file |
| “Add to Pi” cannot find the session | Keep the originating Pi session alive; routing records are removed on clean shutdown and expire after 24 hours |
| Model catalog looks stale | `/refresh-models` |
| Footer is awkward in cmux | `/powerline placement below`; keep mouse scroll off |
| Floating pet is hidden or was quit | `/pet on` |
| Floating pet should stop for this session | `/pet off` |
| Action item is no longer relevant | `/inbox acknowledge <id>` or `/inbox acknowledge all` |
| Child worktree appears abandoned | `/agents list`, then `/agents recover <session-id>`; cleanup remains fail-closed |
| Wrong project profile is active | `/profile clear`, edit the profile file, then `/profile reload` |
| Paddington does not rebuild after source changes | `cd ~/.agents/extensions/agent-journal && npm run build:pet` |
| Telemetry looks unhealthy | `trajectory doctor` |
| Need the exact installed packages | `pi list` |

## Configuration and source-of-truth files

| Area | File |
|---|---|
| Installed Pi packages and powerline settings | `~/.pi/agent/settings.json` |
| MCP server configuration | `~/.pi/agent/mcp.json` |
| Subagent limits and worktree base | `~/.pi/agent/extensions/subagent/config.json` |
| Custom cockpit package | `~/.agents/extensions/agent-journal/` |
| Shared skills | `~/.agents/skills/` |
| Native Pi sessions | `~/.pi/agent/sessions/` |
| Action inbox | `~/.agents/runtime/pi-pet/inbox.json` |
| Global project profiles | `~/.pi/agent/project-profiles.json` |
| Repository project profiles | `<repo>/.pi/project-profiles.json` |
| Owned cmux child registry | `~/.pi/agent/cmux-children.json` |
| Live review routing metadata | `~/.agents/runtime/pi-review/sessions/` |
| Persistent diff comments | `~/.agents/reviews/diff-comments.json` |
| cmux preferred-editor route | `~/.config/cmux/cmux.json` |
| Compressed Obsidian journal | `~/Documents/Obsidian Vault/ella.taira/agent-journal/` |

This guide reflects Pi `0.82.0` and the package versions recorded in
`~/.pi/agent/settings.json`. Re-run `pi list` after package changes, and update
this guide when commands or contracts change.
