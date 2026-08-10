const CLIENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/;
const CHECKPOINT_KINDS = new Set([
  "settled",
  "compaction",
  "checkpoint",
  "shutdown",
  "recovered",
  "child-completed"
]);
const CHILD_CLASSES = new Set(["none", "lightweight", "substantial"]);
const FORBIDDEN_KEYS = new Set([
  "transcript",
  "messages",
  "rawtranscript",
  "prompt",
  "response",
  "completion",
  "conversation",
  "turns"
]);
const MAX_SUMMARY_CHARS = 12_000;
const REPRESENTATION = "compressed-summary-v1";
const ARTIFACT_REFERENCE =
  /^(?:(?:~?\/|\.{1,2}\/|[a-zA-Z0-9_.-]+\/)[^\r\n]+|https?:\/\/\S+|(?:PR|JIRA|DOC|NOTE|FILE)#?[a-zA-Z0-9._-]+|[a-zA-Z0-9_.-]+\.(?:md|txt|json|ya?ml|toml|go|rs|py|[cm]?[jt]sx?|java|kt|swift|rb|sh|sql|html?|css|scss|pdf|docx?|pptx?|xlsx?)(?::\d+)?)$/i;

function slug(value, fallback = "unknown") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function strings(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function containsForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
    if (containsForbiddenKey(child)) return true;
  }
  return false;
}

export function containsRoleLabelTranscript(value) {
  const strings = [];
  function visit(child) {
    if (typeof child === "string") {
      strings.push(child);
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) visit(item);
      return;
    }
    if (child && typeof child === "object") {
      for (const item of Object.values(child)) visit(item);
    }
  }
  visit(value);
  return strings.some((text) => {
    const roles = text.match(/^(?:user|assistant|system|human|tool)\s*:/gim) ?? [];
    return roles.length >= 2 || /<\|(?:im_start|im_end)\|>/.test(text);
  });
}

export function isArtifactReference(value) {
  return (
    typeof value === "string" &&
    value.length <= 800 &&
    ARTIFACT_REFERENCE.test(value.trim())
  );
}

export function sanitizeArtifactReferences(values) {
  const candidates = Array.isArray(values) ? values.slice(0, 12) : [];
  const artifacts = candidates
    .filter(isArtifactReference)
    .map((value) => value.trim());
  return {
    artifacts,
    discardedArtifactCount: candidates.length - artifacts.length
  };
}

function summaryChars(summary) {
  return JSON.stringify(summary ?? {}).length;
}

