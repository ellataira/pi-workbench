import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearPairSuggestion,
  extractPairSuggestion,
  pairTerminalLaunchCommand,
  pairObservationMessage,
  pairOwnerKey,
  pairSuggestionFromMessages,
  pairZshProfileFiles,
  parseCmuxSurface,
  parsePairCandidateSurfaces,
  readPairBinding,
  removePairBinding,
  shouldPreservePairOnShutdown,
  terminalDelta,
  terminalOutputReady,
  writePairSuggestion,
  writePairBinding,
  writePairZshProfile
} from "../src/pair-terminal.mjs";

test("pair terminal launch uses an isolated zsh profile without recoloring the terminal", () => {
  assert.equal(
    pairTerminalLaunchCommand(
      "/bin/zsh",
      "/tmp/pi pair-zdotdir",
      "/tmp/pi pair-next-command"
    ),
    "PI_PAIR_SUGGESTION_FILE='/tmp/pi pair-next-command' ZDOTDIR='/tmp/pi pair-zdotdir' exec '/bin/zsh' -l"
  );
  assert.equal(
    pairTerminalLaunchCommand("not/an/absolute/shell"),
    "exec '/bin/zsh' -l"
  );
});

test("paired zsh profile loads normal config and Tab support without color hooks", () => {
  const files = pairZshProfileFiles("/Users/ella/custom-zdotdir");
  assert.match(files[".zshenv"], /custom-zdotdir\/\.zshenv/);
  assert.match(files[".zprofile"], /custom-zdotdir\/\.zprofile/);
  assert.match(files[".zshrc"], /custom-zdotdir\/\.zshrc/);
  assert.doesNotMatch(files[".zshrc"], /precmd_functions/);
  assert.doesNotMatch(files[".zshrc"], /preexec_functions/);
  assert.doesNotMatch(files[".zshrc"], /add-zle-hook-widget line-init/);
  assert.doesNotMatch(files[".zshrc"], /\\e\]11;|#3B1F32/);
  assert.match(files[".zshrc"], /bindkey '\^I' _pi_workbench_pair_tab/);
  assert.match(files[".zshrc"], /zle expand-or-complete/);
  assert.match(files[".zshrc"], /\[\[ -z \$BUFFER/);
  assert.match(files[".zlogin"], /custom-zdotdir\/\.zlogin/);
});

test("pair suggestion extraction accepts one bounded shell block only", () => {
  assert.equal(
    extractPairSuggestion("Run this:\n```bash\nnpm test \\\n+  -- --runInBand\n```"),
    "npm test \\\n+  -- --runInBand"
  );
  assert.equal(extractPairSuggestion("No command is appropriate."), "");
  assert.equal(extractPairSuggestion("```bash\none\n```\n```bash\ntwo\n```"), "");
  assert.equal(extractPairSuggestion(`\`\`\`bash\n${"x".repeat(9000)}\n\`\`\``), "");
});

test("pair suggestion uses only the final assistant text", () => {
  assert.equal(
    pairSuggestionFromMessages([
      { role: "user", content: "```bash\nunsafe-user-text\n```" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Next:\n```zsh\ngit status\n```" }
        ]
      }
    ]),
    "git status"
  );
});

test("pair suggestions are owner-only, replaceable, and removable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-pair-suggestion-"));
  const target = path.join(root, "next-command");
  await writePairSuggestion(target, "npm test");
  assert.equal(await readFile(target, "utf8"), "npm test\n");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await writePairSuggestion(target, "git status");
  assert.equal(await readFile(target, "utf8"), "git status\n");
  await clearPairSuggestion(target);
  await assert.rejects(readFile(target, "utf8"), /ENOENT/);
});

test("paired zsh profile is owner-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-pair-profile-parent-"));
  const profile = path.join(root, "profile");
  await writePairZshProfile(profile, "/Users/ella/custom-zdotdir");
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(profile, ".zshrc"))).mode & 0o777, 0o600);
});

test("pair terminal resolves the new cmux surface", () => {
  assert.equal(parseCmuxSurface("pane:4 surface:7\n"), "surface:7");
  assert.equal(
    parseCmuxSurface("created 123e4567-e89b-42d3-a456-426614174000"),
    "123e4567-e89b-42d3-a456-426614174000"
  );
  assert.throws(() => parseCmuxSurface("pane:4"), /surface/i);
});

