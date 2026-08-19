#!/usr/bin/env node

import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildFeatureUsage,
  evaluatePiHealth,
  latestDatedFilename,
  mergePiUsage,
  summarizePiJsonl
} from "../src/pi-health-audit.mjs";

const execute = promisify(execFile);
const home = homedir();
const daysArg = process.argv.indexOf("--days");
const days = Math.min(366, Math.max(1, Number(daysArg >= 0 ? process.argv[daysArg + 1] : 30) || 30));
const end = new Date();
const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
const vaultRoot = process.env.AGENT_JOURNAL_VAULT_ROOT ??
  path.join(home, "Documents", "Obsidian Vault", "ella.taira", "agent-journal");
const stateRoot = process.env.AGENT_JOURNAL_STATE_ROOT ??
  path.join(home, ".agents", "state", "agent-journal");
const piSessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR ??
  path.join(home, ".pi", "agent", "sessions");

async function walk(root, suffix) {
  const output = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(target);
    }
  }
  return output;
}

function suspiciousLabel(value) {
  return /^(?:reply exactly|call journal_|<[^>]+>|(?:user|assistant|system|tool)\s*:)/i.test(value.trim()) || value.length > 240;
}

const piFiles = await walk(piSessionsRoot, ".jsonl");
const summaries = [];
let activeSessionFiles = 0;
for (const file of piFiles) {
  const summary = summarizePiJsonl(await readFile(file, "utf8"), { start, end });
  if (summary.records) activeSessionFiles += 1;
  summaries.push(summary);
}
const pi = mergePiUsage(summaries);
pi.sessionFiles = activeSessionFiles;

const database = new DatabaseSync(path.join(stateRoot, "index.sqlite"), { readOnly: true });
const one = (sql) => database.prepare(sql).get();
const journal = {
  ...one("SELECT COUNT(*) AS indexedSessions, COUNT(DISTINCT repository) AS repositories, MIN(updated_at) AS oldest, MAX(updated_at) AS newest FROM journal_documents"),
  ...one("SELECT COUNT(*) AS promotedMemories FROM memory_documents"),
  ...one("SELECT COUNT(*) AS topicRows, COUNT(DISTINCT topic) AS distinctTopics FROM journal_topics"),
  ...one("SELECT COUNT(*) AS coldIndexedSessions FROM journal_documents WHERE drive_file_id IS NOT NULL"),
  ...one("SELECT COUNT(*) AS missingIndexedPaths FROM journal_documents WHERE note_path=''"),
  integrity: one("PRAGMA integrity_check").integrity_check
};
database.close();

const sessionNotes = await walk(path.join(vaultRoot, "sessions"), ".md");
const memoryNotes = await walk(path.join(vaultRoot, "memory"), ".md");
const dailyNotes = await walk(path.join(vaultRoot, "daily"), ".md");
let invalidSessionRepresentation = 0;
let invalidMemoryRepresentation = 0;
let suspiciousDailyLinks = 0;
for (const file of sessionNotes) {
  if (!/^representation: compressed-summary-v1$/m.test(await readFile(file, "utf8"))) invalidSessionRepresentation += 1;
}
for (const file of memoryNotes) {
  if (!/^representation: compressed-summary-v1$/m.test(await readFile(file, "utf8"))) invalidMemoryRepresentation += 1;
}
for (const file of dailyNotes) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\[([^\]]+)\]\([^\n)]+\)/g)) {
    if (suspiciousLabel(match[1])) suspiciousDailyLinks += 1;
  }
}
journal.sessionNotes = sessionNotes.length;
journal.memoryNotes = memoryNotes.length;
journal.dailyRollups = dailyNotes.length;
journal.latestDailyRollup = latestDatedFilename(dailyNotes);
journal.invalidSessionRepresentation = invalidSessionRepresentation;
journal.invalidMemoryRepresentation = invalidMemoryRepresentation;
journal.suspiciousDailyLinks = suspiciousDailyLinks;

