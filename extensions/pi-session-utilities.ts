import { fileURLToPath } from "node:url";

import {
	copyToClipboard,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { importFreshSourceModule } from "../src/fresh-module.mjs";

export default async function sessionUtilitiesExtension(pi: ExtensionAPI) {
	const utilitiesPath = fileURLToPath(
		new URL("../src/session-utilities.mjs", import.meta.url),
	);
	const {
		buildCopyChoices,
		buildRewindChoices,
		latestAssistantText,
	} = await importFreshSourceModule(utilitiesPath);

	pi.registerCommand("rewind", {
		description: "Choose an earlier chat point and resume from there",
		handler: async (_args, ctx) => {
			const choices = buildRewindChoices(ctx.sessionManager.getBranch());
			if (!choices.length) {
				ctx.ui.notify("No earlier user messages are available.", "info");
				return;
			}
			const selected = await ctx.ui.select(
				"Where should this chat resume?",
				choices.map((choice: any) => choice.label),
			);
			if (!selected) return;
			const choice = choices.find((candidate: any) => candidate.label === selected);
			if (!choice) return;
			const result = await ctx.navigateTree(choice.entryId, { summarize: false });
			if (!result.cancelled) {
				ctx.ui.notify("Resumed from the selected chat point. The previous branch is preserved.", "info");
			}
		},
	});

	pi.registerCommand("rename", {
		description: "Rename the current Pi session",
		handler: async (args, ctx) => {
			const name = String(args ?? "").trim();
			if (!name) {
				const current = pi.getSessionName();
				ctx.ui.notify(
					current ? `Current session name: ${current}` : "Usage: /rename <name>",
					current ? "info" : "warning",
				);
				return;
			}
			pi.setSessionName(name);
			const normalized = pi.getSessionName() ?? name;
			ctx.ui.notify(`Session renamed: ${normalized}`, "info");
		},
	});

	pi.registerCommand("copy-command", {
		description: "Copy a CLI command from the latest Pi response",
		handler: async (_args, ctx) => {
			const choices = buildCopyChoices(
				latestAssistantText(ctx.sessionManager.getBranch()),
			);
			if (!choices.length) {
				ctx.ui.notify("There is no Pi response to copy yet.", "info");
				return;
			}
			const selected = await ctx.ui.select(
				"Which command should be copied?",
				choices.map((choice: any) => choice.label),
			);
			if (!selected) return;
			const choice = choices.find((candidate: any) => candidate.label === selected);
			if (!choice) return;
			await copyToClipboard(choice.command);
			ctx.ui.notify("Command copied to the clipboard.", "info");
		},
	});
}
