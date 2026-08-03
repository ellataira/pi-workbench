import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { dailyReviewReminder } from "../src/daily-review-reminder.mjs";

test("9am reminder creates fixed metadata without session text", () => {
  const before = dailyReviewReminder(
    new Date("2026-07-30T12:59:00.000Z"),
    { completedThrough: "2026-07-28" }
  );
  assert.equal(before, undefined);

  const due = dailyReviewReminder(
    new Date("2026-07-30T13:00:00.000Z"),
    { completedThrough: "2026-07-28" }
  );
  assert.deepEqual(
    {
      id: due.id,
      state: due.state,
      source: due.source,
      code: due.code
    },
    {
      id: "distillation:2026-07-29",
      state: "approval",
      source: "distillation",
      code: "daily-distillation"
    }
  );
  assert.doesNotMatch(JSON.stringify(due), /prompt|transcript|content|message/i);
});

test("launchd runs the reminder every day at exactly 9am", async () => {
  const plist = await readFile(
    new URL(
      "../launchd/com.ellataira.pi-daily-memory-review.plist",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /daily-review-reminder\.mjs/);
});
