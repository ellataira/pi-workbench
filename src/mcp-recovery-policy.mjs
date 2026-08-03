const CONNECTOR_PROMPT =
  /\b(?:mcp|connector|confluence|atlassian|jira|slack|google workspace|google drive|drive (?:mcp|file|archive)|from drive)\b/i;

export function shouldInjectConnectorRecovery(prompt) {
  return CONNECTOR_PROMPT.test(String(prompt ?? ""));
}

export function connectorRecoveryInstructions() {
  return `MCP CONNECTOR RECOVERY
When a connector fails, continue through safe diagnosis and repair instead of stopping at a generic authentication message.
- Treat /mcp as the only user-facing connector entry point. Do not recommend /mcp-auth; authentication ownership depends on the configured transport.
- Distinguish transport success, tool discovery, and a successful real tool call. A connected server or cached catalog does not prove product authorization.
- Inspect the effective Pi MCP configuration and running transport. Distinguish Pi-native HTTP OAuth from OAuth owned by a stdio bridge; do not send a stdio bridge through Pi-native OAuth.
- Verify endpoints and authentication methods against current official vendor documentation or live discovery metadata, not cached assumptions.
- If the fault is confined to local Pi configuration, make the minimal reversible repair, preserve endpoint-specific credentials before resetting them, and never expose a token or secret.
- Reload or reconnect, then prove recovery with the least-privileged identity/resource lookup and one real read-only tool call.
- Ask the user only for browser consent, a secret, an administrator-only policy change, or an ambiguous/destructive decision. If authoritative verification is unavailable, report the exact failing boundary instead of guessing.`;
}
