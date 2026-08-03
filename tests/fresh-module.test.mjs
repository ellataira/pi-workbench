import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { importFreshSourceModule } from "../src/fresh-module.mjs";

test("fresh source modules bypass a previously loaded native module", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-fresh-module-"));
  const modulePath = path.join(directory, "policy.mjs");
  await writeFile(modulePath, "export const version = 1;\n", "utf8");

  const stale = await import(modulePath);
  assert.equal(stale.version, 1);

  await writeFile(modulePath, "export const version = 2;\n", "utf8");
  assert.equal((await import(modulePath)).version, 1);
  assert.equal((await importFreshSourceModule(modulePath)).version, 2);
});

test("fresh source modules can resolve an explicit bare dependency", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-fresh-module-import-"));
  const dependencyPath = path.join(directory, "dependency.mjs");
  const modulePath = path.join(directory, "consumer.mjs");
  await writeFile(dependencyPath, "export const value = 42;\n", "utf8");
  await writeFile(
    modulePath,
    'import { value } from "test-dependency";\nexport const answer = value;\n',
    "utf8"
  );

  const loaded = await importFreshSourceModule(modulePath, {
    imports: {
      "test-dependency": dependencyPath
    }
  });

  assert.equal(loaded.answer, 42);
});
