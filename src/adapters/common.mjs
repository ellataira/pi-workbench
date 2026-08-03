import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import readline from "node:readline";

export async function readJsonLines(filePath) {
  const records = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
  return records;
}

export function stableCheckpointId(prefix, timestamp, text) {
  const digest = createHash("sha256")
    .update(`${timestamp}\0${text}`)
    .digest("hex")
    .slice(0, 16);
  return `${prefix}-${digest}`;
}

export function usageFromMessages(messages) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    model: ""
  };
  for (const message of messages) {
    const usage = message?.usage ?? {};
    total.inputTokens += Number(usage.input ?? usage.input_tokens ?? 0);
    total.outputTokens += Number(usage.output ?? usage.output_tokens ?? 0);
    total.cacheReadTokens += Number(
      usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0
    );
    total.cacheWriteTokens += Number(
      usage.cacheWrite ?? usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0
    );
    total.costUsd += Number(
      usage.cost?.total ?? usage.cost ?? usage.costUsd ?? usage.cost_usd ?? 0
    );
    if (message?.model && message.model !== "<synthetic>") total.model = message.model;
  }
  return total;
}
