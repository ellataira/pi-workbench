import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("README stays concise while the changelog carries dated history", async () => {
  const [readme, changelog, publicReadme, publicChangelog] = await Promise.all([
    read("../README.md"),
    read("../CHANGELOG.md"),
    read("../html-guide/public/README.md"),
    read("../html-guide/public/CHANGELOG.md")
  ]);

  assert.ok(readme.split("\n").length <= 180, "README should remain a short entry point");
  assert.match(readme, /\[Pi \+ cmux quickstart\]\(\.\/QUICKSTART\.md\)/);
  assert.match(readme, /\[Changelog\]\(\.\/CHANGELOG\.md\)/);
  assert.match(changelog, /^# Changelog/m);
  assert.match(changelog, /^## 2026-08-26$/m);
  assert.match(changelog, /^## 2026-08-03$/m);
  assert.equal(publicReadme, readme);
  assert.equal(publicChangelog, changelog);
});
