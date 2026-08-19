#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  patchPiResumeCloneKeybindingsSource,
  patchPiResumeCloneSelectorSource
} from "../src/pi-resume-clone-integration.mjs";

async function replaceWithBackup(target, source, backupSuffix) {
  await copyFile(target, `${target}.${backupSuffix}`, 0);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, target);
}

const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const piCli = await realpath(piExecutable);
const distDir = path.dirname(piCli);
const keybindingsTarget = path.join(distDir, "core", "keybindings.js");
const selectorTarget = path.join(
  distDir,
  "modes",
  "interactive",
  "components",
  "session-selector.js"
);

const [keybindingsSource, selectorSource] = await Promise.all([
  readFile(keybindingsTarget, "utf8"),
  readFile(selectorTarget, "utf8")
]);
const keybindings = patchPiResumeCloneKeybindingsSource(keybindingsSource);
const selector = patchPiResumeCloneSelectorSource(selectorSource);
if (!keybindings.changed && !selector.changed) {
  console.log(`Pi resume clone action already installed: ${selectorTarget}`);
  process.exit(0);
}
if (keybindings.changed !== selector.changed) {
  throw new Error("Pi resume clone patch is only partially installed; restore the matching backups before retrying");
}

await replaceWithBackup(keybindingsTarget, keybindings.source, "pre-resume-clone");
await replaceWithBackup(selectorTarget, selector.source, "pre-resume-clone");
console.log(`Installed Pi resume clone action: ${selectorTarget}`);
console.log(`Backups: ${keybindingsTarget}.pre-resume-clone, ${selectorTarget}.pre-resume-clone`);
