#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import { selectReviewSession } from "../src/review-surface.mjs";
import { readReviewSessions } from "../src/review-session-registry.mjs";

function currentWorkspaceId() {
  if (process.env.CMUX_WORKSPACE_ID) return process.env.CMUX_WORKSPACE_ID;
  try {
    return execFileSync("cmux", ["current-workspace"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    }).trim();
  } catch {
    return "";
  }
}

async function main() {
  const requested = process.argv[2];
  if (!requested) throw new Error("A file path is required");
  const filePath = path.resolve(requested);
  const registryDir = path.join(
    homedir(),
    ".agents",
    "runtime",
    "pi-review",
    "sessions"
  );
  const sessions = await readReviewSessions(registryDir);
  const selected = selectReviewSession(sessions, {
    workspaceId: currentWorkspaceId(),
    filePath
  });
  if (!selected) throw new Error("No live Pi review session is available");

  const baseUrl = new URL(selected.baseUrl);
  if (
    baseUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(baseUrl.hostname)
  ) {
    throw new Error("Refusing a non-loopback Pi review session");
  }
  const response = await fetch(new URL("/open", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${selected.bridgeToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ path: filePath }),
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Pi review returned ${response.status}`);
  }
}

main().catch((error) => {
  process.stderr.write(`pi-review-open: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
