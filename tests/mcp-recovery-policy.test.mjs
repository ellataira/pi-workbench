import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  connectorRecoveryInstructions,
  shouldInjectConnectorRecovery
} from "../src/mcp-recovery-policy.mjs";

test("connector recovery guidance is injected only for connector-shaped work", () => {
  for (const prompt of [
    "Search Confluence for the design",
    "Fix the Atlassian MCP auth",
    "Find this in Slack",
    "Retrieve the Drive archive",
    "Query Jira for the issue"
  ]) {
    assert.equal(shouldInjectConnectorRecovery(prompt), true, prompt);
  }

  assert.equal(shouldInjectConnectorRecovery("Explain this Go function"), false);
  assert.equal(shouldInjectConnectorRecovery("hi"), false);
});

test("connector recovery diagnoses, repairs, and proves the real operation", () => {
  const instructions = connectorRecoveryInstructions();

  assert.match(instructions, /transport.*tool call/i);
  assert.match(instructions, /official.*documentation|discovery metadata/i);
  assert.match(instructions, /stdio bridge/i);
  assert.match(instructions, /minimal.*reversible/i);
  assert.match(instructions, /read-only tool call/i);
  assert.match(instructions, /browser consent/i);
  assert.match(instructions, /never expose.*token/i);
});

test("connector recovery is registered and documented", async () => {
  const [packageJson, quickstart] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../QUICKSTART.md", import.meta.url), "utf8")
  ]);

  assert.ok(
    packageJson.pi.extensions.includes("./extensions/pi-mcp-recovery.ts")
  );
  assert.match(quickstart, /automatic connector recovery/i);
});
