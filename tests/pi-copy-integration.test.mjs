import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { patchPiCopySource } from "../src/pi-copy-integration.mjs";

const execFileAsync = promisify(execFile);

const nativeCopy = `
            if (text === "/copy") {
                await this.handleCopyCommand();
                this.editor.setText("");
                return;
            }
`;

test("Pi copy integration delegates exact /copy to the extension picker", () => {
  const patched = patchPiCopySource(nativeCopy);
  assert.equal(patched.changed, true);
  assert.match(patched.source, /pi-copy-command-picker/);
  assert.match(patched.source, /await this\.session\.prompt\("\/copy-command"\)/);
  assert.match(patched.source, /await this\.handleCopyCommand\(\)/);
  assert.equal(patchPiCopySource(patched.source).changed, false);
});

test("Pi copy integration fails closed when the native command shape changes", () => {
  assert.throws(
    () => patchPiCopySource("unrelated source"),
    /native \/copy handler was not found/
  );
});

test("the installed Pi runtime contains the guarded copy-picker delegation", async () => {
  const source = await readFile(
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
    "utf8"
  );
  assert.match(source, /pi-copy-command-picker/);
});

test("the installer finds a globally installed Pi package", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../scripts/install-pi-copy-picker.mjs", import.meta.url).pathname],
    { cwd: new URL("..", import.meta.url).pathname }
  );
  assert.match(stdout, /Pi copy picker already installed:/);
});