const maintenance = JSON.parse(await readFile(path.join(stateRoot, "maintenance.json"), "utf8").catch(() => "{}"));
let reminder = { loaded: false, lastExitCode: null };
let monthlyAudit = { loaded: false, lastExitCode: null };
if (process.platform === "darwin") {
  try {
    const { stdout } = await execute("/bin/launchctl", [
      "print",
      `gui/${process.getuid()}/com.ellataira.pi-daily-memory-review`
    ]);
    reminder = {
      loaded: true,
      lastExitCode: Number(stdout.match(/last exit code = (\d+)/)?.[1] ?? 0),
      runs: Number(stdout.match(/runs = (\d+)/)?.[1] ?? 0)
    };
  } catch {}
  try {
    const { stdout } = await execute("/bin/launchctl", [
      "print",
      `gui/${process.getuid()}/com.ellataira.pi-monthly-health`
    ]);
    monthlyAudit = {
      loaded: true,
      lastExitCode: Number(stdout.match(/last exit code = (\d+)/)?.[1] ?? 0),
      runs: Number(stdout.match(/runs = (\d+)/)?.[1] ?? 0)
    };
  } catch {}
}

const skillPath = path.join(home, ".agents", "skills", "agent-memory", "SKILL.md");
const skillText = await readFile(skillPath, "utf8").catch(() => "");
const issues = [];
const health = evaluatePiHealth(pi);
issues.push(...health.issues);
if (journal.integrity !== "ok") issues.push("SQLite integrity check failed");
if (journal.indexedSessions !== journal.sessionNotes + journal.coldIndexedSessions) issues.push("Session note and index counts differ");
if (invalidSessionRepresentation) issues.push(`${invalidSessionRepresentation} session notes lack the compressed representation marker`);
if (invalidMemoryRepresentation) issues.push(`${invalidMemoryRepresentation} promoted memories lack the compressed representation marker`);
if (suspiciousDailyLinks) issues.push(`${suspiciousDailyLinks} daily-rollup links have prompt-shaped labels`);
if (reminder.loaded && reminder.lastExitCode !== 0) issues.push(`Daily reminder last exit code is ${reminder.lastExitCode}`);
if (/Missed days catch up one per day/.test(skillText)) issues.push("agent-memory skill documents obsolete one-day catch-up behavior");
if (pi.recall.attempts === 0) issues.push("No privacy-safe recall telemetry was recorded in this window");
if (
  maintenance.completedThrough &&
  (!journal.latestDailyRollup || journal.latestDailyRollup < maintenance.completedThrough)
) {
  issues.push(
    `Daily link rollups stop at ${journal.latestDailyRollup ?? "none"} while promotion review is complete through ${maintenance.completedThrough}`
  );
}

pi.featureUsage = buildFeatureUsage(pi);
pi.healthRates = health.rates;
pi.watchedToolRates = health.toolRates;

const report = {
  schemaVersion: 1,
  generatedAt: end.toISOString(),
  window: { start: start.toISOString(), end: end.toISOString(), days },
  pi,
  journal,
  maintenance: {
    completedThrough: maintenance.completedThrough ?? null,
    lastDistillationCompletedAt: maintenance.lastDistillationCompletedAt ?? null,
    lastCleanupAuditAt: maintenance.lastCleanupAuditAt ?? null,
    lastDriveIntegrityAt: maintenance.lastDriveIntegrityAt ?? null,
    localCompressedNoteRetentionDays: maintenance.localCompressedNoteRetentionDays ?? null
  },
  reminder,
  monthlyAudit,
  issues
};

