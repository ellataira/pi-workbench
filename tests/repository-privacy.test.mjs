import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const fragments = [
  ["eval-data", "portal"].join("-"),
  ["datadog", "google-workspace"].join("-"),
  ["dd", "datad0g.com"].join("."),
  ["prod", "dog/api"].join("."),
  ["Desktop", ["data", "dog-agent"].join("")].join("/"),
  ["gensim", "episode-"].join("/"),
  ["157", "3830"].join(""),
  ["pharmacy", "replicaepoch-store"].join("-"),
  ["episode", "campaign"].join("-"),
  ["a5d98895504b95691d4922473b85e5b9", "a641dd14"].join("")
];

test("tracked files exclude organization-specific endpoints and fixtures", async () => {
  for (const fragment of fragments) {
    try {
      const { stdout } = await execute("git", ["grep", "-Il", "--", fragment], {
        cwd: new URL("..", import.meta.url)
      });
      assert.fail(`tracked organization-specific value in: ${stdout.trim()}`);
    } catch (error) {
      if (error?.code === 1 && !error.stdout) continue;
      throw error;
    }
  }
});
