import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("the installer finds and patches the Pi executable selected by PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-copy-installer-"));
  const binDir = path.join(root, "bin");
  const distDir = path.join(root, "package/dist");
  const targetDir = path.join(distDir, "modes/interactive");
  const piCli = path.join(distDir, "cli.js");
  const target = path.join(targetDir, "interactive-mode.js");
  await mkdir(binDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(piCli, "#!/usr/bin/env node\n");
  await chmod(piCli, 0o755);
  await writeFile(target, nativeCopy);
  await symlink(piCli, path.join(binDir, "pi"));

  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../scripts/install-pi-copy-picker.mjs", import.meta.url).pathname],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    }
  );
  assert.match(stdout, /Installed Pi copy picker:/);
  assert.match(await readFile(target, "utf8"), /pi-copy-command-picker/);
});
