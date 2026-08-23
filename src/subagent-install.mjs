import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PRIVATE_ARTIFACT_FIELDS = ["includeInput", "includeTranscript", "includeMetadata"];

function artifactDefaultsBlock(source) {
  const marker = "export const DEFAULT_ARTIFACT_CONFIG";
  const start = source.indexOf(marker);
  const end = start < 0 ? -1 : source.indexOf("\n};", start);
  if (start < 0 || end < 0) {
    throw new Error("pi-subagents artifact defaults are not recognized; refusing an unsafe install");
  }
  return { start, end: end + 3, text: source.slice(start, end + 3) };
}

export function verifySubagentArtifactDefaults(source) {
  let block;
  try {
    block = artifactDefaultsBlock(source).text;
  } catch {
    return false;
  }
  return PRIVATE_ARTIFACT_FIELDS.every((field) =>
    new RegExp(`\\b${field}:\\s*false\\b`).test(block),
  );
}

export function hardenSubagentArtifactDefaults(source) {
  const block = artifactDefaultsBlock(source);
  if (verifySubagentArtifactDefaults(source)) return source;

  let hardened = block.text;
  for (const field of PRIVATE_ARTIFACT_FIELDS) {
    const pattern = new RegExp(`(\\b${field}:\\s*)true\\b`, "g");
    const matches = [...hardened.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error("pi-subagents artifact defaults are not recognized; refusing an unsafe install");
    }
    hardened = hardened.replace(pattern, "$1false");
  }

  const result = `${source.slice(0, block.start)}${hardened}${source.slice(block.end)}`;
  if (!verifySubagentArtifactDefaults(result)) {
    throw new Error("pi-subagents artifact privacy hardening did not take effect");
  }
  return result;
}

export async function hardenInstalledPiSubagents(repoRoot) {
  const sourcePath = path.join(repoRoot, "node_modules/pi-subagents/src/shared/types.ts");
  const source = await readFile(sourcePath, "utf8");
  const hardened = hardenSubagentArtifactDefaults(source);
  if (hardened !== source) await writeFile(sourcePath, hardened);
  return { sourcePath, changed: hardened !== source };
}
