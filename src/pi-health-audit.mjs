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

function explicitMetricOrLegacy(summary, metric, tool) {
  const explicit = summary.customEntries?.[metric];
  return explicit === undefined ? number(summary.toolCalls?.[tool]) : number(explicit);
}

export function buildFeatureUsage(summary) {
  return {
    checkpoint: number(summary.toolCalls?.journal_checkpoint),
    dailyReview: number(summary.toolCalls?.journal_distillation_complete),
    recall: number(summary.recall?.attempts),
    pairTerminal: explicitMetricOrLegacy(summary, "pi-pair-open-metrics", "pair_terminal"),
    reviewUi: explicitMetricOrLegacy(summary, "pi-review-open-metrics", "review_open"),
    subagents: number(summary.toolCalls?.subagent),
    cmuxChildren: number(summary.toolCalls?.cmux_session),
    mcp: number(summary.toolCalls?.mcp)
  };
}

function toolRate(summary, name) {
  const result = summary.toolResults?.[name] ?? {};
  const success = number(result.success);
  const error = number(result.error);
  const total = success + error;
  return { success, error, total, errorRate: total ? error / total : 0 };
}

export function evaluatePiHealth(summary, { minimumToolSamples = 25 } = {}) {
  const watchedTools = {
    journal_checkpoint: { threshold: 0.05, label: "Checkpoint" },
    cmux_session: { threshold: 0.1, label: "cmux_session" },
    ctx_execute_file: { threshold: 0.1, label: "ctx_execute_file" },
    ctx_fetch_and_index: { threshold: 0.15, label: "ctx_fetch_and_index" }
  };
  const toolRates = Object.fromEntries(
    Object.keys(watchedTools).map((name) => [name, toolRate(summary, name)])
  );
  const assistantRuns = number(summary.assistantRuns);
  const userTurns = number(summary.userTurns);
  const lengthStops = number(summary.stopReasons?.length);
  const rates = {
    checkpointErrorRate: toolRates.journal_checkpoint.errorRate,
    cmuxSessionErrorRate: toolRates.cmux_session.errorRate,
    contextExecuteFileErrorRate: toolRates.ctx_execute_file.errorRate,
    contextFetchIndexErrorRate: toolRates.ctx_fetch_and_index.errorRate,
    lengthStopRate: assistantRuns ? lengthStops / assistantRuns : 0,
    compactionsPerUserTurn: userTurns ? number(summary.compactions) / userTurns : 0
  };
  const issues = [];
  for (const [name, policy] of Object.entries(watchedTools)) {
    const rate = toolRates[name];
    if (rate.total >= minimumToolSamples && rate.errorRate >= policy.threshold) {
      issues.push(
        `${policy.label} error rate is ${(rate.errorRate * 100).toFixed(1)}% (${rate.error}/${rate.total})`
      );
    }
  }
  if (assistantRuns >= 100 && lengthStops >= 3 && rates.lengthStopRate >= 0.005) {
    issues.push(
      `Maximum-length stops are ${(rates.lengthStopRate * 100).toFixed(1)}% of assistant runs (${lengthStops}/${assistantRuns})`
    );
  }
  if (userTurns >= 30 && number(summary.compactions) >= 3 && rates.compactionsPerUserTurn >= 0.03) {
    issues.push(
      `Compactions are ${(rates.compactionsPerUserTurn * 100).toFixed(1)}% of user turns (${number(summary.compactions)}/${userTurns})`
    );
  }
  return { rates, toolRates, issues };
}

function isoDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) {
    throw new TypeError(`${field} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== value) throw new TypeError(`${field} is invalid`);
  return date;
}

export function rollupDatesThrough(latestDate, targetDate, { limit = 31, firstDate } = {}) {
  const target = isoDate(targetDate, "targetDate");
  const start = latestDate
    ? new Date(isoDate(latestDate, "latestDate").getTime() + 86_400_000)
    : isoDate(firstDate ?? targetDate, "firstDate");
  const boundedLimit = Math.min(366, Math.max(1, Number(limit) || 31));
  const dates = [];
  for (let cursor = start; cursor <= target && dates.length < boundedLimit; cursor = new Date(cursor.getTime() + 86_400_000)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}
