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

test("copy keeps a continued curl with multiline quoted JSON together", () => {
  const script = [
    "cd /Users/ella.taira/episode-bundles/episode-2643-v1-ddeval && \\",
    "  curl --fail-with-body -sS \\",
    "    -X POST 'https://eval-data-portal.us1.prod.dog/api/v1/scenarios/ingest' \\",
    "    -H 'Content-Type: application/json' \\",
    "    -d '{",
    '      "org_id": 1573830,',
    '      "s3_prefix": "gensim/episode-2643-v1-run-20260814-153312-30900-1hz-ddeval-v1",',
    '      "force": false,',
    '      "dry_run": false',
    "    }' | tee eval-data-portal-ingest.json"
  ].join("\n");
  const text = `Run this:\n\n\`\`\`bash\n${script}\n\`\`\``;

  assert.deepEqual(extractCliCommands(text), [script]);
  assert.equal(buildCopyChoices(text)[0].command, script);
});

test("copy keeps assignments, command substitutions, and blank lines as one shell script", () => {
  const script = [
    'EDP_URL="https://eval-data-portal.us1.prod.dog"',
    'S3_PREFIX="gensim/2026/06/08/release-e368d9d2-1780886687210399633"',
    "",
    'BODY="$(' ,
    "  jq -nc \\",
    "    --argjson org_id 1573830 \\",
    "    --arg s3_prefix \"$S3_PREFIX\" \\",
    "    '{",
    "      org_id: $org_id,",
    "      s3_prefix: $s3_prefix,",
    "      force: false,",
    "      dry_run: true",
    "    }'",
    ')"',
    "",
    "dd-auth --domain dd.datad0g.com -- \\",
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

test("session utilities register rewind, rename, and a non-conflicting command picker", async () => {
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
});
