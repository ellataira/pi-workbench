import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importFreshSourceModule } from "../src/fresh-module.mjs";

const POLL_MS = 750;
const QUIET_MS = 1_200;

export default async function pairTerminalExtension(pi: ExtensionAPI) {
	const pairTerminalPath = fileURLToPath(
		new URL("../src/pair-terminal.mjs", import.meta.url),
	);
	const {
		clearPairSuggestion,
		pairTerminalLaunchCommand,
		pairObservationMessage,
		pairSuggestionFromMessages,
		pairSuggestionPath,
		parseCmuxSurface,
		parsePairCandidateSurfaces,
		readPairBinding,
		removePairBinding,
		shouldPreservePairOnShutdown,
		terminalDelta,
		terminalOutputReady,
		writePairBinding,
		writePairSuggestion,
		writePairZshProfile,
	} = await importFreshSourceModule(pairTerminalPath);
	const bindingRoot = path.join(homedir(), ".agents", "runtime", "pi-pair", "bindings");
	const zshProfileRoot = path.join(homedir(), ".agents", "runtime", "pi-pair", "zsh-profile");
	const suggestionRoot = path.join(homedir(), ".agents", "runtime", "pi-pair", "suggestions");
	let latestContext: ExtensionContext | undefined;
	let workspace = "";
	let sourceSurface = "";
	let surface = "";
	let lastScreen = "";
	let pendingScreen = "";
	let changedAt = 0;
	let analyzing = false;
	let agentBusy = false;
	let polling = false;
	let failures = 0;
	let suggestionFile = "";
	let awaitingSuggestion = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	async function cmux(args: string[]) {
		const result = await pi.exec("cmux", args);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "cmux command failed");
		return result.stdout;
	}

	function updateStatus() {
		if (!latestContext?.hasUI) return;
		latestContext.ui.setStatus(
			"pair-terminal",
			surface ? `pair:watching · ${surface}` : undefined,
		);
	}

	async function readScreen() {
		return cmux([
			"read-screen",
			"--workspace",
			workspace,
			"--surface",
			surface,
			"--lines",
			"120",
		]);
	}

	function beginPolling() {
		if (timer) clearInterval(timer);
		timer = setInterval(() => void poll(), POLL_MS);
	}

	async function saveBinding() {
		await writePairBinding(bindingRoot, {
			workspace,
			sourceSurface,
			pairSurface: surface,
		});
	}

	function restoreSuggestionPath() {
		suggestionFile = workspace && sourceSurface
			? pairSuggestionPath(suggestionRoot, workspace, sourceSurface)
			: "";
	}

	async function restorePairBinding(ctx: ExtensionContext) {
		latestContext = ctx;
		if (surface) return true;
		const ownerWorkspace = process.env.CMUX_WORKSPACE_ID ?? "";
		const ownerSurface = process.env.CMUX_SURFACE_ID ?? "";
		const binding = await readPairBinding(bindingRoot, ownerWorkspace, ownerSurface);
		if (!binding) return false;
		workspace = binding.workspace;
		sourceSurface = binding.sourceSurface;
		surface = binding.pairSurface;
		restoreSuggestionPath();
		try {
			lastScreen = await readScreen();
			pendingScreen = lastScreen;
			changedAt = Date.now();
			beginPolling();
			updateStatus();
			return true;
		} catch {
			await removePairBinding(bindingRoot, ownerWorkspace, ownerSurface);
			workspace = "";
			sourceSurface = "";
			surface = "";
			return false;
		}
	}

	async function poll() {
		if (!surface || polling) return;
		polling = true;
		try {
			const screen = await readScreen();
			failures = 0;
			if (screen !== pendingScreen) {
				pendingScreen = screen;
				changedAt = Date.now();
				return;
			}
			if (agentBusy || analyzing || screen === lastScreen) return;
			const quietMs = Date.now() - changedAt;
			if (quietMs < QUIET_MS) return;
			const delta = terminalDelta(lastScreen, screen);
			if (!delta || !terminalOutputReady(delta, screen, quietMs)) return;
			lastScreen = screen;
			analyzing = true;
			awaitingSuggestion = true;
			await clearPairSuggestion(suggestionFile);
			pi.sendMessage(
				{
					customType: "pi-pair-terminal-observation",
					content: pairObservationMessage(delta),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (error) {
			failures += 1;
			if (failures >= 3) {
				await stop({ closeSurface: false });
				latestContext?.ui?.notify?.(
					`Pair terminal was closed or disconnected: ${String(error)}`,
					"warning",
				);
			}
		} finally {
			polling = false;
		}
	}

	async function stop({ closeSurface = true } = {}) {
		const ownerWorkspace = process.env.CMUX_WORKSPACE_ID ?? workspace;
		const ownerSurface = process.env.CMUX_SURFACE_ID ?? sourceSurface;
		const stored = !surface
			? await readPairBinding(bindingRoot, ownerWorkspace, ownerSurface)
			: undefined;
		const previousWorkspace = workspace || stored?.workspace || "";
		const previousSurface = surface || stored?.pairSurface || "";
		const previousSuggestionFile = suggestionFile || (
			previousWorkspace && ownerSurface
				? pairSuggestionPath(suggestionRoot, previousWorkspace, ownerSurface)
				: ""
		);
		if (timer) clearInterval(timer);
		timer = undefined;
		workspace = "";
		sourceSurface = "";
		surface = "";
		lastScreen = "";
		pendingScreen = "";
		changedAt = 0;
		analyzing = false;
		failures = 0;
		suggestionFile = "";
		awaitingSuggestion = false;
		updateStatus();
		await removePairBinding(bindingRoot, ownerWorkspace, ownerSurface);
		await clearPairSuggestion(previousSuggestionFile);
		if (closeSurface && previousSurface) {
			await cmux([
				"close-surface",
				"--workspace",
				previousWorkspace,
				"--surface",
				previousSurface,
			]);
		}
	}

	function detachForSessionReplacement() {
		if (timer) clearInterval(timer);
		timer = undefined;
		workspace = "";
		sourceSurface = "";
		surface = "";
		lastScreen = "";
		pendingScreen = "";
		changedAt = 0;
		analyzing = false;
		failures = 0;
		suggestionFile = "";
		awaitingSuggestion = false;
		updateStatus();
	}

	async function start(ctx: ExtensionContext, requestFirstCommand: boolean) {
		latestContext = ctx;
		await restorePairBinding(ctx);
		if (surface) return { workspace, surface, reused: true };
		workspace = process.env.CMUX_WORKSPACE_ID ?? "";
		sourceSurface = process.env.CMUX_SURFACE_ID ?? "";
		if (!workspace || !sourceSurface) {
			throw new Error("Pair mode requires Pi to be running inside a cmux terminal");
		}
		restoreSuggestionPath();
		await clearPairSuggestion(suggestionFile);
		const shell = process.env.SHELL ?? "/bin/zsh";
		const zshProfile = path.basename(shell) === "zsh"
			? await writePairZshProfile(zshProfileRoot, process.env.ZDOTDIR ?? homedir())
			: undefined;
		const output = await cmux([
			"new-split",
			"right",
			"--workspace",
			workspace,
			"--surface",
			sourceSurface,
			"--focus",
			"false",
		]);
		const createdSurface = parseCmuxSurface(output);
		try {
			await cmux([
				"respawn-pane",
				"--workspace",
				workspace,
				"--surface",
				createdSurface,
				"--command",
				pairTerminalLaunchCommand(shell, zshProfile, suggestionFile),
			]);
		} catch (error) {
			await cmux([
				"close-surface",
				"--workspace",
				workspace,
				"--surface",
				createdSurface,
			]).catch(() => undefined);
			workspace = "";
			throw error;
		}
		surface = createdSurface;
		try {
			await saveBinding();
		} catch (error) {
			await cmux([
				"close-surface",
				"--workspace",
				workspace,
				"--surface",
				createdSurface,
			]).catch(() => undefined);
			workspace = "";
			sourceSurface = "";
			surface = "";
			throw error;
		}
		await cmux([
			"rename-tab",
			"--workspace",
			workspace,
			"--surface",
			surface,
			"Pi Pair Terminal",
		]).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 300));
		lastScreen = await readScreen().catch(() => "");
		pendingScreen = lastScreen;
		changedAt = Date.now();
		beginPolling();
		updateStatus();
		if (requestFirstCommand) {
			awaitingSuggestion = true;
			pi.sendMessage(
				{
					customType: "pi-pair-terminal-started",
					content: [
						"PAIR TERMINAL STARTED",
						"The user controls the visible neighboring terminal.",
						"Do not execute commands or call tools.",
						"Briefly state the goal and propose exactly one first command in one fenced shell block. The user can press Tab in the empty paired prompt to insert it without executing it.",
					].join("\n"),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
		return { workspace, surface, reused: false };
	}

	async function reconnect(ctx: ExtensionContext) {
		latestContext = ctx;
		if (await restorePairBinding(ctx)) return { workspace, surface, reused: true };
		const ownerWorkspace = process.env.CMUX_WORKSPACE_ID ?? "";
		const ownerSurface = process.env.CMUX_SURFACE_ID ?? "";
		if (!ownerWorkspace || !ownerSurface) {
			throw new Error("Pair mode requires Pi to be running inside a cmux terminal");
		}
		const tree = await cmux(["tree", "--workspace", ownerWorkspace]);
		const choices: Array<{ label: string; surface: string }> = [];
		for (const candidate of parsePairCandidateSurfaces(tree, ownerSurface)) {
			try {
				const screen = await cmux([
					"read-screen",
					"--workspace",
					ownerWorkspace,
					"--surface",
					candidate,
					"--lines",
					"3",
				]);
				const preview = screen.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "terminal";
				choices.push({ label: `${candidate} · ${preview.slice(0, 80)}`, surface: candidate });
			} catch {
				// Browser and unavailable surfaces are not reconnect candidates.
			}
		}
		if (!choices.length) throw new Error("No other terminal surfaces are available to reconnect");
		const selected = await ctx.ui.select("Reconnect which paired terminal?", choices.map((choice) => choice.label));
		if (!selected) return { workspace: "", surface: "", cancelled: true };
		const chosen = choices.find((choice) => choice.label === selected);
		if (!chosen) throw new Error("The selected terminal is no longer available");
		workspace = ownerWorkspace;
		sourceSurface = ownerSurface;
		surface = chosen.surface;
		restoreSuggestionPath();
		lastScreen = await readScreen();
		pendingScreen = lastScreen;
		changedAt = Date.now();
		await saveBinding();
		beginPolling();
		updateStatus();
		return { workspace, surface, reconnected: true };
	}

	async function action(value: string, ctx: ExtensionContext, fromCommand = false) {
		if (value === "start") return start(ctx, fromCommand);
		if (value === "reconnect") return reconnect(ctx);
		if (value === "stop") {
			const previous = surface;
			await stop();
			return { stopped: Boolean(previous), surface: previous };
		}
		if (value === "status") {
			await restorePairBinding(ctx);
			return { active: Boolean(surface), workspace, surface };
		}
		throw new Error("Pair action must be start, reconnect, status, or stop");
	}

	pi.registerCommand("pair", {
		description: "Pair through a visible neighboring terminal you control",
		handler: async (args, ctx) => {
			latestContext = ctx;
			try {
				let selected = args.trim();
				if (!selected) {
					selected = await ctx.ui.select("Pair terminal", surface
						? ["status", "stop"]
						: ["start", "reconnect", "status"]);
					if (!selected) return;
				}
				const result = await action(selected, ctx, true);
				if (selected === "start" || selected === "reconnect") {
					pi.appendEntry("pi-pair-open-metrics", {
						action: selected,
						at: new Date().toISOString(),
					});
				}
				ctx.ui.notify(`Pair terminal · ${JSON.stringify(result)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Pair terminal failed: ${String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "pair_terminal",
		label: "Pair terminal",
		description:
			"Start, inspect, or stop a visible neighboring cmux terminal controlled by the user. If the user asks whether Pi is watching or connected, call status and report the exact active state instead of describing the feature generally. Use start when the user wants to run commands manually while Pi observes and analyzes output. Never use cmux send or execute the proposed command; after starting, propose exactly one command for the user to run.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("status"),
				Type.Literal("stop"),
			]),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestContext = ctx;
			const result = await action(params.action, ctx, false);
			if (params.action === "start") {
				awaitingSuggestion = true;
				pi.appendEntry("pi-pair-open-metrics", {
					action: "start",
					at: new Date().toISOString(),
				});
			}
			return {
				content: [{
					type: "text",
					text: params.action === "start"
						? "Visible pair terminal started. Do not execute anything; propose exactly one command for the user to run."
						: `Pair terminal ${params.action}: ${JSON.stringify(result)}`,
				}],
				details: result,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		await restorePairBinding(ctx).catch(() => undefined);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		latestContext = ctx;
		agentBusy = true;
	});

	pi.on("agent_end", async (event) => {
		try {
			if (awaitingSuggestion && suggestionFile) {
				const suggestion = pairSuggestionFromMessages(event.messages);
				if (suggestion) await writePairSuggestion(suggestionFile, suggestion);
				else await clearPairSuggestion(suggestionFile);
			}
		} catch (error) {
			await clearPairSuggestion(suggestionFile).catch(() => undefined);
			latestContext?.ui?.notify?.(
				`Pair Tab suggestion unavailable: ${String(error)}`,
				"warning",
			);
		} finally {
			awaitingSuggestion = false;
			agentBusy = false;
			analyzing = false;
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (shouldPreservePairOnShutdown(event.reason)) {
			detachForSessionReplacement();
			return;
		}
		await stop().catch(() => undefined);
	});
}
