#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { acknowledgeInbox, upsertInboxItem } from "../src/action-inbox.mjs";
import { mutateInboxFile } from "../src/action-inbox-store.mjs";
import { AgentJournal } from "../src/journal.mjs";
import { monthlyAuditInboxItem, monthlyAuditSucceeded } from "../src/monthly-audit.mjs";

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.env.PI_WORKBENCH_NODE_PATH || process.execPath;
const stateRoot = process.env.AGENT_JOURNAL_STATE_ROOT ||
  path.join(homedir(), ".agents", "state", "agent-journal");
const vaultRoot = process.env.AGENT_JOURNAL_VAULT_ROOT ||
  path.join(homedir(), "Documents", "Obsidian Vault", "ella.taira", "agent-journal");
const inboxPath = process.env.PI_ACTION_INBOX_PATH ||
  path.join(homedir(), ".agents", "runtime", "pi-pet", "inbox.json");

async function run(args) {
  try {
    const { stdout } = await execute(nodePath, args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20 * 60 * 1000
    });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: Number(error.code) || 1, stdout: String(error.stdout || "") };
  }
}

const journal = new AgentJournal({ vaultRoot, stateRoot });
const maintenance = await journal.maintenanceState();
if (maintenance.completedThrough) {
  await journal.dailyRollupsThrough(maintenance.completedThrough, { limit: 366 });
}

const audit = await run([path.join(repoRoot, "bin", "pi-health-audit.mjs"), "--days", "30", "--write"]);
let parsedAudit = {};
try {
  parsedAudit = JSON.parse(audit.stdout);
} catch {}
const canary = await run([path.join(repoRoot, "bin", "memory-canary.mjs")]);
const testFiles = (await readdir(path.join(repoRoot, "tests")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(repoRoot, "tests", name));
const tests = await run(["--test", ...testFiles]);
const result = {
  auditExit: audit.exit,
  canaryExit: canary.exit,
  testExit: tests.exit,
  issueCount: Array.isArray(parsedAudit.issues) ? parsedAudit.issues.length : 1
};
const succeeded = monthlyAuditSucceeded(result);
await mutateInboxFile(inboxPath, (items) => succeeded
  ? acknowledgeInbox(items, "automation:pi-monthly-health")
  : upsertInboxItem(items, monthlyAuditInboxItem(new Date(), false)));

process.stdout.write(`${JSON.stringify({
  ...result,
  succeeded,
  reportPath: parsedAudit.reportPath ?? null
})}\n`);
if (!succeeded) process.exitCode = 1;
