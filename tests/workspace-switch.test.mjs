import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildWorkspaceChoices,
  WORKSPACE_SWITCH_ENTRY,
  currentWorkspaceState,
  performWorkspaceSwitch,
  resolveWorkspaceTarget
} from "../src/workspace-switch.mjs";

test("resolves relative paths to the target repository root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspace-"));
  const current = path.join(root, "current");
  const target = path.join(root, "target");
  const nested = path.join(target, "pkg", "api");
  await Promise.all([mkdir(current), mkdir(nested, { recursive: true })]);

  const resolved = await resolveWorkspaceTarget("../target/pkg/api", {
    cwd: current,
    home: root,
    stat,
    realpath,
    gitRoot: async () => target
  });

  assert.equal(resolved, await realpath(target));
});

test("accepts a shell-style quoted repository path containing spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspace-"));
  const target = path.join(root, "target repo");
  await mkdir(target);

  const resolved = await resolveWorkspaceTarget(`"${target}"`, {
    cwd: root,
    home: root,
    stat,
    realpath,
    gitRoot: async () => target
  });

  assert.equal(resolved, await realpath(target));
});

test("rejects missing paths and directories outside a Git repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspace-"));
  const plainDirectory = path.join(root, "plain");
  await mkdir(plainDirectory);

  await assert.rejects(
    resolveWorkspaceTarget("missing", {
      cwd: root,
      home: root,
      stat,
      realpath,
      gitRoot: async () => ""
    }),
    /does not exist/
  );
  await assert.rejects(
    resolveWorkspaceTarget(plainDirectory, {
      cwd: root,
      home: root,
      stat,
      realpath,
      gitRoot: async () => ""
    }),
    /Git repository/
  );
});

test("reconstructs bounded back-navigation state from custom entries", () => {
  const state = currentWorkspaceState(
    [
      {
        type: "custom",
        customType: WORKSPACE_SWITCH_ENTRY,
        data: {
          current: "/repos/two",
          history: ["/repos/one"]
        }
      },
      {
        type: "custom",
        customType: WORKSPACE_SWITCH_ENTRY,
        data: {
          current: "/repos/three",
          history: ["/repos/one", "/repos/two"]
        }
      }
    ],
    "/repos/three"
  );

  assert.deepEqual(state, {
    current: "/repos/three",
    history: ["/repos/one", "/repos/two"]
  });
});

test("forks the active branch into the target cwd before switching runtimes", async () => {
  const calls = [];
  const targetSession = {
    appendCustomEntry(type, data) {
      calls.push(["append", type, data]);
    },
    getSessionFile() {
      return "/sessions/target.jsonl";
    }
  };

  const result = await performWorkspaceSwitch({
    currentCwd: "/repos/one",
    targetCwd: "/repos/two",
    sourceSessionFile: "/sessions/source.jsonl",
    history: [],
    forkSession(source, target) {
      calls.push(["fork", source, target]);
      return targetSession;
    },
    async switchSession(file) {
      calls.push(["switch", file]);
      return { cancelled: false };
    }
  });

  assert.equal(result.cancelled, false);
  assert.deepEqual(calls, [
    ["fork", "/sessions/source.jsonl", "/repos/two"],
    [
      "append",
      WORKSPACE_SWITCH_ENTRY,
      { current: "/repos/two", history: ["/repos/one"] }
    ],
    ["switch", "/sessions/target.jsonl"]
  ]);
});

test("back navigation pops history instead of creating a toggle loop", async () => {
  const appended = [];

  await performWorkspaceSwitch({
    currentCwd: "/repos/three",
    targetCwd: "/repos/two",
    sourceSessionFile: "/sessions/source.jsonl",
    history: ["/repos/one", "/repos/two"],
    back: true,
    forkSession() {
      return {
        appendCustomEntry(_type, data) {
          appended.push(data);
        },
        getSessionFile() {
          return "/sessions/back.jsonl";
        }
      };
    },
    async switchSession() {
      return { cancelled: false };
    }
  });

  assert.deepEqual(appended, [
    { current: "/repos/two", history: ["/repos/one"] }
  ]);
});

test("refuses in-memory sessions and no-op switches", async () => {
  await assert.rejects(
    performWorkspaceSwitch({
      currentCwd: "/repos/one",
      targetCwd: "/repos/two",
      sourceSessionFile: "",
      history: [],
      forkSession() {
        throw new Error("unreachable");
      },
      async switchSession() {
        throw new Error("unreachable");
      }
    }),
    /persisted Pi session/
  );

  await assert.rejects(
    performWorkspaceSwitch({
      currentCwd: "/repos/one",
      targetCwd: "/repos/one",
      sourceSessionFile: "/sessions/source.jsonl",
      history: [],
      forkSession() {
        throw new Error("unreachable");
      },
      async switchSession() {
        throw new Error("unreachable");
      }
    }),
    /already active/
  );
});

test("registers and documents the workspace handoff contract", async () => {
  const [packageJson, readme, quickstart] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../QUICKSTART.md", import.meta.url), "utf8")
  ]);

  assert.match(packageJson, /pi-workspace-switch\.ts/);
  assert.match(readme, /\/workspace <path>/);
  assert.match(quickstart, /\/workspace back/);
  assert.match(quickstart, /target repository.*AGENTS\.md.*CLAUDE\.md/is);
  assert.match(quickstart, /conversation.*preserv/is);
});

test("workspace chooser suggests recent repositories without duplicates", () => {
  assert.deepEqual(
    buildWorkspaceChoices({
      current: "/repos/three",
      history: ["/repos/one", "/repos/two", "/repos/one"]
    }),
    [
      { path: "/repos/one", label: "Recent · /repos/one" },
      { path: "/repos/two", label: "Recent · /repos/two" },
      { path: undefined, label: "Enter another repository path…" }
    ]
  );
});
