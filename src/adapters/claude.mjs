import path from "node:path";

import {
  readJsonLines,
  stableCheckpointId,
  usageFromMessages
} from "./common.mjs";

export async function checkpointFromClaudeFile(filePath, options = {}) {
  if (!options.summary) {
    throw new Error("A compressed summary is required; raw Claude session text is never persisted");
  }
  const records = await readJsonLines(filePath);
  const sidechainRecord = records.find((record) => record.isSidechain && record.agentId);
  const baseSessionId =
    records.find((record) => record.sessionId)?.sessionId ?? path.basename(filePath, ".jsonl");
  const agentId = sidechainRecord?.agentId;
  const writeToolNames = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  const usedWriteTool = records.some((record) =>
    Array.isArray(record.message?.content)
      ? record.message.content.some(
          (block) => block?.type === "tool_use" && writeToolNames.has(block.name)
        )
      : false
  );
  const messages = records
    .filter((record) => record.message?.role === "user" || record.message?.role === "assistant")
    .map((record) => ({
      ...record,
      role: record.message.role
    }));
  const users = messages.filter((message) => message.role === "user" && !message.isMeta);
  const assistants = messages.filter((message) => message.role === "assistant");
  const first = records.find((record) => record.sessionId) ?? records[0];
  const lastUser = users.at(-1);
  const lastAssistant = assistants.at(-1);
  const sessionId = agentId ? `${baseSessionId}-agent-${agentId}` : baseSessionId;
  if (!lastUser && !lastAssistant) throw new Error(`Claude session ${sessionId} has no user activity`);

  const timestamp =
    lastAssistant?.timestamp ?? lastUser?.timestamp ?? first?.timestamp ?? new Date().toISOString();
  const cwd = lastAssistant?.cwd ?? lastUser?.cwd ?? first?.cwd ?? "";
  const repository = cwd ? path.basename(cwd) : "";
  const assistantMessages = assistants.map((record) => record.message);

  return {
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    client: "claude",
    sessionId,
    checkpointId:
      lastAssistant?.uuid ?? stableCheckpointId("recovered", timestamp, sessionId),
    checkpointKind: options.checkpointKind ?? "recovered",
    timestamp,
    startedAt: first?.timestamp ?? timestamp,
    cwd,
    repository,
    branch: lastAssistant?.gitBranch ?? lastUser?.gitBranch ?? first?.gitBranch ?? "",
    title: options.title ?? `Claude ${sessionId}`,
    summary: options.summary,
    usage: usageFromMessages(assistantMessages),
    sourcePath: filePath,
    status: options.status ?? "recovered",
    childClass:
      options.childClass ??
      (sidechainRecord ? (usedWriteTool ? "substantial" : "lightweight") : "none"),
    parent:
      options.parent ??
      (sidechainRecord ? { client: "claude", sessionId: baseSessionId } : undefined)
  };
}
