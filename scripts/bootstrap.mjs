#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installWorkbench } from "../src/bootstrap-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replaceExisting = process.argv.includes("--replace-existing");

try {
  const result = await installWorkbench({
    homeDir: os.homedir(),
    repoRoot,
    replaceExisting,
  });
  console.log(`Pi workbench linked: ${result.extensionPath} -> ${repoRoot}`);
  if (result.extensionBackup) console.log(`Previous extension backed up: ${result.extensionBackup}`);
  console.log(`Pi settings merged: ${result.settingsPath}`);
  console.log("Restart Pi or run /reload to load the repository version.");
} catch (error) {
  console.error(`Bootstrap failed: ${error.message}`);
  process.exitCode = 1;
}