export function normalizeCheckpoint(input) {
  const client = slug(input?.client);
  const sessionId = cleanId(input?.sessionId);
  const checkpointId = cleanId(input?.checkpointId);
  const tags = [...new Set(strings(input?.summary?.tags, 12).map((tag) => slug(tag)))].slice(0, 4);
  const parent =
    input?.parent && input.parent.client && input.parent.sessionId
      ? {
          client: slug(input.parent.client),
          sessionId: cleanId(input.parent.sessionId)
        }
      : undefined;

  const value = {
    schemaVersion: 1,
    representation: input?.representation,
    client,
    sessionId,
    checkpointId,
    checkpointKind: String(input?.checkpointKind ?? "checkpoint").trim().toLowerCase(),
    timestamp: String(input?.timestamp ?? ""),
    startedAt: String(input?.startedAt ?? input?.timestamp ?? ""),
    cwd: typeof input?.cwd === "string" ? input.cwd : "",
    repository: typeof input?.repository === "string" ? input.repository.trim() : "",
    branch: typeof input?.branch === "string" ? input.branch.trim() : "",
    title:
      typeof input?.summary?.goal === "string" && input.summary.goal.trim()
        ? input.summary.goal.trim().slice(0, 240)
        : `${client} session ${sessionId || "unknown"}`,
    summary: {
      goal: typeof input?.summary?.goal === "string" ? input.summary.goal.trim() : "",
      outcomes: strings(input?.summary?.outcomes),
      decisions: strings(input?.summary?.decisions),
      nextSteps: strings(input?.summary?.nextSteps),
      artifacts: strings(input?.summary?.artifacts),
      tags
    },
    usage: {
      inputTokens: Number(input?.usage?.inputTokens ?? 0),
      outputTokens: Number(input?.usage?.outputTokens ?? 0),
      cacheReadTokens: Number(input?.usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(input?.usage?.cacheWriteTokens ?? 0),
      costUsd: Number(input?.usage?.costUsd ?? 0),
      model: typeof input?.usage?.model === "string" ? input.usage.model : ""
    },
    parent,
    childClass: CHILD_CLASSES.has(input?.childClass) ? input.childClass : "none",
    sourcePath: typeof input?.sourcePath === "string" ? input.sourcePath : "",
    status: typeof input?.status === "string" ? input.status : ""
  };

  value.identity = `${value.client}:${value.sessionId}`;
  value.idempotencyKey = `${value.identity}:${value.checkpointId}`;
  return value;
}

export function validateCheckpoint(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["checkpoint must be an object"] };
  }
  if (containsForbiddenKey(input)) {
    errors.push("raw conversation content fields are forbidden");
  }
  if (containsRoleLabelTranscript(input?.summary)) {
    errors.push("role-labelled transcript text is forbidden");
  }

  const value = normalizeCheckpoint(input);
  if (input.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (input.representation !== REPRESENTATION) {
    errors.push(`representation must be ${REPRESENTATION}`);
  }
  if (!CLIENT_PATTERN.test(value.client)) errors.push("client is invalid");
  if (!ID_PATTERN.test(value.sessionId)) errors.push("sessionId is invalid");
  if (!ID_PATTERN.test(value.checkpointId)) errors.push("checkpointId is invalid");
  if (!CHECKPOINT_KINDS.has(value.checkpointKind)) errors.push("checkpointKind is invalid");
  if (Number.isNaN(Date.parse(value.timestamp))) errors.push("timestamp is invalid");
  if (Number.isNaN(Date.parse(value.startedAt))) errors.push("startedAt is invalid");
  if (!value.summary.goal && value.summary.outcomes.length === 0) {
    errors.push("summary must include a goal or outcome");
  }
  if (summaryChars(value.summary) > MAX_SUMMARY_CHARS) {
    errors.push("summary is too large");
  }
  if (value.summary.artifacts.some((artifact) => !isArtifactReference(artifact))) {
    errors.push("summary artifacts must contain artifact references, not prose");
  }
  for (const [key, number] of Object.entries(value.usage)) {
    if (key === "model") continue;
    if (!Number.isFinite(number) || number < 0) errors.push(`usage.${key} must be non-negative`);
  }
  if (value.parent && !ID_PATTERN.test(value.parent.sessionId)) {
    errors.push("parent.sessionId is invalid");
  }

  return { ok: errors.length === 0, errors, value };
}

export function validateMemoryPromotion(input) {
  const errors = [];
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const content = typeof input?.content === "string" ? input.content.trim() : "";
  if (!title || !content) errors.push("promotion requires title and content");
  if (title.length > 240 || /[\r\n]/.test(title)) {
    errors.push("promotion title must be one bounded line");
  }
  if (content.length > 4_000) errors.push("promotion content exceeds 4000 characters");
  if (containsRoleLabelTranscript({ title, content })) {
    errors.push("promotion contains transcript-shaped text");
  }
  if (/<\|(?:im_start|im_end)\|>/.test(content)) {
    errors.push("promotion contains transcript delimiters");
  }
  return {
    ok: errors.length === 0,
    errors,
    value: { title, content, representation: REPRESENTATION }
  };
}

export const schemaLimits = Object.freeze({
  maxSummaryChars: MAX_SUMMARY_CHARS,
  maxTags: 4,
  representation: REPRESENTATION
});