function markdown(value) {
  const toolRows = Object.entries(value.pi.toolResults)
    .sort((a, b) => (b[1].success + b[1].error) - (a[1].success + a[1].error))
    .slice(0, 20)
    .map(([name, result]) => `| ${name} | ${result.success} | ${result.error} |`)
    .join("\n") || "| None observed | 0 | 0 |";
  const modelRows = Object.entries(value.pi.models)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([name, model]) => `| ${name} | ${model.calls} | ${model.inputTokens} | ${model.outputTokens} | ${model.cacheReadTokens} | $${model.costUsd.toFixed(2)} |`)
    .join("\n") || "| None observed | 0 | 0 | 0 | 0 | $0.00 |";
  return `---\nschema_version: 1\nreport_kind: pi-monthly-health\ngenerated_at: ${JSON.stringify(value.generatedAt)}\nwindow_start: ${JSON.stringify(value.window.start)}\nwindow_end: ${JSON.stringify(value.window.end)}\n---\n\n# Pi health audit · ${value.generatedAt.slice(0, 10)}\n\nThis report contains aggregate metadata only. It never stores prompts, responses, tool arguments, or transcript text.\n\n## Result\n\n${value.issues.length ? value.issues.map((issue) => `- ⚠️ ${issue}`).join("\n") : "- ✅ No health issues detected."}\n\n## Usage\n\n- Session files active: ${value.pi.sessionFiles}\n- User turns: ${value.pi.userTurns}\n- Assistant runs: ${value.pi.assistantRuns}\n- Compactions: ${value.pi.compactions}\n- Recall attempts/results/cold results: ${value.pi.recall.attempts}/${value.pi.recall.results}/${value.pi.recall.coldResults}\n- Feature calls (checkpoint/daily review/review UI/pair terminal/subagents/cmux/MCP): ${value.pi.featureUsage.checkpoint}/${value.pi.featureUsage.dailyReview}/${value.pi.featureUsage.reviewUi}/${value.pi.featureUsage.pairTerminal}/${value.pi.featureUsage.subagents}/${value.pi.featureUsage.cmuxChildren}/${value.pi.featureUsage.mcp}\n- Checkpoint / cmux / context execution / context indexing error rates: ${(value.pi.healthRates.checkpointErrorRate * 100).toFixed(1)}% / ${(value.pi.healthRates.cmuxSessionErrorRate * 100).toFixed(1)}% / ${(value.pi.healthRates.contextExecuteFileErrorRate * 100).toFixed(1)}% / ${(value.pi.healthRates.contextFetchIndexErrorRate * 100).toFixed(1)}%\n- Maximum-length stops / assistant runs: ${(value.pi.healthRates.lengthStopRate * 100).toFixed(1)}%\n- Compactions / user turns: ${(value.pi.healthRates.compactionsPerUserTurn * 100).toFixed(1)}%\n- JSONL parse errors: ${value.pi.parseErrors}\n\n| Model | Calls | Input | Output | Cache read | Cost |\n|---|---:|---:|---:|---:|---:|\n${modelRows}\n\n| Tool | Success | Error |\n|---|---:|---:|\n${toolRows}\n\n## Memory\n\n- Indexed sessions / session notes / cold index: ${value.journal.indexedSessions} / ${value.journal.sessionNotes} / ${value.journal.coldIndexedSessions}\n- Promoted memories: ${value.journal.promotedMemories}\n- Topic rows / distinct topics: ${value.journal.topicRows} / ${value.journal.distinctTopics}\n- Daily rollups: ${value.journal.dailyRollups} (latest ${value.journal.latestDailyRollup ?? "none"})\n- Distillation complete through: ${value.maintenance.completedThrough ?? "unknown"}\n- SQLite integrity: ${value.journal.integrity}\n- Reminder runs / last exit: ${value.reminder.runs ?? "unknown"} / ${value.reminder.lastExitCode ?? "unknown"}\n- Monthly audit loaded / runs / last exit: ${value.monthlyAudit.loaded} / ${value.monthlyAudit.runs ?? "unknown"} / ${value.monthlyAudit.lastExitCode ?? "unknown"}\n`;
}

if (process.argv.includes("--write")) {
  const reportDate = end.toISOString().slice(0, 10);
  const target = path.join(vaultRoot, "audits", reportDate.slice(0, 4), reportDate.slice(5, 7), `${reportDate}-pi-health.md`);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, markdown(report), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  process.stdout.write(`${JSON.stringify({ reportPath: target, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
