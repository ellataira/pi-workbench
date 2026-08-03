import path from "node:path";

import {
  readJsonLines,
  stableCheckpointId,
  usageFromMessages
} from "./common.mjs";
import {
  compressedTitle,
  summaryCopiesConversation
} from "../pi-memory-policy.mjs";

export function classifyPiChildEnvironment(environment = process.env) {
  const explicitParentClient = environment.AGENT_JOURNAL_PARENT_CLIENT;
  const explicitParentSession = environment.AGENT_JOURNAL_PARENT_SESSION_ID;
  if (explicitParentClient && explicitParentSession) {
    return {
      parent: { client: explicitParentClient, sessionId: explicitParentSession },
      childClass:
        environment.AGENT_JOURNAL_CHILD_CLASS === "lightweight" ? "lightweight" : "substantial"
    };
  }
  if (environment.PI_SUBAGENT_CHILD !== "1" || !environment.PI_SUBAGENT_PARENT_SESSION) {
    return { parent: undefined, childClass: "none" };
  }
  const agent = environment.PI_SUBAGENT_CHILD_AGENT ?? "";
  return {
    parent: { client: "pi", sessionId: environment.PI_SUBAGENT_PARENT_SESSION },
    childClass: /(writer|worker|implement|fix|builder|executor)/i.test(agent)
      ? "substantial"
      : "lightweight"
  };
}

export async function checkpointFromPiFile(filePath, options = {}) {
  const records = await readJsonLines(filePath);
  const header = records.find((entry) => entry.type === "session");
  if (!header?.id) throw new Error(`Pi session metadata is missing in ${filePath}`);
  return checkpointFromPiEntries(
    records.filter((entry) => entry.type !== "session"),
    {
      sessionId: header.id,
      startedAt: header.timestamp,
      cwd: header.cwd ?? "",
      sourcePath: filePath,
      checkpointKind: options.checkpointKind ?? "recovered",
      status: options.status ?? "recovered",
      title: options.title,
      summary: options.summary,
      parent: options.parent,
      childClass: options.childClass
    }
  );
}

export function checkpointFromPiEntries(entries, options) {
  if (!options?.summary) {
    throw new Error("A compressed summary is required; raw Pi session text is never persisted");
  }
  if (summaryCopiesConversation(options.summary, entries)) {
    throw new Error("Compressed summary copies raw conversation content; paraphrase before persisting");
  }
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => ({
      ...entry,
      role: entry.message?.role
    }))
    .filter((entry) => entry.role === "user" || entry.role === "assistant");
  const users = messages.filter((message) => message.role === "user");
  const assistants = messages.filter((message) => message.role === "assistant");
  const lastUser = users.at(-1);
  const lastAssistant = assistants.at(-1);
  const timestamp =
    lastAssistant?.timestamp ?? lastUser?.timestamp ?? options.timestamp ?? new Date().toISOString();
  const cwd = options.cwd ?? "";
  const repository = options.repository ?? (cwd ? path.basename(cwd) : "");

  return {
    schemaVersion: 1,
    representation: "compressed-summary-v1",
    client: "pi",
    sessionId: options.sessionId,
    checkpointId:
      options.checkpointId ??
      lastAssistant?.id ??
      stableCheckpointId(options.checkpointKind ?? "checkpoint", timestamp, options.sessionId),
    checkpointKind: options.checkpointKind ?? "settled",
    timestamp,
    startedAt: options.startedAt ?? entries[0]?.timestamp ?? timestamp,
    cwd,
    repository,
    branch: options.branch ?? "",
    title: compressedTitle(options.summary, `Pi ${options.sessionId}`),
    summary: options.summary,
    usage: options.usage ?? usageFromMessages(assistants.map((record) => record.message)),
    sourcePath: options.sourcePath ?? "",
    status: options.status ?? "recorded",
    childClass: options.childClass ?? "none",
    parent: options.parent
  };
}
