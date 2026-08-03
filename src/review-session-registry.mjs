import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const SESSION_FIELDS = [
  "schemaVersion",
  "sessionId",
  "pid",
  "cwd",
  "workspaceId",
  "surfaceId",
  "baseUrl",
  "bridgeToken",
  "updatedAt"
];

function registryFilePath(registryDir, sessionId) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24);
  return path.join(registryDir, `${key}.json`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSession(value) {
  const result = {};
  for (const field of SESSION_FIELDS) result[field] = value?.[field];
  return result;
}

export async function writeReviewSession(registryDir, value) {
  if (!value?.sessionId || !Number.isInteger(value?.pid) || value.pid < 1) {
    throw new Error("Review session requires a sessionId and positive pid");
  }
  await mkdir(registryDir, { recursive: true, mode: 0o700 });
  await chmod(registryDir, 0o700);
  const target = registryFilePath(registryDir, value.sessionId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(sanitizeSession(value), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return target;
}

export async function readReviewSessions(registryDir, {
  now = new Date(),
  maxAgeMs = 24 * 60 * 60 * 1000,
  isProcessAlive = processIsAlive
} = {}) {
  let names;
  try {
    names = await readdir(registryDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(registryDir, name), "utf8"));
      const age = now.getTime() - new Date(parsed.updatedAt).getTime();
      if (
        parsed.schemaVersion === 1 &&
        parsed.sessionId &&
        Number.isInteger(parsed.pid) &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= maxAgeMs &&
        isProcessAlive(parsed.pid)
      ) {
        sessions.push(sanitizeSession(parsed));
      }
    } catch {
      // Ignore incomplete or invalid registry entries from interrupted sessions.
    }
  }
  return sessions.sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
}

export async function removeReviewSession(registryDir, sessionId) {
  try {
    await unlink(registryFilePath(registryDir, sessionId));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
