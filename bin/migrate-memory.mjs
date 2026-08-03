#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { AgentJournal } from "../src/journal.mjs";
import { migrateJournalStorage } from "../src/migration.mjs";

if (!process.argv.includes("--apply")) {
  throw new Error("usage: migrate-memory --apply");
}

const vaultRoot =
  process.env.AGENT_JOURNAL_VAULT_ROOT ??
  path.join(
    homedir(),
    "Documents",
    "Obsidian Vault",
    "ella.taira",
    "agent-journal"
  );
const stateRoot =
  process.env.AGENT_JOURNAL_STATE_ROOT ??
  path.join(homedir(), ".agents", "state", "agent-journal");
const journal = new AgentJournal({ vaultRoot, stateRoot });
const migration = await migrateJournalStorage({
  sessionsRoot: path.join(vaultRoot, "sessions"),
  memoryRoot: path.join(vaultRoot, "memory")
});
const rebuilt = await journal.rebuildIndexFromDisk();

process.stdout.write(
  `${JSON.stringify(
    {
      migration,
      rebuilt,
      rawContentBackupCreated: false
    },
    null,
    2
  )}\n`
);
