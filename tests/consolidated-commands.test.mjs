import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("memory exposes one maintenance surface while preserving direct checkpoint and distill", async () => {
  const source = await readFile(
    new URL("../extensions/pi-agent-journal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /registerCommand\("memory"/);
  assert.match(source, /registerCommand\("checkpoint"/);
  assert.match(source, /registerCommand\("distill"/);
  assert.doesNotMatch(source, /registerCommand\("retention-(?:audit|cleanup|integrity|receipts)"/);
});

test("Pi checkpoints sanitize artifact prose before strict journal ingestion", async () => {
  const source = await readFile(
    new URL("../extensions/pi-agent-journal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /sanitizeArtifactReferences\(summary\.artifacts\)/);
  assert.match(source, /artifacts:\s*artifactResult\.artifacts/);
  assert.match(source, /discardedArtifactCount:\s*artifactResult\.discardedArtifactCount/);
});

test("pet companion launch is guarded per extension lifecycle", async () => {
  const source = await readFile(
    new URL("../extensions/pi-lifecycle-pet.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /companionLaunchRequested/);
  assert.doesNotMatch(source, /pi\.on\("agent_start"[\s\S]{0,500}launchCompanion\(\)/);
});
