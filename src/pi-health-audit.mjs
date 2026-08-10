function count(target, key, amount = 1) {
  const value = String(key || "unknown").slice(0, 120);
  target[value] = (target[value] ?? 0) + amount;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function emptySummary() {
  return {
    records: 0,
    parseErrors: 0,
    userTurns: 0,
    assistantRuns: 0,
    compactions: 0,
    compactionTokensBefore: 0,
    toolCalls: {},
    toolResults: {},
    stopReasons: {},
    customEntries: {},
    recall: { attempts: 0, results: 0, coldResults: 0 },
    models: {}
  };
}

export function summarizePiJsonl(text, { start, end }) {
  const summary = emptySummary();
  const startMs = start.getTime();
  const endMs = end.getTime();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      summary.parseErrors += 1;
      continue;
    }
    const timestamp = Date.parse(entry.timestamp ?? entry.message?.timestamp ?? "");
    if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp >= endMs) continue;
    summary.records += 1;
    if (entry.type === "compaction") {
      summary.compactions += 1;
      summary.compactionTokensBefore += number(entry.tokensBefore);
    }
    if (entry.type === "custom" && entry.customType) {
      count(summary.customEntries, entry.customType);
      if (entry.customType === "agent-journal-recall-metrics") {
        summary.recall.attempts += 1;
        summary.recall.results += number(entry.data?.resultCount);
        summary.recall.coldResults += number(entry.data?.coldResultCount);
      }
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") summary.userTurns += 1;
    if (message.role === "assistant") {
      summary.assistantRuns += 1;
      count(summary.stopReasons, message.stopReason || "unknown");
      const modelName = String(message.model || "unknown").slice(0, 120);
      const model = summary.models[modelName] ??= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0
      };
      model.calls += 1;
      model.inputTokens += number(message.usage?.input ?? message.usage?.inputTokens);
      model.outputTokens += number(message.usage?.output ?? message.usage?.outputTokens);
      model.cacheReadTokens += number(message.usage?.cacheRead ?? message.usage?.cacheReadTokens);
      model.cacheWriteTokens += number(message.usage?.cacheWrite ?? message.usage?.cacheWriteTokens);
      model.costUsd += number(message.usage?.cost?.total ?? message.usage?.costUsd);
      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item?.type === "toolCall" && item.name) count(summary.toolCalls, item.name);
      }
    }
    if (message.role === "toolResult" && message.toolName) {
      const name = String(message.toolName).slice(0, 120);
      const result = summary.toolResults[name] ??= { success: 0, error: 0 };
      result[message.isError ? "error" : "success"] += 1;
    }
  }
  return summary;
}

export function mergePiUsage(summaries) {
  const merged = emptySummary();
  for (const summary of summaries) {
    for (const key of [
      "records",
      "parseErrors",
      "userTurns",
      "assistantRuns",
      "compactions",
      "compactionTokensBefore"
    ]) merged[key] += number(summary[key]);
    for (const field of ["toolCalls", "stopReasons", "customEntries"]) {
      for (const [key, value] of Object.entries(summary[field] ?? {})) {
        count(merged[field], key, value);
      }
    }
    merged.recall.attempts += number(summary.recall?.attempts);
    merged.recall.results += number(summary.recall?.results);
    merged.recall.coldResults += number(summary.recall?.coldResults);
    for (const [name, result] of Object.entries(summary.toolResults ?? {})) {
      const target = merged.toolResults[name] ??= { success: 0, error: 0 };
      target.success += number(result.success);
      target.error += number(result.error);
    }
    for (const [name, model] of Object.entries(summary.models ?? {})) {
      const target = merged.models[name] ??= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0
      };
      for (const key of Object.keys(target)) target[key] += number(model[key]);
    }
  }
  return merged;
}

export function latestDatedFilename(paths) {
  return paths
    .map((value) => String(value).match(/(\d{4}-\d{2}-\d{2})(?:-[^/]*)?\.md$/)?.[1])
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}
