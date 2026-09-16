import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  patchPiEscapeInterruptEditorSource,
  patchPiEscapeInterruptInteractiveSource
} from "../src/pi-escape-interrupt-integration.mjs";

const execFileAsync = promisify(execFile);

const nativeEditor = `
export class CustomEditor extends Editor {
    keybindings;
    actionHandlers = new Map();
    onEscape;
    onCtrlD;
    onPasteImage;
    handleInput(data) {
        // Check app keybindings first
        // Escape/interrupt - only if autocomplete is NOT active
        if (this.keybindings.matches(data, "app.interrupt")) {
            if (!this.isShowingAutocomplete()) {
                // Use dynamic onEscape if set, otherwise registered handler
                const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
                if (handler) {
                    handler();
                    return;
                }
            }
            // Let parent handle escape for autocomplete cancellation
            super.handleInput(data);
            return;
        }
    }
}
`;

const nativeInteractive = `
export class InteractiveMode {
    setupKeyHandlers() {
        this.defaultEditor.onEscape = () => {
            if (this.session.isStreaming) {
                this.restoreQueuedMessagesToEditor({ abort: true });
            }
            else if (this.session.isBashRunning) {
                this.session.abortBash();
            }
        };
        // Register app action handlers
        this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
    }
}
`;

test("Escape interrupt passes through autocomplete only while Pi has active work", () => {
  const editor = patchPiEscapeInterruptEditorSource(nativeEditor);
  const interactive = patchPiEscapeInterruptInteractiveSource(nativeInteractive);

  assert.equal(editor.changed, true);
  assert.match(editor.source, /pi-escape-reliable-interrupt/);
  assert.match(editor.source, /shouldInterruptAfterAutocomplete/);
  assert.match(editor.source, /hadAutocomplete && !this\.isShowingAutocomplete\(\)/);
  assert.match(editor.source, /handler\(\);/);
  assert.equal(interactive.changed, true);
  assert.match(interactive.source, /this\.session\.isStreaming \|\| this\.session\.isBashRunning \|\| this\.session\.isCompacting \|\| this\.session\.isRetrying/);
  assert.equal(patchPiEscapeInterruptEditorSource(editor.source).changed, false);
  assert.equal(patchPiEscapeInterruptInteractiveSource(interactive.source).changed, false);
});

test("Escape interrupt patch fails closed when native shapes change", () => {
  assert.throws(
    () => patchPiEscapeInterruptEditorSource("unrelated source"),
    /custom editor interrupt state field was not found/
  );
  assert.throws(
    () => patchPiEscapeInterruptInteractiveSource("unrelated source"),
    /interactive escape handler was not found/
  );
});

test("Escape interrupt installer patches the Pi selected by PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-escape-interrupt-installer-"));
  const binDir = path.join(root, "bin");
  const distDir = path.join(root, "package/dist");
  const editorDir = path.join(distDir, "modes/interactive/components");
  const interactiveDir = path.join(distDir, "modes/interactive");
  const piCli = path.join(distDir, "cli.js");
  const editor = path.join(editorDir, "custom-editor.js");
  const interactive = path.join(interactiveDir, "interactive-mode.js");
  await mkdir(binDir, { recursive: true });
  await mkdir(editorDir, { recursive: true });
  await writeFile(piCli, "#!/usr/bin/env node\n");
  await chmod(piCli, 0o755);
  await writeFile(editor, nativeEditor);
  await writeFile(interactive, nativeInteractive);
  await symlink(piCli, path.join(binDir, "pi"));

  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../scripts/install-pi-escape-interrupt.mjs", import.meta.url).pathname],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
    }
  );
  assert.match(stdout, /Installed Pi reliable Escape interrupt:/);
  assert.match(await readFile(editor, "utf8"), /pi-escape-reliable-interrupt/);
  assert.match(await readFile(interactive, "utf8"), /pi-escape-reliable-interrupt/);
});
