import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return pathToFileURL(value).href;
  }
}

export async function importFreshSourceModule(filePath, { imports = {} } = {}) {
  let source = await readFile(filePath, "utf8");
  for (const [specifier, resolved] of Object.entries(imports)) {
    const escaped = escapedRegExp(specifier);
    const replacement = JSON.stringify(importUrl(resolved));
    source = source
      .replace(
        new RegExp(`(\\bfrom\\s*)["']${escaped}["']`, "g"),
        `$1${replacement}`
      )
      .replace(
        new RegExp(`(\\bimport\\s*)["']${escaped}["']`, "g"),
        `$1${replacement}`
      );
  }
  const sourceUrl = pathToFileURL(filePath).href;
  const encoded = Buffer.from(
    `${source}\n//# sourceURL=${sourceUrl}\n`,
    "utf8"
  ).toString("base64");
  const nonce = `${Date.now()}-${Math.random()}`;
  return import(`data:text/javascript;base64,${encoded}#${nonce}`);
}
