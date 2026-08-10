import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	pairObservationMessage,
	parseCmuxSurface,
	terminalDelta,
	terminalOutputReady,
} from "../src/pair-terminal.mjs";

const POLL_MS = 750;
const QUIET_MS = 1_200;

export default function pairTerminalExtension(pi: ExtensionAPI) {
	let latestContext: ExtensionContext | undefined;
	let workspace = "";
	let surface = "";
	let lastScreen = "";
	let pendingScreen = "";
	let changedAt = 0;
	let analyzing = false;
	let agentBusy = false;
	let polling = false;
	let failures = 0;
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
				stop();
				latestContext?.ui?.notify?.(
					`Pair terminal disconnected: ${String(error)}`,
					"warning",
				);
			}
		} finally {
			polling = false;
		}
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
		workspace = "";
		surface = "";
		lastScreen = "";
		pendingScreen = "";
		changedAt = 0;
		analyzing = false;
		failures = 0;
		updateStatus();
	}

	async function start(ctx: ExtensionContext, requestFirstCommand: boolean) {
		latestContext = ctx;
		if (surface) return { workspace, surface, reused: true };
		workspace = process.env.CMUX_WORKSPACE_ID ?? "";
		const sourceSurface = process.env.CMUX_SURFACE_ID ?? "";
		if (!workspace || !sourceSurface) {
			throw new Error("Pair mode requires Pi to be running inside a cmux terminal");
		}
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
		surface = parseCmuxSurface(output);
		await new Promise((resolve) => setTimeout(resolve, 300));
		lastScreen = await readScreen().catch(() => "");
		pendingScreen = lastScreen;
		changedAt = Date.now();
		timer = setInterval(() => void poll(), POLL_MS);
		updateStatus();
		if (requestFirstCommand) {
			pi.sendMessage(
				{
					customType: "pi-pair-terminal-started",
					content: [
						"PAIR TERMINAL STARTED",
						"The user controls the visible neighboring terminal.",
						"Do not execute commands or call tools.",
						"Briefly state the goal and propose exactly one first command in one fenced shell block.",
					].join("\n"),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
		return { workspace, surface, reused: false };
	}

	async function action(value: string, ctx: ExtensionContext, fromCommand = false) {
		if (value === "start") return start(ctx, fromCommand);
		if (value === "stop") {
			const previous = surface;
			stop();
			return { stopped: Boolean(previous), surface: previous };
		}
		if (value === "status") return { active: Boolean(surface), workspace, surface };
		throw new Error("Pair action must be start, status, or stop");
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
						: ["start", "status"]);
					if (!selected) return;
				}
				const result = await action(selected, ctx, true);
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
			"Start, inspect, or stop a visible neighboring cmux terminal controlled by the user. Use start when the user wants to run commands manually while Pi observes and analyzes output. Never use cmux send or execute the proposed command; after starting, propose exactly one command for the user to run.",
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
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		latestContext = ctx;
		agentBusy = true;
	});

	pi.on("agent_end", async () => {
		agentBusy = false;
		analyzing = false;
	});

	pi.on("session_shutdown", async () => stop());
}
