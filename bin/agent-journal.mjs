#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { AgentJournal } from "../src/journal.mjs";

function expand(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function journalFromEnvironment() {
  return new AgentJournal({
    vaultRoot: expand(
      process.env.AGENT_JOURNAL_VAULT_ROOT ??
        "~/Documents/Obsidian Vault/ella.taira/agent-journal"
    ),
    stateRoot: expand(process.env.AGENT_JOURNAL_STATE_ROOT ?? "~/.agents/state/agent-journal")
  });
}

async function stdinJson() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const journal = journalFromEnvironment();

  switch (command) {
    case "ingest": {
      const result = await journal.ingest(await stdinJson());
      console.log(JSON.stringify(result));
      break;
    }
    case "recall": {
      const query = args.join(" ").trim();
      if (!query) throw new Error("usage: agent-journal recall <query>");
      const options = {
        repository: process.env.AGENT_JOURNAL_REPOSITORY,
        cwd: process.env.AGENT_JOURNAL_CWD,
        automatic: process.env.AGENT_JOURNAL_AUTOMATIC === "1",
        limit: Number(process.env.AGENT_JOURNAL_LIMIT ?? 3),
        tokenBudget: Number(process.env.AGENT_JOURNAL_TOKEN_BUDGET ?? 1200)
      };
      console.log(JSON.stringify(await journal.recall(query, options), null, 2));
      break;
    }
    case "promote": {
      console.log(JSON.stringify(await journal.promote(await stdinJson()), null, 2));
      break;
    }
    case "rollup": {
      console.log(JSON.stringify(await journal.dailyRollup(args[0]), null, 2));
      break;
    }
    case "reindex": {
      console.log(JSON.stringify(await journal.reindexTopics(), null, 2));
      break;
    }
    default:
      throw new Error(
        "usage: agent-journal <ingest|recall|promote|rollup|reindex> [arguments]"
      );
  }
}

main().catch((error) => {
  console.error(`agent-journal: ${error.message}`);
  process.exitCode = 1;
});
