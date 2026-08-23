#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { hardenInstalledPiSubagents } from "../src/subagent-install.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await hardenInstalledPiSubagents(repoRoot);
  console.log(
    result.changed
      ? `Hardened pi-subagents artifact defaults: ${result.sourcePath}`
      : `Pi subagent artifact defaults already hardened: ${result.sourcePath}`,
  );
} catch (error) {
  console.error(`Pi subagent hardening failed: ${error.message}`);
  process.exitCode = 1;
}
