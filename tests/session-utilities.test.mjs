import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildCopyChoices,
  buildRewindChoices,
  extractCliCommands,
  latestAssistantText
} from "../src/session-utilities.mjs";

test("rewind choices let the user resume after any recent user message", () => {
  const entries = [
    {
      type: "message",
      id: "user-1",
      message: { role: "user", content: "Investigate the failing worker test." }
    },
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", content: [{ type: "text", text: "I found it." }] }
    },
    {
      type: "message",
      id: "user-2",
      message: { role: "user", content: [{ type: "text", text: "Fix it and rerun CI." }] }
    }
  ];

  assert.deepEqual(buildRewindChoices(entries), [
    {
      entryId: "user-2",
      label: "Re-edit from · Fix it and rerun CI."
    },
    {
      entryId: "user-1",
      label: "Re-edit from · Investigate the failing worker test."
    }
  ]);
});

test("copy offers each command in a shell block instead of forcing the whole block", () => {
  const text = [
    "Run:",
    "```bash",
    "$ git status --short",
    "$ npm test",
    "```",
    "Then use `cmux browser status`, but do not copy `someVariable`."
  ].join("\n");

  assert.deepEqual(extractCliCommands(text), [
    "git status --short",
    "npm test",
    "cmux browser status"
  ]);
  assert.deepEqual(buildCopyChoices(text), [
    {
      command: "git status --short",
      label: "Suggested command · git status --short"
    },
    {
      command: "npm test",
      label: "Command · npm test"
    },
    {
      command: "cmux browser status",
      label: "Command · cmux browser status"
    },
    {
      command: text,
      label: "Entire response"
    }
  ]);
});

test("copy keeps a continued multi-line shell command together", () => {
  const text = [
    "```bash",
    "curl --fail \\",
    "  --retry 3 \\",
    "  https://example.test/health",
    "```"
  ].join("\n");

  assert.deepEqual(extractCliCommands(text), [
    "curl --fail \\\n  --retry 3 \\\n  https://example.test/health"
  ]);
});

test("copy reads only the latest assistant prose from the active branch", () => {
  assert.equal(
    latestAssistantText([
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: "Old command: `git status`." }
      },
      {
        type: "message",
        id: "user-1",
        message: { role: "user", content: "What next?" }
      },
      {
        type: "message",
        id: "assistant-2",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "Use `npm test`." }
          ]
        }
      }
    ]),
    "Use `npm test`."
  );
});

test("session utilities register rewind and a non-conflicting command picker", async () => {
  const source = await readFile(
    new URL("../extensions/pi-session-utilities.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /registerCommand\("rewind"/);
  assert.match(source, /navigateTree\(choice\.entryId,\s*\{\s*summarize:\s*false\s*\}\)/s);
  assert.match(source, /registerCommand\("copy-command"/);
  assert.doesNotMatch(source, /registerCommand\("copy"/);
  assert.match(source, /copyToClipboard\(choice\.command\)/);
  assert.match(source, /buildCopyChoices/);
});
