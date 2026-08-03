import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  buildProfileChoices,
  mergeProfiles,
  normalizeProfile,
  profileInstructions
} from "../src/project-profiles.mjs";

test("project profiles override global profiles without assuming a model vendor", () => {
  const profiles = mergeProfiles(
    {
      implementation: {
        thinkingLevel: "medium",
        tools: ["read", "bash", "edit", "write"]
      }
    },
    {
      implementation: {
        thinkingLevel: "high",
        verification: ["tests", "docs"]
      }
    }
  );

  assert.deepEqual(profiles.implementation, {
    thinkingLevel: "high",
    verification: ["tests", "docs"]
  });
  assert.equal("provider" in profiles.implementation, false);
});

test("profile normalization bounds tools, policies, and verification instructions", () => {
  const profile = normalizeProfile({
    provider: "ai-gateway",
    model: "model-id",
    thinkingLevel: "high",
    tools: ["read", "bash", "read"],
    verification: ["tests", "docs"],
    agentPolicy: {
      maxConcurrency: 3,
      oneWriterPerCheckout: true
    },
    ignored: "nope"
  });

  assert.deepEqual(profile.tools, ["read", "bash"]);
  assert.deepEqual(profile.agentPolicy, {
    maxConcurrency: 3,
    oneWriterPerCheckout: true
  });
  assert.equal("ignored" in profile, false);
  assert.match(profileInstructions("implementation", profile), /one writer per checkout/i);
  assert.match(profileInstructions("implementation", profile), /tests, docs/i);
});

test("writing profile is vendor-neutral and verifies documentation quality", async () => {
  const [config, quickstart] = await Promise.all([
    readFile(path.join(homedir(), ".pi", "agent", "project-profiles.json"), "utf8")
      .then(JSON.parse),
    readFile(new URL("../QUICKSTART.md", import.meta.url), "utf8")
  ]);
  const writing = normalizeProfile(config.profiles.writing);

  assert.deepEqual(writing, {
    thinkingLevel: "medium",
    verification: [
      "source-accuracy",
      "links-and-commands",
      "docs-consistency"
    ],
    agentPolicy: {
      maxConcurrency: 1,
      oneWriterPerCheckout: true
    }
  });
  assert.equal("provider" in writing, false);
  assert.equal("model" in writing, false);
  assert.match(quickstart, /\/profile writing/);
  assert.match(quickstart, /documentation and writing/i);
});

test("profile chooser identifies the active profile and its behavior", () => {
  assert.deepEqual(
    buildProfileChoices(
      {
        implementation: {
          thinkingLevel: "high",
          verification: ["tests", "docs"]
        },
        writing: { thinkingLevel: "medium" }
      },
      "implementation"
    ),
    [
      {
        name: "implementation",
        label: "Active · implementation · think:high · verify: tests, docs"
      },
      { name: "writing", label: "writing · think:medium" },
      { name: "off", label: "Turn profile off" }
    ]
  );
});
