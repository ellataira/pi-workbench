import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the complete Pi and cmux guide shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Pi \+ cmux Field Guide<\/title>/i);
  assert.match(html, /Pi \+ cmux guide/i);
  assert.match(html, /A practical reference for sessions, tools, memory, and workflows/i);
  assert.match(html, /First 10 minutes/i);
  assert.match(html, /Action inbox/i);
  assert.match(html, /Worktree lifecycle/i);
  assert.match(html, /Memory and retention/i);
  assert.match(html, /Project profiles/i);
  assert.match(html, /documentation and writing/i);
  assert.match(html, /\/profile writing/i);
  assert.match(html, /Switch repositories/i);
  assert.match(html, /\/workspace back/i);
  assert.match(html, /MCP and connected services/i);
  assert.match(html, /Troubleshooting/i);
  assert.doesNotMatch(html, /hero-map|status-strip|Your agent cockpit|codex-preview|Your site is taking shape/i);
});

test("ships searchable controls and preserved source references", async () => {
  const [page, readme, quickstart, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/README.md", import.meta.url), "utf8"),
    readFile(new URL("../public/QUICKSTART.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /type="search"/);
  assert.match(page, /aria-label="Search guide"/);
  assert.match(page, /\/README\.md/);
  assert.match(page, /\/QUICKSTART\.md/);
  assert.match(page, /\/CHANGELOG\.md/);
  assert.match(readme, /Action inbox and project profiles/);
  assert.match(quickstart, /Pi \+ cmux quickstart/);
  assert.match(quickstart, /New command quick reference/);
  assert.match(quickstart, /\/agents persistent <task>/);
  assert.match(quickstart, /\/memory cleanup/);
  assert.match(quickstart, /\/review git staged/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
