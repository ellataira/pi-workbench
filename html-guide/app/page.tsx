"use client";

import { useMemo, useState } from "react";

type GuideSection = {
  id: string;
  index: string;
  title: string;
  summary: string;
  tags: string[];
  content: React.ReactNode;
};

function CodeBlock({
  children,
  label = "terminal",
}: {
  children: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="code-block">
      <div className="code-bar">
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${label} code`}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Command({
  value,
  detail,
}: {
  value: string;
  detail: string;
}) {
  return (
    <div className="command-row">
      <code>{value}</code>
      <span>{detail}</span>
    </div>
  );
}

function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warn" | "success";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <aside className={`callout callout-${tone}`}>
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}

const sections: GuideSection[] = [
  {
    id: "first-ten",
    index: "01",
    title: "First 10 minutes",
    summary: "Start Pi in cmux, choose the right execution shape, and finish with a durable checkpoint.",
    tags: ["start", "basics", "workflow"],
    content: (
      <>
        <div className="step-grid">
          <article className="step-card">
            <span>01 / launch</span>
            <h3>Start inside cmux</h3>
            <p>Open a cmux terminal workspace, move into your repository, and launch Pi.</p>
            <CodeBlock>{`cd /path/to/repository\npi`}</CodeBlock>
          </article>
          <article className="step-card">
            <span>02 / choose</span>
            <h3>Match the work shape</h3>
            <p>Keep simple work in the parent. Fan out bounded research. Use a child for substantial implementation.</p>
            <CodeBlock>{`/agents background Inspect the parser and tests\n/agents persistent Implement the parser fix and its tests`}</CodeBlock>
          </article>
          <article className="step-card">
            <span>03 / finish</span>
            <h3>Leave a compact trail</h3>
            <p>Meaningful work checkpoints automatically. Use the command when you want an explicit milestone.</p>
            <CodeBlock>{`/checkpoint\n/inbox`}</CodeBlock>
          </article>
          <article className="step-card">
            <span>04 / move</span>
            <h3>Switch repositories</h3>
            <p>Keep the conversation, then rebind tools, instructions, local skills, profiles, and memory scope to another Git repository.</p>
            <CodeBlock>{`/workspace\n/workspace ~/Desktop/another-repo\n/workspace back`}</CodeBlock>
          </article>
        </div>
        <Callout tone="success" title="The default operating rule">
          One implementing child per worktree. Background subagents are for lightweight, bounded fan-out.
        </Callout>
      </>
    ),
  },
  {
    id: "controls",
    index: "02",
    title: "Everyday controls",
    summary: "The commands you will reach for most often while steering, branching, and inspecting Pi.",
    tags: ["commands", "sessions", "models", "steering"],
    content: (
      <>
        <div className="command-table">
          <Command value="!" detail="Enter shell mode; Esc returns to normal input." />
          <Command value="!command" detail="Run a shell command and show output to the model." />
          <Command value="!!command" detail="Run locally without adding output to model context." />
          <Command value="/model" detail="Select a model; use /thinking to adjust reasoning." />
          <Command value="/tree" detail="Browse the current session tree." />
          <Command value="/fork" detail="Branch this conversation in parallel." />
          <Command value="/resume" detail="Return to a prior Pi session." />
          <Command value="/workspace <path>" detail="Preserve the conversation and switch the active Git repository." />
          <Command value="/workspace back" detail="Return to the previous active repository." />
          <Command value="/review" detail="Choose last-turn changes, a suggested complete file, or a Git diff." />
          <Command value="/review <path>" detail="Skip the chooser and open one complete file directly." />
          <Command value="/review git [staged|base]" detail="Open a Git diff directly through the same review entry point." />
          <Command value="/agents" detail="Choose persistent implementation or lightweight fan-out and manage active agents." />
          <Command value="/compact" detail="Compact working context when necessary." />
          <Command value="/ctx-stats" detail="Inspect context-mode savings and health." />
          <Command value="/powerline" detail="Configure footer placement and detail." />
        </div>
        <Callout title="Steer without restarting">
          Send another message while Pi is working to steer the current turn. Use the follow-up queue when the new instruction should run next.
        </Callout>
        <Callout tone="success" title="What transfers across repositories">
          Shared skills, extensions, MCP connections, model state, and global memory stay available. Target-repository AGENTS.md, CLAUDE.md, local skills, profiles, and proactive memory scope replace the source repository&apos;s local context.
        </Callout>
      </>
    ),
  },
  {
    id: "supervisor",
    index: "03",
    title: "Supervisor and subagents",
    summary: "Choose between enterable cmux children and bounded background specialists.",
    tags: ["cmux", "subagents", "orchestration", "children"],
    content: (
      <>
        <div className="split-panel">
          <article>
            <p className="kicker">Persistent + steerable</p>
            <h3>cmux child</h3>
            <p>Best for implementation, long validation, or anything you may want to enter and chat with directly.</p>
            <CodeBlock>{`/agents\n/agents persistent Implement cache safety and add tests`}</CodeBlock>
          </article>
          <article>
            <p className="kicker">Bounded + background</p>
            <h3>Subagent fleet</h3>
            <p>Best for parallel research, review, and decomposition whose results should return inline.</p>
            <CodeBlock>{`/agents background Trace lifecycle and find edge cases\n/subagents-fleet\n/subagent-cost`}</CodeBlock>
          </article>
        </div>
        <ul className="check-list">
          <li>Ordinary fan-out is capped at four concurrent agents and one nesting level.</li>
          <li>Implementing children receive isolated Git worktrees automatically.</li>
          <li>The parent can focus, message, or interrupt only workspaces it owns.</li>
          <li>Children remain normal Pi sessions with their own tree and resume history.</li>
        </ul>
      </>
    ),
  },
  {
    id: "worktrees",
    index: "04",
    title: "Worktree lifecycle",
    summary: "Inspect, recover, export, and safely clean the worktrees owned by the Pi supervisor.",
    tags: ["git", "worktrees", "cleanup", "recovery", "patch"],
    content: (
      <>
        <div className="command-table">
          <Command value="/agents" detail="Choose an existing agent and focus, recover, patch, or clean it up." />
          <Command value="/agents list" detail="Show active, orphaned, dirty, merged, missing, or unknown state." />
          <Command value="/agents recover <id>" detail="Reopen an orphaned child in its existing session and worktree." />
          <Command value="/agents patch <id>" detail="Create a reviewable patch without applying it." />
          <Command value="/agents cleanup <id>" detail="Remove only a clean, merged, inactive child." />
        </div>
        <Callout tone="warn" title="Cleanup is deliberately strict">
          Cleanup refuses to run when cmux liveness cannot be verified, the workspace is active, the tree is dirty, or the branch is not merged into repository HEAD. Patch creation rejects untracked files and caps output at 10 MiB.
        </Callout>
      </>
    ),
  },
  {
    id: "inbox",
    index: "05",
    title: "Action inbox",
    summary: "A persistent, clickable queue for approvals, blocks, completions, and failures.",
    tags: ["pet", "inbox", "notifications", "automation", "approval"],
    content: (
      <>
        <CodeBlock>{`/inbox\n/inbox list\n/inbox clear completed\n/inbox clear stale`}</CodeBlock>
        <div className="state-grid">
          <article><span className="state-dot failed" /> <strong>Failed</strong><p>Tool, subagent, or scheduled run needs attention.</p></article>
          <article><span className="state-dot blocked" /> <strong>Blocked</strong><p>Authentication or an external dependency stopped progress.</p></article>
          <article><span className="state-dot approval" /> <strong>Approval</strong><p>A structured question or daily memory review is waiting.</p></article>
          <article><span className="state-dot completed" /> <strong>Completed</strong><p>A session, subagent, or automation finished.</p></article>
        </div>
        <p>Paddington reads the same queue. Clicking acknowledges the selected item and focuses the originating cmux workspace when routing metadata exists.</p>
        <Callout title="Privacy contract">
          Inbox entries contain fixed state, source, reason code, timestamps, and routing IDs only. They never contain prompts, task names, messages, tool arguments, or transcripts.
        </Callout>
      </>
    ),
  },
  {
    id: "profiles",
    index: "06",
    title: "Project profiles",
    summary: "Apply vendor-neutral bundles for thinking, tools, verification, and agent policy.",
    tags: ["profiles", "model", "tools", "policy", "thinking"],
    content: (
      <>
        <div className="profile-grid">
          <article><span>balanced</span><h3>implementation</h3><p>Medium thinking, four-agent cap, one writer, tests and docs.</p></article>
          <article><span>fast</span><h3>quick-fix</h3><p>Low thinking, one agent, focused tests, one writer.</p></article>
          <article><span>wide</span><h3>research</h3><p>Medium thinking, up to four readers, source provenance.</p></article>
          <article><span>editorial</span><h3>writing</h3><p>Documentation and writing with one writer, source accuracy, link and command checks, and cross-doc consistency.</p></article>
          <article><span>guarded</span><h3>sensitive</h3><p>High thinking, one agent, explicit approval, tests and docs.</p></article>
        </div>
        <CodeBlock>{`/profile\n/profile implementation\n/profile research\n/profile writing\n/profile clear\n/profile reload`}</CodeBlock>
        <p>Global profiles live at <code>~/.pi/agent/project-profiles.json</code>. A repository can override them in <code>.pi/project-profiles.json</code>. Provider and model are optional and must be supplied as a pair.</p>
      </>
    ),
  },
  {
    id: "memory",
    index: "07",
    title: "Memory and retention",
    summary: "Compressed, provenance-linked continuity without retaining prompts or transcripts.",
    tags: ["memory", "journal", "obsidian", "drive", "retention", "distill"],
    content: (
      <>
        <div className="flow">
          <div><span>1</span><strong>Checkpoint</strong><p>Substantive work creates a compressed-summary-v1 record.</p></div>
          <i>→</i>
          <div><span>2</span><strong>Index</strong><p>Topics and summary fields enter SQLite FTS for bounded recall.</p></div>
          <i>→</i>
          <div><span>3</span><strong>Promote</strong><p>At 9 AM, macOS reminds you; Pi asks what becomes durable memory.</p></div>
          <i>→</i>
          <div><span>4</span><strong>Retain</strong><p>Drive backs cold summaries; local searchable receipts remain.</p></div>
        </div>
        <div className="command-table">
          <Command value="/memory" detail="Choose status, checkpoint, daily review, or a retention workflow." />
          <Command value="/checkpoint" detail="Direct shortcut for a compact milestone checkpoint." />
          <Command value="/distill [date]" detail="Direct shortcut for promotion review." />
          <Command value="/memory audit" detail="Read-only report for old native sessions." />
          <Command value="/memory cleanup" detail="Verify Drive readback before deleting eligible local JSONL." />
          <Command value="/memory integrity" detail="Sample and verify bounded Drive archives." />
        </div>
        <Callout tone="success" title="Recall budget">
          Proactive recall runs only for context and continuity questions, is repository-scoped, and is capped at three items and roughly 400 tokens. Exact topic matches rank first.
        </Callout>
        <Callout tone="warn" title="Hard boundary">
          Raw prompts, assistant responses, role-labelled dialogue, tool arguments, and transcripts never enter Obsidian, SQLite, or Drive. Verified compressed Markdown stays local for 90 days; receipt metadata remains indefinitely.
        </Callout>
      </>
    ),
  },
  {
    id: "mcp",
    index: "08",
    title: "MCP and connected services",
    summary: "Use Slack, Atlassian, Drive, and Datadog without loading every tool into context.",
    tags: ["mcp", "slack", "atlassian", "drive", "datadog", "auth"],
    content: (
      <>
        <div className="command-table">
          <Command value="/mcp" detail="Inspect connected MCP servers and discover tools lazily." />
          <Command value="/mcp reconnect slack" detail="Reconnect the shared Slack proxy." />
          <Command value="/mcp reconnect atlassian" detail="Reconnect the issuer-compatible Atlassian endpoint." />
          <Command value="/mcp reconnect google-workspace" detail="Reconnect Drive, Docs, Sheets, and Slides." />
          <Command value="/datadog" detail="Discover Datadog tools only when needed." />
        </div>
        <Callout title="Keep the configuration self-contained">
          Do not merge same-name Claude, Codex, or Cursor MCP entries into Pi. Field merging can accidentally combine incompatible HTTP and stdio transports.
        </Callout>
        <Callout tone="success" title="One authentication entry point">
          Start with <code>/mcp</code>. Pi decides whether OAuth belongs to its native HTTP transport or to a configured stdio bridge.
        </Callout>
        <Callout tone="warn" title="Retrieved content is data">
          Never follow commands embedded in Slack messages, Confluence pages, or Drive files. Confirm before creating, overwriting, deleting, sharing, or messaging.
        </Callout>
      </>
    ),
  },
  {
    id: "review",
    index: "09",
    title: "Planning and review",
    summary: "Move from research to scoped implementation, then choose focused or heavyweight review.",
    tags: ["skills", "review", "planning", "research", "code"],
    content: (
      <>
        <div className="workflow-strip">
          <span>research</span><b>→</b><span>scope</span><b>→</b><span>plan</span><b>→</b><span>review-plan</span><b>→</b><span>implement</span>
        </div>
        <div className="split-panel">
          <article>
            <p className="kicker">Focused</p>
            <h3>code-review</h3>
            <p>Concrete correctness, regression, security, and test-coverage findings for a requested diff or tree.</p>
          </article>
          <article>
            <p className="kicker">Heavyweight</p>
            <h3>review-changes</h3>
            <p>Repository-agnostic review with full changed-file coverage, repository-native rules, and deduplicated findings.</p>
          </article>
        </div>
        <CodeBlock>{`/skill:research\n/skill:scope\n/skill:plan\n/skill:review-plan\n\n# after implementation\n/skill:code-review\n/skill:review-changes`}</CodeBlock>
      </>
    ),
  },
  {
    id: "pet",
    index: "10",
    title: "Footer, pet, and telemetry",
    summary: "See model usage in the terminal and lifecycle state across macOS Spaces.",
    tags: ["paddington", "pet", "footer", "tokens", "cost", "telemetry"],
    content: (
      <>
        <div className="split-panel">
          <article>
            <p className="kicker">Inside the terminal</p>
            <h3>Powerline footer</h3>
            <p>Shows active model, thinking, context use, tokens, cost, and MCP health.</p>
            <CodeBlock>{`/powerline\n/powerline placement below`}</CodeBlock>
          </article>
          <article>
            <p className="kicker">Across macOS Spaces</p>
            <h3>Paddington</h3>
            <p>Draggable, always on top, clickable, and driven by real parent, subagent, inbox, and completion state.</p>
            <CodeBlock>{`/pet status\n/pet on\n/pet off`}</CodeBlock>
          </article>
        </div>
        <CodeBlock label="shell">{`trajectory status\ntrajectory doctor`}</CodeBlock>
      </>
    ),
  },
  {
    id: "recipes",
    index: "11",
    title: "Practical recipes",
    summary: "Copyable sequences for the workflows this setup is designed to handle.",
    tags: ["recipes", "examples", "slack", "confluence", "implementation"],
    content: (
      <div className="recipe-grid">
        <article><span>Research first</span><CodeBlock>{`/skill:research\n/skill:scope\n/skill:plan\n/skill:review-plan`}</CodeBlock></article>
        <article><span>Search company context</span><CodeBlock>{`Find the relevant Confluence design and Slack discussion.\nSummarize decisions with source links.`}</CodeBlock></article>
        <article><span>Supervise implementation</span><CodeBlock>{`/agents persistent Implement the approved plan, add tests, update docs, and report validation.`}</CodeBlock></article>
        <article><span>Finish meaningfully</span><CodeBlock>{`Review the final diff and verification evidence.\n/checkpoint\n/inbox`}</CodeBlock></article>
      </div>
    ),
  },
  {
    id: "troubleshooting",
    index: "12",
    title: "Troubleshooting",
    summary: "Fast recovery paths for the failures most likely to interrupt daily work.",
    tags: ["troubleshooting", "repair", "auth", "reload", "errors"],
    content: (
      <div className="trouble-list">
        <details><summary>Extension or skill change is not visible</summary><p>Run <code>/reload</code>. For shared skill changes, verify the canonical path under <code>~/.agents/skills</code>.</p></details>
        <details><summary>Model catalog looks stale</summary><p>Run <code>/refresh-models</code>, then inspect <code>/model</code>.</p></details>
        <details><summary>MCP authentication is failing</summary><p>Use <code>/mcp</code>, reconnect the exact server, and complete any browser approval. Slack uses the shared proxy; Drive uses the locally configured Workspace endpoint.</p></details>
        <details><summary>A child worktree appears abandoned</summary><p>Run <code>/agents</code> and select the child, or use <code>/agents recover &lt;session-id&gt;</code>. Cleanup remains fail-closed.</p></details>
        <details><summary>The daily memory review did not appear</summary><p>A launchd notification fires at 9 AM New York; the next Pi turn queues the review. Check the launchd service or run <code>/distill</code> manually.</p></details>
        <details><summary>Paddington is hidden or stale</summary><p>Run <code>/pet on</code>. After source changes, rebuild the native companion from the agent-journal package.</p></details>
        <details><summary>The active profile is wrong</summary><p>Run <code>/profile clear</code>, update the global or repository profile, then <code>/profile reload</code>.</p></details>
      </div>
    ),
  },
];

