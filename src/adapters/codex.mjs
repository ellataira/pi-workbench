import path from "node:path";

import {
  readJsonLines,
  stableCheckpointId
} from "./common.mjs";

export async function checkpointFromCodexFile(filePath, options = {}) {
  if (!options.summary) {
    throw new Error("A compressed summary is required; raw Codex session text is never persisted");
  }
  const records = await readJsonLines(filePath);
  const metadata = records.find((record) => record.type === "session_meta")?.payload;
  if (!metadata?.id) throw new Error(`Codex session metadata is missing in ${filePath}`);
  if (metadata.thread_source && metadata.thread_source !== "user") {
    throw new Error(`Codex session ${metadata.id} is not a canonical user session`);
  }

  const messages = records
    .filter((record) => record.type === "response_item" && record.payload?.type === "message")
    .filter((record) => record.payload.role === "user" || record.payload.role === "assistant")
    .map((record) => ({
      role: record.payload.role,
      timestamp: record.timestamp
    }));
  const users = messages.filter((message) => message.role === "user");
  const assistants = messages.filter((message) => message.role === "assistant");
  const lastUser = users.at(-1);
  const lastAssistant = assistants.at(-1);
  if (!lastUser && !lastAssistant) throw new Error(`Codex session ${metadata.id} has no user activity`);

  const timestamp = lastAssistant?.timestamp ?? lastUser?.timestamp ?? metadata.timestamp;
  const cwd = metadata.cwd ?? "";
  const repository = cwd ? path.basename(cwd) : "";

  return {
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    client: "codex",
    sessionId: metadata.id,
    checkpointId: stableCheckpointId("recovered", timestamp, metadata.id),
    checkpointKind: options.checkpointKind ?? "recovered",
    timestamp,
    startedAt: metadata.timestamp ?? records[0]?.timestamp ?? timestamp,
    cwd,
    repository,
    branch: options.branch ?? "",
    title: options.title ?? `Codex ${metadata.id}`,
    summary: options.summary,
    usage: options.usage ?? {},
    sourcePath: filePath,
    status: options.status ?? "recovered",
    childClass: options.childClass ?? "none",
    parent: options.parent
  };
}
