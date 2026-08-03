import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const portableInstallFiles = [
  new URL("../hooks/claude-agent-journal.sh", import.meta.url),
  new URL("../scripts/install-daily-review-reminder.sh", import.meta.url),
  new URL("../launchd/com.ellataira.pi-daily-memory-review.plist", import.meta.url),
];

test("install entry points do not embed a user home or Homebrew prefix", async () => {
  for (const file of portableInstallFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\/Users\/ella\.taira/);
    assert.doesNotMatch(source, /\/opt\/homebrew/);
  }
});
