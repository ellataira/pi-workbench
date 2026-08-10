import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { patchPiPromptEchoSource } from "../src/pi-prompt-echo-integration.mjs";

const execFileAsync = promisify(execFile);

const nativeInteractiveMode = `
export class InteractiveMode {
    onInputCallback;
    pendingUserInputs = [];
    async run() {
        while (true) {
            const userInput = await this.getUserInput();
            try {
                await this.session.prompt(userInput);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                this.showError(errorMessage);
            }
        }
    }
    setupEditorSubmitHandler() {
        this.defaultEditor.onSubmit = async (text) => {
            text = text.trim();
            if (!text)
                return;
            if (this.session.isCompacting) {
                if (this.isExtensionCommand(text)) {
                    await this.session.prompt(text);
                }
                else {
                    this.queueCompactionMessage(text, "steer");
                }
                return;
            }
            if (this.session.isStreaming) {
                this.editor.addToHistory?.(text);
                this.editor.setText("");
                await this.session.prompt(text, { streamingBehavior: "steer" });
                this.updatePendingMessagesDisplay();
                this.ui.requestRender();
                return;
            }
            this.flushPendingBashComponents();
            if (this.onInputCallback) {
                this.onInputCallback(text);
            }
            else {
                this.pendingUserInputs.push(text);
            }
            this.editor.addToHistory?.(text);
        };
    }
    async handleFollowUp() {
        const text = this.editor.getText().trim();
        if (this.session.isStreaming) {
            this.editor.addToHistory?.(text);
            this.editor.setText("");
            await this.session.prompt(text, { streamingBehavior: "followUp" });
            this.updatePendingMessagesDisplay();
            this.ui.requestRender();
        }
    }
    async handleEvent(event) {
        switch (event.type) {
            case "message_start":
                if (event.message.role === "custom") {
                    this.addMessageToChat(event.message);
                    this.ui.requestRender();
                }
                else if (event.message.role === "user") {
                    this.addMessageToChat(event.message);
                    this.updatePendingMessagesDisplay();
                    this.ui.requestRender();
                }
                break;
        }
    }
}
`;

test("Pi prompt echo renders normal submitted text immediately and suppresses the later duplicate", () => {
  const patched = patchPiPromptEchoSource(nativeInteractiveMode);
  assert.equal(patched.changed, true);
  assert.match(patched.source, /pi-prompt-immediate-echo/);
  assert.match(patched.source, /if \(!this\.isExtensionCommand\(text\)\)/);
  assert.match(patched.source, /this\.showSubmittedPromptEcho\(text\)/);
  assert.match(patched.source, /showSubmittedPromptEcho\(text\);\n\s*await this\.session\.prompt\(text, \{ streamingBehavior: "steer" \}\)/);
  assert.match(patched.source, /showSubmittedPromptEcho\(text\);\n\s*await this\.session\.prompt\(text, \{ streamingBehavior: "followUp" \}\)/);
  assert.match(patched.source, /showSubmittedPromptEcho\(text\);\n\s*this\.queueCompactionMessage\(text, "steer"\)/);
  assert.match(patched.source, /pendingPromptEchoes = \[\]/);
  assert.match(patched.source, /if \(!this\.consumeSubmittedPromptEcho\(\)\)/);
  assert.match(patched.source, /finally \{\s*this\.releaseSubmittedPromptEcho\(userInput\)/);
  assert.equal(patchPiPromptEchoSource(patched.source).changed, false);
});

test("Pi prompt echo fails closed when the native submit shape changes", () => {
  assert.throws(
    () => patchPiPromptEchoSource("unrelated source"),
    /was not found/
  );
});

test("the prompt echo installer finds and patches the Pi executable selected by PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-echo-installer-"));
  const binDir = path.join(root, "bin");
  const distDir = path.join(root, "package/dist");
  const targetDir = path.join(distDir, "modes/interactive");
  const piCli = path.join(distDir, "cli.js");
  const target = path.join(targetDir, "interactive-mode.js");
  await mkdir(binDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(piCli, "#!/usr/bin/env node\n");
  await chmod(piCli, 0o755);
  await writeFile(target, nativeInteractiveMode);
  await symlink(piCli, path.join(binDir, "pi"));

  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../scripts/install-pi-prompt-echo.mjs", import.meta.url).pathname],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    }
  );
  assert.match(stdout, /Installed Pi prompt echo:/);
  assert.match(await readFile(target, "utf8"), /pi-prompt-immediate-echo/);
});
