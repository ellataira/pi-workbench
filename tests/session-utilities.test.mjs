import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildCopyChoices,
  buildRewindChoices,
  extractCliCommands,
  latestAssistantText,
  resolveSessionDeletionTarget
} from "../src/session-utilities.mjs";

test("session deletion accepts only a native JSONL directly inside the session directory", () => {
  assert.equal(
    resolveSessionDeletionTarget(
      "/Users/test/.pi/agent/sessions/project/2026-08-21_session-id.jsonl",
      "/Users/test/.pi/agent/sessions/project"
    ),
    "/Users/test/.pi/agent/sessions/project/2026-08-21_session-id.jsonl"
  );
});

test("session deletion rejects missing, non-JSONL, nested, and outside targets", () => {
  for (const [sessionFile, sessionDir] of [
    [undefined, "/Users/test/.pi/agent/sessions/project"],
    ["/Users/test/.pi/agent/sessions/project/session.txt", "/Users/test/.pi/agent/sessions/project"],
    ["/Users/test/.pi/agent/sessions/project/nested/session.jsonl", "/Users/test/.pi/agent/sessions/project"],
    ["/Users/test/.pi/agent/sessions/other/session.jsonl", "/Users/test/.pi/agent/sessions/project"],
    ["/Users/test/.pi/agent/sessions/project/session.jsonl", undefined]
  ]) {
    assert.equal(resolveSessionDeletionTarget(sessionFile, sessionDir), undefined);
  }
});

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

test("copy keeps a continued curl with multiline quoted JSON together", () => {
  const script = [
    "cd /Users/ella/example-bundles/bundle-001 && \\",
    "  curl --fail-with-body -sS \\",
    "    -X POST 'https://api.example.test/api/v1/scenarios/ingest' \\",
    "    -H 'Content-Type: application/json' \\",
    "    -d '{",
    '      "org_id": 12345,',
    '      "s3_prefix": "examples/bundle-001",',
    '      "force": false,',
    '      "dry_run": false',
    "    }' | tee ingest-result.json"
  ].join("\n");
  const text = `Run this:\n\n\`\`\`bash\n${script}\n\`\`\``;

  assert.deepEqual(extractCliCommands(text), [script]);
  assert.equal(buildCopyChoices(text)[0].command, script);
});

test("copy keeps assignments, command substitutions, and blank lines as one shell script", () => {
  const script = [
    'EDP_URL="https://api.example.test"',
    'S3_PREFIX="examples/bundle-001"',
    "",
    'BODY="$(' ,
    "  jq -nc \\",
    "    --argjson org_id 12345 \\",
    "    --arg s3_prefix \"$S3_PREFIX\" \\",
    "    '{",
    "      org_id: $org_id,",
    "      s3_prefix: $s3_prefix,",
    "      force: false,",
    "      dry_run: true",
    "    }'",
    ')"',
    "",
    "dd-auth --domain example.test -- \\",
    "  curl -sS \\",
    "    -D - \\",
    "    -w '\\nHTTP_STATUS=%{http_code}\\n' \\",
    "    -X POST \\",
    "    \"$EDP_URL/api/v1/scenarios/ingest\" \\",
    "    -H 'Content-Type: application/json' \\",
    '    --data-binary "$BODY"'
  ].join("\n");
  const text = `Run this:\n\n\`\`\`bash\n${script}\n\`\`\``;

  assert.deepEqual(extractCliCommands(text), [script]);
  assert.equal(buildCopyChoices(text)[0].command, script);
});

test("copy removes shared Markdown indentation without flattening a shell script", () => {
  const text = [
    "```bash",
    "   ONE=1",
    "   ",
    "   echo \"$ONE\" | \\",
    "     sed 's/1/one/'",
    "```"
  ].join("\n");
  assert.deepEqual(extractCliCommands(text), [
    "ONE=1\n\necho \"$ONE\" | \\\n  sed 's/1/one/'"
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

test("session utilities register rewind, rename, end, and a non-conflicting command picker", async () => {
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
  assert.match(source, /registerCommand\("rename"/);
  assert.match(source, /pi\.setSessionName\(name\)/);
  assert.match(source, /pi\.getSessionName\(\)/);
  assert.match(source, /registerCommand\("end"/);
  assert.match(source, /ctx\.ui\.confirm\(/);
  assert.match(source, /unlink\(target\)/);
  assert.match(source, /ctx\.shutdown\(\)/);
});
