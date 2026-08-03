import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
	buildWorkspaceChoices,
	currentWorkspaceState,
	performWorkspaceSwitch,
	resolveWorkspaceTarget,
} from "../src/workspace-switch.mjs";

export default function workspaceSwitchExtension(pi: ExtensionAPI) {
	pi.registerCommand("workspace", {
		description: "Show, switch, or return to a repository without losing conversation context",
		handler: async (args, ctx) => {
			try {
				let requested = args.trim();
				const state = currentWorkspaceState(
					ctx.sessionManager.getBranch(),
					ctx.cwd,
				);
				if (!requested) {
					const choices = buildWorkspaceChoices(state);
					const selected = await ctx.ui.select(
						`Workspace · active: ${ctx.cwd}`,
						choices.map((choice) => choice.label),
					);
					if (!selected) return;
					const choice = choices.find((candidate) => candidate.label === selected);
					requested = choice?.path ?? (await ctx.ui.input("Repository path", ""));
					if (!requested?.trim()) return;
				}
				if (requested === "show") {
					const previous = state.history.at(-1);
					ctx.ui.notify(
						[
							`Active workspace: ${ctx.cwd}`,
							previous ? `Previous workspace: ${previous}` : undefined,
						]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
					return;
				}

				const back = requested === "back";
				const targetInput = back ? state.history.at(-1) : requested;
				if (!targetInput) {
					throw new Error("No previous workspace is available");
				}
				const targetCwd = await resolveWorkspaceTarget(targetInput, {
					cwd: ctx.cwd,
					home: homedir(),
					stat,
					realpath,
					gitRoot: async (candidate: string) => {
						const result = await pi.exec("git", [
							"-C",
							candidate,
							"rev-parse",
							"--show-toplevel",
						]);
						return result.code === 0 ? result.stdout : "";
					},
				});
				const sourceSessionFile = ctx.sessionManager.getSessionFile() ?? "";
				await ctx.waitForIdle();
				const result = await performWorkspaceSwitch({
					currentCwd: ctx.cwd,
					targetCwd,
					sourceSessionFile,
					history: state.history,
					back,
					forkSession: (source: string, target: string) =>
						SessionManager.forkFrom(source, target),
					switchSession: (sessionFile: string) =>
						ctx.switchSession(sessionFile, {
							withSession: async (next) => {
								next.ui.notify(
									`Workspace switched to ${path.basename(targetCwd)}.\nConversation preserved; target project context and skills are active.`,
									"info",
								);
							},
						}),
				});
				if (result.cancelled) return;
			} catch (error) {
				ctx.ui.notify(`Workspace switch failed: ${String(error)}`, "error");
			}
		},
	});
}
