#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";

import {
  acknowledgeInbox,
  selectInboxItem,
  upsertInboxItem
} from "../src/action-inbox.mjs";
import {
  mutateInboxFile,
  readInboxFile
} from "../src/action-inbox-store.mjs";

const inboxPath =
  process.env.PI_ACTION_INBOX_PATH ??
  path.join(homedir(), ".agents", "runtime", "pi-pet", "inbox.json");
const [command, ...args] = process.argv.slice(2);

let items;
if (command === "upsert") {
  const [id, state, source, code, sessionId, workspaceId, automationId] = args;
  if (!id || !state || !source || !code) {
    throw new Error(
      "Usage: action-inbox upsert <id> <state> <source> <code> [session-id] [workspace-id] [automation-id]"
    );
  }
  items = await mutateInboxFile(inboxPath, (current) =>
    upsertInboxItem(current, {
      id,
      state,
      source,
      code,
      sessionId,
      workspaceId,
      automationId,
      updatedAt: new Date().toISOString()
    })
  );
} else if (command === "acknowledge") {
  const [id] = args;
  if (!id) throw new Error("Usage: action-inbox acknowledge <id|all>");
  items = await mutateInboxFile(inboxPath, (current) =>
    acknowledgeInbox(current, id)
  );
} else if (command === "list" || !command) {
  items = await readInboxFile(inboxPath);
} else {
  throw new Error("Usage: action-inbox <list|upsert|acknowledge>");
}

process.stdout.write(`${JSON.stringify({ items, next: selectInboxItem(items) }, null, 2)}\n`);
