import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	buildProfileChoices,
	mergeProfiles,
	normalizeProfile,
	profileInstructions,
} from "../src/project-profiles.mjs";

type Profile = ReturnType<typeof normalizeProfile>;
type ProfileConfig = {
	default?: string;
	profiles: Record<string, Profile>;
};

export default function projectProfilesExtension(pi: ExtensionAPI) {
	const globalPath =
		process.env.PI_PROJECT_PROFILES_PATH ??
		path.join(homedir(), ".pi", "agent", "project-profiles.json");
	let profiles: Record<string, Profile> = {};
	let activeName: string | undefined;
	let activeProfile: Profile | undefined;
	let original:
		| {
				model: ExtensionContext["model"];
				thinkingLevel: ReturnType<typeof pi.getThinkingLevel>;
				tools: string[];
		  }
		| undefined;

	pi.registerFlag("profile", {
		description: "Apply a project profile by name",
		type: "string",
	});

	async function readConfig(file: string): Promise<ProfileConfig> {
		try {
			const parsed = JSON.parse(await readFile(file, "utf8"));
			const rawProfiles =
				parsed?.profiles && typeof parsed.profiles === "object"
					? parsed.profiles
					: parsed;
			return {
				default:
					typeof parsed?.default === "string" ? parsed.default : undefined,
				profiles: mergeProfiles({}, rawProfiles),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { profiles: {} };
			}
			throw new Error(`Invalid project profile config ${file}: ${String(error)}`);
		}
	}

	async function loadProfiles(cwd: string) {
		const projectPath = path.join(cwd, ".pi", "project-profiles.json");
		const global = await readConfig(globalPath);
		const project = await readConfig(projectPath);
		profiles = mergeProfiles(global.profiles, project.profiles);
		return {
			default: project.default ?? global.default,
			projectPath,
		};
	}

	async function applyProfile(
		name: string,
		profile: Profile,
		ctx: ExtensionContext,
	) {
		const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const unknownTools = (profile.tools ?? []).filter((tool) => !allTools.has(tool));
		if (unknownTools.length) {
			throw new Error(`Profile ${name} has unknown tools: ${unknownTools.join(", ")}`);
		}
		const model =
			profile.provider && profile.model
				? ctx.modelRegistry.find(profile.provider, profile.model)
				: undefined;
		if (profile.provider && profile.model && !model) {
			throw new Error(`Profile ${name} model was not found: ${profile.provider}/${profile.model}`);
		}
		if (!original) {
			original = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}
		if (original?.model && activeName) await pi.setModel(original.model);
		if (original && activeName) {
			pi.setThinkingLevel(original.thinkingLevel);
			pi.setActiveTools(original.tools);
		}
		if (model && !(await pi.setModel(model))) {
			throw new Error(`Profile ${name} model authentication is unavailable`);
		}
		if (profile.thinkingLevel) pi.setThinkingLevel(profile.thinkingLevel);
		if (profile.tools) pi.setActiveTools(profile.tools);
		activeName = name;
		activeProfile = profile;
		ctx.ui.setStatus("project-profile", `profile:${name}`);
	}

	async function clearProfile(ctx: ExtensionContext) {
		if (original?.model) await pi.setModel(original.model);
		if (original) {
			pi.setThinkingLevel(original.thinkingLevel);
			pi.setActiveTools(original.tools);
		}
		activeName = undefined;
		activeProfile = undefined;
		ctx.ui.setStatus("project-profile", undefined);
	}

	pi.registerCommand("profile", {
		description: "List, apply, reload, or clear project profiles",
		handler: async (args, ctx) => {
			try {
				const requested = args.trim();
				if (!requested) {
					const choices = buildProfileChoices(profiles, activeName);
					const selected = await ctx.ui.select(
						"Project profile · choose a working mode",
						choices.map((choice) => choice.label),
					);
					if (!selected) return;
					const choice = choices.find((candidate) => candidate.label === selected);
					if (!choice) return;
					if (choice.name === "off") {
						await clearProfile(ctx);
					} else {
						await applyProfile(choice.name, profiles[choice.name], ctx);
					}
					return;
				}
				if (requested === "list") {
					ctx.ui.notify(
						Object.keys(profiles).length
							? buildProfileChoices(profiles, activeName)
									.filter((choice) => choice.name !== "off")
									.map((choice) => choice.label)
									.join("\n")
							: "No project profiles configured.",
						"info",
					);
					return;
				}
				if (requested === "reload") {
					const previouslyActive = activeName;
					await loadProfiles(ctx.cwd);
					if (previouslyActive && profiles[previouslyActive]) {
						await applyProfile(previouslyActive, profiles[previouslyActive], ctx);
						ctx.ui.notify(`Profiles reloaded · reapplied ${previouslyActive}`, "info");
					} else if (previouslyActive) {
						await clearProfile(ctx);
						ctx.ui.notify(`Profiles reloaded · ${previouslyActive} no longer exists`, "warning");
					} else {
						ctx.ui.notify("Project profiles reloaded.", "info");
					}
					return;
				}
				if (requested === "clear" || requested === "none") {
					await clearProfile(ctx);
					ctx.ui.notify("Project profile cleared.", "info");
					return;
				}
				const profile = profiles[requested];
				if (!profile) throw new Error(`Unknown project profile: ${requested}`);
				await applyProfile(requested, profile, ctx);
				ctx.ui.notify(`Project profile ${requested} applied.`, "info");
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const config = await loadProfiles(ctx.cwd);
			const requested = String(pi.getFlag("profile") ?? config.default ?? "").trim();
			if (!requested) return;
			const profile = profiles[requested];
			if (!profile) {
				ctx.ui.notify(
					`Configured project profile does not exist: ${requested}`,
					"warning",
				);
				return;
			}
			await applyProfile(requested, profile, ctx);
		} catch (error) {
			ctx.ui.notify(`Project profile failed: ${String(error)}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeName || !activeProfile) return;
		const instructions = profileInstructions(activeName, activeProfile);
		if (!instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});
}
