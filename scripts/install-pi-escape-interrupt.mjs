#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  patchPiEscapeInterruptEditorSource,
  patchPiEscapeInterruptInteractiveSource
} from "../src/pi-escape-interrupt-integration.mjs";

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
const editorTarget = path.join(distDir, "modes", "interactive", "components", "custom-editor.js");
const interactiveTarget = path.join(distDir, "modes", "interactive", "interactive-mode.js");

const [editorSource, interactiveSource] = await Promise.all([
  readFile(editorTarget, "utf8"),
  readFile(interactiveTarget, "utf8")
]);
const editor = patchPiEscapeInterruptEditorSource(editorSource);
const interactive = patchPiEscapeInterruptInteractiveSource(interactiveSource);
if (!editor.changed && !interactive.changed) {
  console.log(`Pi reliable Escape interrupt already installed: ${editorTarget}`);
  process.exit(0);
}
if (editor.changed !== interactive.changed) {
  throw new Error("Pi reliable Escape interrupt patch is only partially installed; restore the matching backups before retrying");
}

await replaceWithBackup(editorTarget, editor.source, "pre-escape-interrupt");
await replaceWithBackup(interactiveTarget, interactive.source, "pre-escape-interrupt");
console.log(`Installed Pi reliable Escape interrupt: ${editorTarget}`);
console.log(`Backups: ${editorTarget}.pre-escape-interrupt, ${interactiveTarget}.pre-escape-interrupt`);
