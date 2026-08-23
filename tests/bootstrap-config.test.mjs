import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installWorkbench, mergePiSettings } from "../src/bootstrap-config.mjs";

test("portable settings reserve enough context for long tool-driven turns", async () => {
  const settings = JSON.parse(
    await readFile(new URL("../config/pi/settings.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(settings.compaction, {
    enabled: true,
    reserveTokens: 49152,
    keepRecentTokens: 20000,
  });
});

test("portable settings merge preserves machine-specific packages and provider", () => {
  const current = {
    packages: ["../../dd/private-package", "npm:pi-subagents@0.35.1"],
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
  };
  const portable = {
    packages: ["../../.agents/extensions/agent-journal"],
    theme: "light",
  };

  assert.deepEqual(mergePiSettings(current, portable), {
    packages: [
      "../../dd/private-package",
      "../../.agents/extensions/agent-journal",
    ],
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
    theme: "light",
  });
});
test("installation backs up an existing extension and writes merged config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-workbench-test-"));
  const homeDir = path.join(root, "home");
  const repoRoot = path.join(root, "repo");
  const extensionPath = path.join(homeDir, ".agents/extensions/agent-journal");
  const piDir = path.join(homeDir, ".pi/agent");
  await mkdir(path.join(repoRoot, "config/pi"), { recursive: true });
  await mkdir(path.join(repoRoot, "skills/persona-panel"), { recursive: true });
  await mkdir(extensionPath, { recursive: true });
  await mkdir(piDir, { recursive: true });
  await writeFile(path.join(extensionPath, "old.txt"), "old source\n");
  await writeFile(
    path.join(piDir, "settings.json"),
    JSON.stringify({ packages: ["local-package"], defaultProvider: "openai" }),
  );
  await writeFile(
    path.join(repoRoot, "config/pi/settings.json"),
    JSON.stringify({ packages: ["workbench-package"], theme: "light" }),
  );
  await writeFile(path.join(repoRoot, "config/pi/project-profiles.json"), "{}\n");
  await writeFile(path.join(repoRoot, "config/pi/subagent-config.json"), "{}\n");
  await writeFile(
    path.join(repoRoot, "skills/persona-panel/SKILL.md"),
    "---\nname: persona-panel\n---\ntracked workflow contract\n",
  );
  await writeFile(
    path.join(repoRoot, "config/pi/mcp.json"),
    JSON.stringify({
      imports: [],
      mcpServers: {
        slack: { command: "python3", args: ["__HOME__/.agents/slack-proxy.py"] },
      },
    }),
  );

  const result = await installWorkbench({ homeDir, repoRoot, replaceExisting: true });

  assert.equal(await realpath(extensionPath), await realpath(repoRoot));
  assert.match(result.extensionBackup, /agent-journal\.backup-/);
  assert.equal(await readFile(path.join(result.extensionBackup, "old.txt"), "utf8"), "old source\n");
  const installed = JSON.parse(await readFile(path.join(piDir, "settings.json"), "utf8"));
  assert.deepEqual(installed.packages, ["local-package", "workbench-package"]);
  assert.equal(installed.defaultProvider, "openai");
  assert.equal(installed.theme, "light");
  const installedMcp = JSON.parse(await readFile(path.join(piDir, "mcp.json"), "utf8"));
  assert.deepEqual(installedMcp, {
    imports: [],
    mcpServers: {
      slack: { command: "python3", args: [`${homeDir}/.agents/slack-proxy.py`] },
    },
  });
  assert.equal(
    await readFile(path.join(homeDir, ".agents/skills/persona-panel/SKILL.md"), "utf8"),
    "---\nname: persona-panel\n---\ntracked workflow contract\n",
  );
});
