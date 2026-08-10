#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { patchPiPromptEchoSource } from "../src/pi-prompt-echo-integration.mjs";

const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const piCli = await realpath(piExecutable);
const target = path.join(path.dirname(piCli), "modes", "interactive", "interactive-mode.js");
const source = await readFile(target, "utf8");
const patched = patchPiPromptEchoSource(source);
if (!patched.changed) {
  console.log(`Pi prompt echo already installed: ${target}`);
  process.exit(0);
}
const backup = `${target}.pre-prompt-echo`;
await copyFile(target, backup, 0);
const temporary = `${target}.${process.pid}.tmp`;
await writeFile(temporary, patched.source, { encoding: "utf8", mode: 0o644 });
await chmod(temporary, 0o644);
await rename(temporary, target);
console.log(`Installed Pi prompt echo: ${target}`);
console.log(`Backup: ${backup}`);
