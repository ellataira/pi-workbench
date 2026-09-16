import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildResumeCloneWorkspaceArgs,
  cloneSessionName,
  patchPiResumeCloneKeybindingsSource,
  patchPiResumeCloneSelectorSource
} from "../src/pi-resume-clone-integration.mjs";

const execFileAsync = promisify(execFile);

const nativeKeybindings = `
    "app.session.rename": {
        defaultKeys: "ctrl+r",
        description: "Rename session",
    },
    "app.session.delete": {
`;

const nativeSelector = `
function canonicalizePath(path) {
    return path;
}
class SessionSelectorHeader {
    render(width) {
            if (this.showRenameHint) {
                hint2Parts.push(keyHint("app.session.rename", "rename"));
            }
    }
}
class SessionList {
    onRenameSession;
    handleInput(keyData) {
        const kb = getKeybindings();
        // Rename selected session
        if (kb.matches(keyData, "app.session.rename")) {
            const selected = this.filteredSessions[this.selectedIndex];
            if (selected) {
                this.onRenameSession?.(selected.session.path);
            }
            return;
        }
    }
}
export class SessionSelectorComponent {
    constructor() {
        this.sessionList.onRenameSession = (sessionPath) => {
            this.enterRenameMode(sessionPath);
        };
        // Sync list events to header
    }
}
`;

test("resume clone launches the selected saved session without embedding its path in shell text", () => {
  const args = buildResumeCloneWorkspaceArgs({
    path: "/Users/ella/Sessions/session with spaces.jsonl",
    cwd: "/Users/ella/Desktop/example-repo",
    name: "Metric plan"
  });

  assert.deepEqual(args.slice(0, 6), [
    "new-workspace",
    "--name",
    "Metric plan-clone",
    "--cwd",
    "/Users/ella/Desktop/example-repo",
    "--env"
  ]);
  assert.match(args[6], /^PI_RESUME_CLONE_SESSION=/);
  assert.equal(args[7], "--env");
  assert.equal(args[8], "PI_RESUME_CLONE_NAME=Metric plan-clone");
  assert.equal(args.at(-2), "--focus");
  assert.equal(args.at(-1), "true");
  assert.match(args[10], /pi --fork "\$session" --name "\$name"/);
  assert.doesNotMatch(args[10], /session with spaces/);
  assert.doesNotMatch(args[10], /Metric plan/);
});

test("resume clone names fall back to a bounded session filename clone", () => {
  assert.equal(
    cloneSessionName({
      path: "/Users/ella/.pi/agent/sessions/project/2026-09-15T12-00-00-my-task.jsonl"
    }),
    "2026-09-15T12-00-00-my-task-clone"
  );
  assert.equal(
    cloneSessionName({
      path: "/Users/ella/.pi/agent/sessions/project/long.jsonl",
      name: "  Existing clone  "
    }),
    "Existing clone-clone"
  );
});

test("resume clone patch adds a discoverable Alt+Enter action and fails closed", () => {
  const keybindings = patchPiResumeCloneKeybindingsSource(nativeKeybindings);
  const selector = patchPiResumeCloneSelectorSource(nativeSelector);

  assert.equal(keybindings.changed, true);
  assert.match(keybindings.source, /"app\.session\.clone": \{/);
  assert.match(keybindings.source, /defaultKeys: "alt\+enter"/);
  assert.equal(selector.changed, true);
  assert.match(selector.source, /pi-resume-clone/);
  assert.match(selector.source, /keyHint\("app\.session\.clone", "clone in new tab"\)/);
  assert.match(selector.source, /onCloneSession/);
  assert.match(selector.source, /launchResumeClone/);
  assert.match(selector.source, /PI_RESUME_CLONE_NAME/);
  assert.match(selector.source, /--name "\$name"/);
  assert.equal(patchPiResumeCloneKeybindingsSource(keybindings.source).changed, false);
  assert.equal(patchPiResumeCloneSelectorSource(selector.source).changed, false);

  assert.throws(
    () => patchPiResumeCloneKeybindingsSource("unrelated source"),
    /session rename keybinding was not found/
  );
  assert.throws(
    () => patchPiResumeCloneSelectorSource("unrelated source"),
    /session selector shape was not found/
  );
});

test("resume clone installer patches the Pi selected by PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-resume-clone-installer-"));
  const binDir = path.join(root, "bin");
  const distDir = path.join(root, "package/dist");
  const selectorDir = path.join(distDir, "modes/interactive/components");
  const piCli = path.join(distDir, "cli.js");
  const keybindings = path.join(distDir, "core/keybindings.js");
  const selector = path.join(selectorDir, "session-selector.js");
  await mkdir(binDir, { recursive: true });
  await mkdir(path.dirname(keybindings), { recursive: true });
  await mkdir(selectorDir, { recursive: true });
  await writeFile(piCli, "#!/usr/bin/env node\n");
  await chmod(piCli, 0o755);
  await writeFile(keybindings, nativeKeybindings);
  await writeFile(selector, nativeSelector);
  await symlink(piCli, path.join(binDir, "pi"));

  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../scripts/install-pi-resume-clone.mjs", import.meta.url).pathname],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
    }
  );
  assert.match(stdout, /Installed Pi resume clone action:/);
  assert.match(await readFile(keybindings, "utf8"), /app\.session\.clone/);
  assert.match(await readFile(selector, "utf8"), /pi-resume-clone/);
});
