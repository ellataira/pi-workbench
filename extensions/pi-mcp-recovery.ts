import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	connectorRecoveryInstructions,
	shouldInjectConnectorRecovery,
} from "../src/mcp-recovery-policy.mjs";

export default function mcpRecoveryExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (!shouldInjectConnectorRecovery(event.prompt)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${connectorRecoveryInstructions()}`,
		};
	});
}
