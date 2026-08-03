const MAX_HISTORY_CHOICES = 30;
const MAX_COMMAND_CHOICES = 20;
const MAX_COMMAND_CHARS = 8_000;
const COMMAND_PREFIX = /^(?:sudo\s+)?(?:git|gh|npm|npx|pnpm|yarn|bun|node|deno|python3?|pip3?|uv|go|cargo|rustup|make|cmake|bazel|dda|docker|podman|kubectl|helm|terraform|ansible|curl|wget|ssh|scp|rsync|cmux|pi|rg|grep|sed|awk|find|ls|cd|pwd|mkdir|touch|chmod|chown|brew|xcodebuild|swift|java|mvn|gradle|gradlew|pytest|jest|vitest)\b|^(?:\.{0,2}\/)[^\s]+/;

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function compactLabel(value, limit = 96) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

export function buildRewindChoices(entries, { limit = MAX_HISTORY_CHOICES } = {}) {
  if (!Array.isArray(entries) || limit <= 0) return [];
  return entries
    .filter(
      (entry) =>
        entry?.type === "message" &&
        entry.message?.role === "user" &&
        textContent(entry.message.content).trim()
    )
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      entryId: entry.id,
      label: `Re-edit from · ${compactLabel(textContent(entry.message.content))}`
    }));
}

export function latestAssistantText(entries) {
  if (!Array.isArray(entries)) return "";
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return textContent(entry.message.content);
    }
  }
  return "";
}

function shellBlockCommands(value) {
  const lines = String(value ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\$\s?/, "").replace(/^\s*>\s?/, ""))
    .filter((line) => line.trim());
  const commands = [];
  let continued = [];
  for (const line of lines) {
    continued.push(line);
    if (/\\\s*$/.test(line)) continue;
    commands.push(continued.join("\n"));
    continued = [];
  }
  if (continued.length) commands.push(continued.join("\n"));
  return commands;
}

export function extractCliCommands(value, { limit = MAX_COMMAND_CHOICES } = {}) {
  const source = String(value ?? "");
  if (!source || limit <= 0) return [];
  const commands = [];
  const seen = new Set();
  const add = (command) => {
    const normalized = String(command ?? "").trim().slice(0, MAX_COMMAND_CHARS);
    if (!normalized || seen.has(normalized) || commands.length >= limit) return;
    seen.add(normalized);
    commands.push(normalized);
  };

  const withoutShellBlocks = source.replace(
    /```(?:bash|sh|shell|zsh|console)\s*\n([\s\S]*?)```/gi,
    (_match, body) => {
      for (const command of shellBlockCommands(body)) add(command);
      return "";
    }
  );
  for (const match of withoutShellBlocks.matchAll(/`([^`\r\n]+)`/g)) {
    const candidate = match[1].trim();
    if (COMMAND_PREFIX.test(candidate)) add(candidate);
  }
  return commands;
}

export function buildCopyChoices(value) {
  const source = String(value ?? "").trim();
  if (!source) return [];
  const choices = extractCliCommands(source).map((command, index) => ({
    command,
    label: `${index === 0 ? "Suggested command" : "Command"} · ${compactLabel(command.split("\n")[0], 100)}`
  }));
  choices.push({ command: source, label: "Entire response" });
  return choices;
}