test("pair reconnect lists other cmux surfaces without the originating terminal", () => {
  const tree = [
    "workspace:2 main",
    "  pane:3",
    "    surface:4 terminal",
    "  pane:5",
    "    surface:7 terminal",
    "    surface:8 browser"
  ].join("\n");
  assert.deepEqual(parsePairCandidateSurfaces(tree, "surface:4"), ["surface:7", "surface:8"]);
  assert.equal(
    parsePairCandidateSurfaces(
      Array.from({ length: 30 }, (_, index) => `surface:${index + 10}`).join("\n"),
      "surface:4"
    ).length,
    20
  );
});

test("pair terminal waits for execution instead of reacting to typed text", () => {
  assert.equal(terminalOutputReady("repo % npm test", "repo % npm test", 6000), false);
  assert.equal(
    terminalOutputReady("npm test\npassed\nrepo %", "npm test\npassed\nrepo %", 1200),
    true
  );
  assert.equal(
    terminalOutputReady("Choose an account:\n1. staging", "Choose an account:\n1. staging", 6000),
    true
  );
});

test("pair terminal emits only bounded redacted new output", () => {
  const before = "repo % npm test\nstarting\n";
  const after = `${before}\u001b[31mfailed\u001b[0m\nAPI_TOKEN=super-secret\nrepo % `;
  const delta = terminalDelta(before, after, { maxChars: 120, maxLines: 8 });
  assert.match(delta, /failed/);
  assert.match(delta, /API_TOKEN=\[redacted\]/);
  assert.doesNotMatch(delta, /super-secret|\u001b/);
  assert.doesNotMatch(delta, /npm test/);
});

test("pair observation requires analysis and one manual next command", () => {
  const message = pairObservationMessage("tests failed\nrepo % ");
  assert.match(message, /do not execute/i);
  assert.match(message, /exactly one next command/i);
  assert.match(message, /tests failed/);
});

test("pair ownership follows the physical cmux terminal across logical sessions", () => {
  assert.equal(shouldPreservePairOnShutdown("fork"), true);
  assert.equal(shouldPreservePairOnShutdown("resume"), true);
  assert.equal(shouldPreservePairOnShutdown("new"), true);
  assert.equal(shouldPreservePairOnShutdown("reload"), true);
  assert.equal(shouldPreservePairOnShutdown("quit"), false);
  assert.equal(
    pairOwnerKey("workspace:2", "surface:4"),
    pairOwnerKey("workspace:2", "surface:4")
  );
  assert.notEqual(
    pairOwnerKey("workspace:2", "surface:4"),
    pairOwnerKey("workspace:2", "surface:5")
  );
});

test("pair bindings persist only cmux routing metadata with owner-only permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-pair-binding-"));
  const binding = {
    workspace: "workspace:2",
    sourceSurface: "surface:4",
    pairSurface: "surface:7"
  };
  const filePath = await writePairBinding(root, binding);
  assert.deepEqual(await readPairBinding(root, binding.workspace, binding.sourceSurface), binding);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  await removePairBinding(root, binding.workspace, binding.sourceSurface);
  assert.equal(await readPairBinding(root, binding.workspace, binding.sourceSurface), undefined);
});

test("pair terminal registers one guided command and one model-callable tool", async () => {
  const source = await readFile(
    new URL("../extensions/pi-pair-terminal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /registerCommand\("pair"/);
  assert.match(source, /importFreshSourceModule/);
  assert.doesNotMatch(source, /from "\.\.\/src\/pair-terminal\.mjs"/);
  assert.match(source, /name: "pair_terminal"/);
  assert.match(source, /"respawn-pane"/);
  assert.match(source, /"close-surface"/);
  assert.match(source, /stop\(\{ closeSurface: false \}\)/);
  assert.match(source, /shouldPreservePairOnShutdown\(event\.reason\)/);
  assert.match(source, /restorePairBinding/);
  assert.match(source, /appendEntry\("pi-pair-open-metrics"/);
  assert.match(source, /asks whether.*watching.*status/i);
  assert.doesNotMatch(source, /cmux\(\["send(?:-key)?"/);
});
