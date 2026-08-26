import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const configPath = new URL("../config/pi/mcp.json", import.meta.url);

async function loadConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

test("Pi MCP config is self-contained instead of merging vendor configs", async () => {
  const config = await loadConfig();
  assert.deepEqual(config.imports ?? [], []);
});

test("each MCP server has exactly one transport", async () => {
  const config = await loadConfig();

  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.disabled === true && !server.command && !server.url) continue;

    const hasCommand = typeof server.command === "string";
    const hasUrl = typeof server.url === "string";
    assert.notEqual(
      hasCommand,
      hasUrl,
      `${name} must define exactly one of command or url`
    );

    if (hasCommand) {
      assert.equal("auth" in server, false, `${name} stdio config must not inherit auth`);
      assert.equal("oauth" in server, false, `${name} stdio config must not inherit oauth`);
    }
  }
});

test("Atlassian uses the scoped OAuth 2.1 endpoint", async () => {
  const config = await loadConfig();
  assert.deepEqual(config.mcpServers.atlassian, {
    command: "npx",
    args: [
      "-y",
      "mcp-remote@0.1.38",
      "https://mcp.atlassian.com/v1/mcp/authv2",
      "--transport",
      "http-only"
    ],
    lifecycle: "lazy"
  });
});

test("Slack uses the shared Keychain proxy without starting Pi OAuth", async () => {
  const config = await loadConfig();
  assert.equal(config.mcpServers.slack.command, "python3");
  assert.deepEqual(config.mcpServers.slack.args, [
    "__HOME__/.agents/skills/slack-mcp/scripts/slack-mcp-proxy.py"
  ]);
  assert.equal("url" in config.mcpServers.slack, false);
  assert.equal("oauth" in config.mcpServers.slack, false);
});

test("portable MCP config omits organization-specific Workspace endpoints", async () => {
  const config = await loadConfig();
  assert.equal(config.mcpServers["google-workspace"], undefined);
});

test("Trajectory MCP uses the installed user-level binary", async () => {
  const config = await loadConfig();
  assert.deepEqual(config.mcpServers.trajectory, {
    command: "__HOME__/.trajectory/bin/trajectory",
    args: ["mcp"],
    lifecycle: "eager"
  });
});
