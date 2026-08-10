#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { upsertInboxItem } from "../src/action-inbox.mjs";
import { mutateInboxFile } from "../src/action-inbox-store.mjs";
import {
  dailyReviewReminder,
  sendDailyReviewNotification
} from "../src/daily-review-reminder.mjs";

const execute = promisify(execFile);
const stateRoot =
  process.env.AGENT_JOURNAL_STATE_ROOT ??
  path.join(homedir(), ".agents", "state", "agent-journal");
const maintenancePath = path.join(stateRoot, "maintenance.json");
const inboxPath =
  process.env.PI_ACTION_INBOX_PATH ??
  path.join(homedir(), ".agents", "runtime", "pi-pet", "inbox.json");

let state = {};
try {
  state = JSON.parse(await readFile(maintenancePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
}

const reminder = dailyReviewReminder(new Date(), state);
if (!reminder) {
  process.stdout.write('{"due":false}\n');
  process.exit(0);
}

await mutateInboxFile(inboxPath, (current) =>
  upsertInboxItem(current, reminder)
);
const notified = await sendDailyReviewNotification(reminder, execute);
process.stdout.write(
  `${JSON.stringify({ due: true, id: reminder.id, notified })}\n`
);
