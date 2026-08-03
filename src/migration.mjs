import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { isArtifactReference } from "./schema.mjs";

function frontmatterValue(text, key) {
  const match = String(text).match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].replace(/^["']|["']$/g, "");
  }
}

function frontmatterTags(text) {
  const value = frontmatterValue(text, "tags");
  return Array.isArray(value)
    ? value.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4)
    : [];
}

function safeSessionTitle(text) {
  const client = String(frontmatterValue(text, "client") || "agent");
  const started = String(
    frontmatterValue(text, "started_at") ||
      frontmatterValue(text, "updated_at") ||
      "unknown-date"
  ).slice(0, 10);
  const topics = frontmatterTags(text);
  const label = `${client.charAt(0).toUpperCase()}${client.slice(1)} session ${started}`;
  return topics.length ? `${label} — ${topics.join(", ")}` : label;
}

function ensureRepresentation(text) {
  if (/^representation:\s*compressed-summary-v1\s*$/m.test(text)) return text;
  if (/^schema_version:.*$/m.test(text)) {
    return text.replace(
      /^schema_version:.*$/m,
      (line) => `${line}\nrepresentation: compressed-summary-v1`
    );
  }
  return text.replace(/^---\n/, "---\nrepresentation: compressed-summary-v1\n");
}

function sanitizeArtifacts(text) {
  const lines = text.split("\n");
  let inArtifacts = false;
  let removed = 0;
  const output = [];
  for (const line of lines) {
    if (/^\*\*Artifacts:\*\*\s*$/.test(line)) {
      inArtifacts = true;
      output.push(line);
      continue;
    }
    if (
      inArtifacts &&
      (/^\*\*[A-Za-z ]+:\*\*/.test(line) || /^#{1,3}\s+/.test(line))
    ) {
      inArtifacts = false;
    }
    if (inArtifacts && /^[-*]\s+/.test(line)) {
      const value = line.replace(/^[-*]\s+/, "").trim();
      if (!isArtifactReference(value)) {
        removed += 1;
        continue;
      }
    }
    output.push(line);
  }
  return { text: output.join("\n"), removed };
}

const summaryFallbacks = {
  Goal: "Coordinate a delegated agent task.",
  Outcome: "Delegated task activity recorded.",
  Decisions: "No durable decision recorded.",
  "Open items": "Review linked artifacts if needed."
};

function sanitizeTaskShapedSummaries(text) {
  let sanitized = 0;
  const output = text.replace(
    /^\*\*(Goal|Outcome|Decisions|Open items):\*\*\s+(.+)$/gm,
    (line, field, value) => {
      const taskShaped =
        /\b(?:with (?:this|the) task|task|prompt)\s*:/i.test(value) ||
        /\buse (?:the |a )?(?:subagent|agent|tool)\b.*\b(?:run|ask|tell|have)\b/i.test(
          value
        );
      if (!taskShaped) return line;
      sanitized += 1;
      return `**${field}:** ${summaryFallbacks[field]}`;
    }
  );
  return { text: output, sanitized };
}

export function sanitizeJournalNote(input) {
  const original = String(input);
  let text = ensureRepresentation(original);
  const title = safeSessionTitle(text);
  text = text.replace(/^#\s+.*$/m, `# ${title}`);
  text = text.replace(
    /^## Lightweight child: .*?: (\d{4}-\d{2}-\d{2}T[^\s]+)$/gm,
    "## Lightweight child: $1"
  );
  text = text.replace(
    /^(- Child session: )\[.*?\](\([^)]+\))$/gm,
    "$1[Linked child session]$2"
  );
  const artifacts = sanitizeArtifacts(text);
  text = artifacts.text;
  const summaries = sanitizeTaskShapedSummaries(text);
  text = summaries.text;
  return {
    text,
    changed: text !== original,
    removedArtifacts: artifacts.removed,
    sanitizedSummaries: summaries.sanitized
  };
}

export function sanitizeMemoryNote(input) {
  const original = String(input);
  const text = ensureRepresentation(original);
  return { text, changed: text !== original };
}

async function markdownFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
    }
  }
  return files.sort();
}

async function atomicWriteInPlace(targetPath, text) {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, targetPath);
  await chmod(targetPath, 0o600);
}

function journalIdentity(text) {
  return String(frontmatterValue(text, "journal_id") || "");
}

function checkpointBlocks(text) {
  const first = text.search(/^<!-- agent-journal(?:-child)?:/m);
  if (first < 0) return [];
  return text
    .slice(first)
    .split(/(?=^<!-- agent-journal(?:-child)?:)/m)
    .map((block) => block.trim())
    .filter(Boolean);
}

async function mergeDuplicateSessions(sessionFiles) {
  const byIdentity = new Map();
  for (const notePath of sessionFiles) {
    const text = await readFile(notePath, "utf8");
    const identity = journalIdentity(text);
    if (!identity) continue;
    const group = byIdentity.get(identity) ?? [];
    group.push({ notePath, text });
    byIdentity.set(identity, group);
  }
  let duplicateFilesMerged = 0;
  for (const [identity, group] of byIdentity) {
    if (group.length < 2) continue;
    const sessionId = identity.split(":", 2)[1] ?? "";
    const canonical =
      group.find(({ notePath }) => path.basename(notePath).includes(sessionId)) ??
      [...group].sort((left, right) =>
        left.notePath.localeCompare(right.notePath)
      )[0];
    let combined = canonical.text.trimEnd();
    for (const item of group) {
      if (item.notePath === canonical.notePath) continue;
      for (const block of checkpointBlocks(item.text)) {
        const marker = block.match(/^<!-- ([^>]+) -->/)?.[1];
        if (marker && combined.includes(`<!-- ${marker} -->`)) continue;
        combined = `${combined}\n\n${block}`;
      }
      await rm(item.notePath);
      duplicateFilesMerged += 1;
    }
    await atomicWriteInPlace(canonical.notePath, `${combined}\n`);
  }
  return duplicateFilesMerged;
}

export async function migrateJournalStorage({ sessionsRoot, memoryRoot }) {
  const sessionFiles = await markdownFiles(sessionsRoot);
  const memoryFiles = memoryRoot ? await markdownFiles(memoryRoot) : [];
  let changed = 0;
  let removedArtifacts = 0;
  let sanitizedSummaries = 0;
  for (const notePath of sessionFiles) {
    const result = sanitizeJournalNote(await readFile(notePath, "utf8"));
    removedArtifacts += result.removedArtifacts;
    sanitizedSummaries += result.sanitizedSummaries;
    if (!result.changed) continue;
    await atomicWriteInPlace(notePath, result.text);
    changed += 1;
  }
  for (const notePath of memoryFiles) {
    const result = sanitizeMemoryNote(await readFile(notePath, "utf8"));
    if (!result.changed) continue;
    await atomicWriteInPlace(notePath, result.text);
    changed += 1;
  }
  const duplicateFilesMerged = await mergeDuplicateSessions(sessionFiles);
  return {
    scanned: sessionFiles.length + memoryFiles.length,
    changed,
    removedArtifacts,
    sanitizedSummaries,
    duplicateFilesMerged
  };
}
