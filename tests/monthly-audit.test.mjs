import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { monthlyAuditInboxItem, monthlyAuditSucceeded } from "../src/monthly-audit.mjs";

test("monthly audit succeeds only when audit, canary, and tests all pass cleanly", () => {
  assert.equal(monthlyAuditSucceeded({ auditExit: 0, canaryExit: 0, testExit: 0, issueCount: 0 }), true);
  assert.equal(monthlyAuditSucceeded({ auditExit: 0, canaryExit: 0, testExit: 0, issueCount: 1 }), false);
  assert.equal(monthlyAuditSucceeded({ auditExit: 0, canaryExit: 1, testExit: 0, issueCount: 0 }), false);
});

test("monthly audit inbox records fixed actionable metadata only", () => {
  const item = monthlyAuditInboxItem(new Date("2026-08-13T12:00:00.000Z"), false);
  assert.deepEqual(
    { id: item.id, state: item.state, source: item.source, code: item.code, automationId: item.automationId },
    {
      id: "automation:pi-monthly-health",
      state: "failed",
      source: "automation",
      code: "health-audit",
      automationId: "pi-monthly-health"
    }
  );
  assert.doesNotMatch(JSON.stringify(item), /prompt|response|transcript|message|output/i);
});

test("monthly launchd job runs on the first day at 10am", async () => {
  const plist = await readFile(new URL("../launchd/com.ellataira.pi-monthly-health.plist", import.meta.url), "utf8");
  assert.match(plist, new RegExp("<key>Day</key>\\s*<integer>1</integer>"));
  assert.match(plist, new RegExp("<key>Hour</key>\\s*<integer>10</integer>"));
  assert.match(plist, /monthly-health-runner\.mjs/);
});

test("monthly audit install and privacy contract are documented in both guides", async () => {
  const [readme, quickstart] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../QUICKSTART.md", import.meta.url), "utf8")
  ]);
  for (const guide of [readme, quickstart]) {
    assert.match(guide, /install:monthly-audit/);
    assert.match(guide, /first day of each month/);
    assert.match(guide, /no prompts|never stores prompts|contain no\s+prompts/i);
  }
});
