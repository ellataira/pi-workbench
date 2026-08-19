const allowedStates = new Set(["approval", "blocked", "completed", "failed"]);
const allowedSources = new Set(["session", "subagent", "automation", "distillation", "mcp"]);
const allowedCodes = new Set([
  "agent-complete",
  "automation-complete",
  "automation-failed",
  "authentication",
  "daily-distillation",
  "external-approval",
  "health-audit",
  "subagent-complete",
  "subagent-failed",
  "tool-error"
]);

const statePriority = {
  failed: 40,
  blocked: 30,
  approval: 20,
  completed: 10
};

export const PET_INBOX_ATTENTION_MS = 15 * 60 * 1000;

function identifier(value, field, maxLength = 160) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim().slice(0, maxLength);
}

function optionalIdentifier(value, maxLength = 160) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, maxLength);
}

function timestamp(value, field) {
  const parsed = new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a timestamp`);
  return parsed.toISOString();
}

export function createInboxItem(value) {
  if (!allowedStates.has(value?.state)) throw new Error("Unsupported inbox state");
  if (!allowedSources.has(value?.source)) throw new Error("Unsupported inbox source");
  if (!allowedCodes.has(value?.code)) throw new Error("Unsupported inbox code");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  const item = {
    id: identifier(value.id, "id"),
    state: value.state,
    source: value.source,
    code: value.code,
    sessionId: optionalIdentifier(value.sessionId),
    workspaceId: optionalIdentifier(value.workspaceId),
    automationId: optionalIdentifier(value.automationId),
    createdAt: timestamp(value.createdAt ?? updatedAt, "createdAt"),
    updatedAt
  };
  return Object.fromEntries(
    Object.entries(item).filter(([, entry]) => entry !== undefined)
  );
}

export function upsertInboxItem(items, value) {
  const item = createInboxItem(value);
  const previous = items.find((candidate) => candidate.id === item.id);
  const next = previous
    ? createInboxItem({ ...item, createdAt: previous.createdAt })
    : item;
  return [...items.filter((candidate) => candidate.id !== next.id), next];
}

export function acknowledgeInbox(items, id) {
  if (id === "all") return [];
  return items.filter((item) => item.id !== id);
}

export function selectInboxItem(items) {
  return [...items].sort((left, right) => {
    const priority = statePriority[right.state] - statePriority[left.state];
    if (priority) return priority;
    return String(right.updatedAt).localeCompare(String(left.updatedAt));
  })[0];
}

export function inboxLabel(item) {
  const labels = {
    "agent-complete": "Session completed",
    "automation-complete": "Automation completed",
    "automation-failed": "Automation failed",
    authentication: "Authentication blocked",
    "daily-distillation": "Daily memory review",
    "external-approval": "Approval needed",
    "health-audit": "Pi health audit",
    "subagent-complete": "Subagent completed",
    "subagent-failed": "Subagent failed",
    "tool-error": "Tool failed"
  };
  return labels[item?.code] ?? "Action needed";
}

export function inboxItemRequiresPetAttention(
  item,
  now = new Date(),
  attentionMs = PET_INBOX_ATTENTION_MS
) {
  const updatedAt = Date.parse(item?.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) return false;
  return Math.max(0, now.getTime() - updatedAt) <= attentionMs;
}

function friendlyAge(updatedAt, now) {
  const elapsed = Math.max(0, now.getTime() - new Date(updatedAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function buildInboxChoices(items, now = new Date()) {
  return [...items]
    .sort((left, right) => {
      const priority = statePriority[right.state] - statePriority[left.state];
      if (priority) return priority;
      return String(right.updatedAt).localeCompare(String(left.updatedAt));
    })
    .map((item) => ({
      id: item.id,
      label:
        `${item.state.replace(/^./, (value) => value.toUpperCase())} · ` +
        `${inboxLabel(item)} · ${friendlyAge(item.updatedAt, now)} · ${item.source}`
    }));
}

export function clearCompletedInbox(items) {
  return items.filter((item) => item.state !== "completed");
}

export function clearStaleInbox(items, now = new Date(), days = 7) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return items.filter(
    (item) =>
      item.state !== "completed" ||
      new Date(item.updatedAt).getTime() >= cutoff
  );
}