export default function Home() {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      normalized
        ? sections.filter((section) =>
            [
              section.title,
              section.summary,
              section.tags.join(" "),
            ]
              .join(" ")
              .toLowerCase()
              .includes(normalized),
          )
        : sections,
    [normalized],
  );

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Pi and cmux field guide home">
          <span className="brand-mark">π</span>
          <span>Pi + cmux docs</span>
        </a>
        <label className="search">
          <span>⌕</span>
          <input
            type="search"
            aria-label="Search guide"
            placeholder="Search commands, tools, workflows…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </label>
        <nav className="source-links" aria-label="Source documents">
          <a href="/README.md">README</a>
          <a href="/QUICKSTART.md">Quickstart</a>
          <a href="/CHANGELOG.md">Changelog</a>
        </nav>
      </header>

      <aside className="rail">
        <div className="rail-label">Navigate</div>
        <label className="mobile-nav">
          <span>Chapter</span>
          <select
            aria-label="Choose guide chapter"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) window.location.hash = event.target.value;
            }}
          >
            <option value="" disabled>Choose a chapter…</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.index} · {section.title}
              </option>
            ))}
          </select>
        </label>
        <nav>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              <span>{section.index}</span>
              {section.title}
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          Pi guide · 2026.07.30
        </div>
      </aside>

      <main id="top">
        <section className="doc-intro">
          <p className="overline">Documentation</p>
          <h1>Pi + cmux guide</h1>
          <p>
            A practical reference for sessions, tools, memory, and workflows.
            Start with the quick setup, then use the navigation to find a
            command or feature.
          </p>
        </section>

        {normalized && (
          <div className="search-result">
            <span>{visible.length}</span> {visible.length === 1 ? "chapter" : "chapters"} matching “{query}”
            <button type="button" onClick={() => setQuery("")}>clear</button>
          </div>
        )}

        <div className="guide-content">
          {visible.map((section) => (
            <section
              className="guide-section"
              id={section.id}
              key={section.id}
            >
              <header className="section-head">
                <span>{section.index}</span>
                <div>
                  <h2>{section.title}</h2>
                  <p>{section.summary}</p>
                </div>
              </header>
              <div className="section-body">{section.content}</div>
            </section>
          ))}
          {visible.length === 0 && (
            <div className="empty-state">
              <span>⌕</span>
              <h2>No matching chapter</h2>
              <p>Try a command name, “memory,” “worktree,” “MCP,” or “pet.”</p>
              <button type="button" onClick={() => setQuery("")}>Show all chapters</button>
            </div>
          )}
        </div>

        <footer>
          <div>
            <span className="brand-mark">π</span>
            <strong>Pi + cmux Field Guide</strong>
          </div>
          <p>Guide build 2026.07.30. Generated from the installed README and quickstart; source documents remain the contract.</p>
          <a href="#top">Back to top ↑</a>
        </footer>
      </main>
    </div>
  );
}
