import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { createInboxItem } from "./action-inbox.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function readInboxFile(inboxPath) {
  try {
    const parsed = JSON.parse(await readFile(inboxPath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return [];
    return parsed.items.flatMap((item) => {
      try {
        return [createInboxItem(item)];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeInboxFile(inboxPath, items) {
  await mkdir(path.dirname(inboxPath), { recursive: true, mode: 0o700 });
  const temporary = `${inboxPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, items }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await rename(temporary, inboxPath);
  await chmod(inboxPath, 0o600);
}

export async function mutateInboxFile(
  inboxPath,
  update,
  { timeoutMs = 2000, retryMs = 20 } = {}
) {
  await mkdir(path.dirname(inboxPath), { recursive: true, mode: 0o700 });
  const lockPath = `${inboxPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Action inbox is busy");
      await sleep(retryMs);
    }
  }
  try {
    const next = update(await readInboxFile(inboxPath));
    await writeInboxFile(inboxPath, next);
    return next;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
