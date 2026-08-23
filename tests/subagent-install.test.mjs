import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  hardenSubagentArtifactDefaults,
  verifySubagentArtifactDefaults,
} from "../src/subagent-install.mjs";

test("subagent artifact hardening disables raw inputs, transcripts, and metadata", () => {
  const source = `
export const DEFAULT_ARTIFACT_CONFIG = {
  enabled: true,
  includeInput: true,
  includeOutput: true,
  includeJsonl: false,
  includeTranscript: true,
  includeMetadata: true,
  cleanupDays: 7,
};
`;

  const hardened = hardenSubagentArtifactDefaults(source);

  assert.match(hardened, /includeInput: false/);
  assert.match(hardened, /includeTranscript: false/);
  assert.match(hardened, /includeMetadata: false/);
  assert.match(hardened, /includeOutput: true/);
  assert.equal(verifySubagentArtifactDefaults(hardened), true);
});

test("subagent artifact hardening fails closed when upstream defaults drift", () => {
  assert.throws(
    () => hardenSubagentArtifactDefaults("export const DEFAULT_ARTIFACT_CONFIG = {};"),
    /artifact defaults.*not recognized/i,
  );
});

test("workbench pins and loads the hardened subagent runtime", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const settings = JSON.parse(
    await readFile(new URL("../config/pi/settings.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.dependencies["pi-subagents"], "0.52.1");
  assert.ok(packageJson.pi.extensions.includes("./node_modules/pi-subagents/index.ts"));
  assert.equal(
    settings.packages.some((entry) => entry.startsWith("npm:pi-subagents@")),
    false,
  );

  for (const agent of ["delegate", "oracle", "researcher", "reviewer", "scout", "worker"]) {
    assert.deepEqual(settings.subagents.agentOverrides[agent].extensions, []);
  }
});
