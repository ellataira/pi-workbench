# Pi Workbench

Pi Workbench is Ella's private, portable Pi cockpit for cmux. It keeps the
custom extensions, tests, documentation, and sanitized configuration needed to
restore the setup without storing prompts, transcripts, credentials, or runtime
session data.

- New setup or full command reference: [Pi + cmux quickstart](./QUICKSTART.md)
- Dated feature history: [Changelog](./CHANGELOG.md)

## What it adds

- bounded, compressed session memory with Obsidian, Drive retention, and
  proactive recall;
- persistent implementation agents in isolated worktrees plus lightweight
  background fan-out;
- a visible pair-programming terminal where Pi observes commands that you run;
- one session-aware Markdown and diff review workspace with multi-file inline
  comment batches;
- session utilities for workspace switching, forks, resume cloning, rewind,
  command copying, rename, and deletion;
- MCP recovery, project profiles, health audits, action inboxes, and Paddington,
  the always-on-top macOS lifecycle pet.

Third-party integrations remain vendor-neutral. `pi-subagents` is pinned and
hardened so child prompts, transcripts, and raw metadata are not retained.

## Install or restore

```bash
git clone git@github.com:ellataira/pi-workbench.git
cd pi-workbench
npm ci
npm test
npm run bootstrap -- --replace-existing
npm run install:pi-copy-picker
npm run install:pi-prompt-echo
npm run install:pi-resume-clone
npm run install:daily-review
npm run install:monthly-audit
```

`bootstrap` links this checkout at `~/.agents/extensions/agent-journal` and
merges portable settings without replacing machine-specific packages, model
selection, credentials, or unrelated configuration. Rebuild the native pet on
a Mac with Apple build tools using `npm run build:pet`.

## Everyday commands

Start Pi inside a cmux terminal:

```bash
pi
```

- `/workspace <path>` changes repositories without losing the conversation;
  `/workspace back` returns to the previous repository.
- `/agents` opens the Agent Center. Use `/agents persistent <task>` for an
  isolated implementation agent and background subagents for lightweight
  research or review fan-out.
- `/fork` branches from an earlier message into a new cmux tab. `Alt+Enter` in
  `/resume` clones a saved session without replacing the current one.
- `/pair start` opens the user-controlled paired terminal; `/pair stop` ends
  observation.
- `/review` is the single review entry point. It opens the cumulative
  session workspace, where you can switch among last-turn, last-commit,
  branch-from-main, staged, unstaged, and complete-file views.
- `/copy` immediately copies the suggested command, then lets you choose another
  command, a complete multiline shell script, or the full latest response.
- `/rewind`, `/rename`, and `/end` resume from a prior message, rename the
  session, or permanently delete only the active native session file.
- `/memory`, `/checkpoint`, and `/distill` expose memory status, explicit
  checkpointing, and daily promotion review.
- `/profile` selects a vendor-neutral working profile such as writing mode.

The quickstart documents all commands, navigation behavior, recovery paths,
and safety constraints.

## Action inbox and project profiles

`/inbox` consolidates actionable states from sessions, subagents, MCP,
automations, and daily memory review. Paddington surfaces the same bounded
metadata and can focus a related cmux workspace. Inbox records never contain
prompts, messages, tool arguments, or transcripts.

Project profiles tune model-independent behavior such as tool availability,
verification, and writing depth. Repository-local profiles override global
ones without locking the workbench to a model vendor.

## Memory, retention, and audits

Pi writes compressed semantic checkpoints rather than prompts or transcripts.
Local native sessions remain resumable for 30 days. Verified compressed notes
can move to Drive-backed cold storage while their searchable metadata and Drive
references remain local for automatic rehydration.

The daily memory review runs at 9 AM New York time. The monthly health audit
runs on the first day of each month and checks memory, review, pair-terminal,
pet, MCP, and checkpoint behavior using aggregate metadata only. Audit records
contain no prompts or transcripts.

Install or refresh those jobs with:

```bash
npm run install:daily-review
npm run install:monthly-audit
```

## Repository boundary

Tracked content includes source, tests, docs, sanitized Pi settings, and
credential-free MCP definitions. The repository excludes OAuth state, tokens,
raw sessions, Obsidian content, SQLite/runtime state, caches, dependencies, and
built applications. Organization-specific connector endpoints remain only in
machine-local Pi configuration and are protected by a tracked privacy test.

The daily GitHub sync validates `npm test` and `git diff --check`, rejects
secret-like files, commits verified local changes, and safely integrates remote
updates. It updates this README only when the current entry-point behavior or a
major capability changes; every meaningful sync adds a dated changelog entry.

## Validation

```bash
npm test
npm run canary:memory
npm run audit:pi
npm run test:e2e-review
```

GitHub Actions runs the extension suite and rendered-guide checks on pushes and
pull requests.
