import { watch, type FSWatcher } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { importFreshSourceModule } from "../src/fresh-module.mjs";
import { initialPetState, reducePetState } from "../src/pet-state.mjs";

export default async function lifecyclePetExtension(pi: ExtensionAPI) {
	const runtimePath = fileURLToPath(
		new URL("../src/pet-runtime.mjs", import.meta.url),
	);
	const {
		clearPetFocusRequest,
		createPetSnapshot,
		readPetFocusRequest,
		removePetSnapshot,
		writePetSnapshot,
	} = await importFreshSourceModule(runtimePath);
	let state = initialPetState();
	let enabled = true;
	let latestContext: ExtensionContext | undefined;
	let sessionId = "";
	let companionLaunchRequested = false;
	let snapshotMutation = Promise.resolve();
	let focusMutation = Promise.resolve();
	let focusWatcher: FSWatcher | undefined;

	const runtimeDir =
		process.env.PI_PET_RUNTIME_DIR ??
		path.join(homedir(), ".agents", "runtime", "pi-pet");
	const companionApp =
		process.env.PI_PET_APP ??
		fileURLToPath(new URL("../dist/PiPet.app", import.meta.url));
	const cmuxBin = process.env.PI_PET_CMUX_BIN ?? "cmux";

	async function launchCompanion() {
		if (companionLaunchRequested) return;
		await access(companionApp);
		const result = await pi.exec("open", ["-g", companionApp]);
		if (result.code !== 0) {
			throw new Error(
				result.stderr.trim() || result.stdout.trim() || `open exited ${result.code}`,
			);
		}
		companionLaunchRequested = true;
	}

	async function emit(ctx?: ExtensionContext, phase?: string) {
		if (ctx) latestContext = ctx;
		if (!enabled || !latestContext || !sessionId) return;

		const snapshot = createPetSnapshot({
			sessionId,
			pid: process.pid,
			state,
			phase,
			workspaceId: process.env.CMUX_WORKSPACE_ID,
			surfaceId: process.env.CMUX_SURFACE_ID,
		});
		const mutation = snapshotMutation.then(() => writePetSnapshot(runtimeDir, snapshot));
		snapshotMutation = mutation.then(
			() => undefined,
			() => undefined,
		);
		await mutation;
	}

	async function clearSnapshot() {
		if (!sessionId) return;
		const mutation = snapshotMutation.then(() => removePetSnapshot(runtimeDir, sessionId));
		snapshotMutation = mutation.then(
			() => undefined,
			() => undefined,
		);
		await mutation;
	}

	async function handleFocusRequest(ctx: ExtensionContext) {
		const request = await readPetFocusRequest(runtimeDir);
		if (!request || request.sessionId !== sessionId) return;
		try {
			const workspace = process.env.CMUX_WORKSPACE_ID;
			if (!workspace) {
				throw new Error("This Pi session is not running inside cmux");
			}
			const result = await pi.exec(cmuxBin, [
				"select-workspace",
				"--workspace",
				workspace,
			]);
			if (result.code !== 0) {
				throw new Error(
					result.stderr.trim() ||
						result.stdout.trim() ||
						`cmux exited ${result.code}`,
				);
			}
			if (process.env.PI_PET_SKIP_APP_FOCUS !== "1") {
				await pi.exec("open", ["-a", "cmux"]);
			}
		} catch (error) {
			ctx.ui.notify(`Pet could not focus cmux: ${String(error)}`, "warning");
		} finally {
			await clearPetFocusRequest(runtimeDir);
		}
	}

	async function startFocusWatcher(ctx: ExtensionContext) {
		const requestsDir = path.join(runtimeDir, "requests");
		await mkdir(requestsDir, { recursive: true, mode: 0o700 });
		focusWatcher?.close();
		focusWatcher = watch(requestsDir, { persistent: false }, (_event, filename) => {
			if (filename && filename !== "focus.json") return;
			const mutation = focusMutation.then(() => handleFocusRequest(ctx));
			focusMutation = mutation.then(
				() => undefined,
				() => undefined,
			);
		});
		await handleFocusRequest(ctx);
	}

	pi.registerCommand("pet", {
		description: "Control the floating macOS pet: /pet [on|off|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			try {
				if (action === "on") {
					enabled = true;
					latestContext = ctx;
					await launchCompanion();
					await emit(ctx);
				} else if (action === "off") {
					if (enabled) await clearSnapshot();
					enabled = false;
					companionLaunchRequested = false;
				} else if (action !== "status") {
					ctx.ui.notify("Usage: /pet [on|off|status]", "warning");
					return;
				}
				ctx.ui.notify(
					[
						`Floating Pi pet: ${enabled ? "enabled" : "disabled"}`,
						`Companion: ${companionLaunchRequested ? "launch requested" : "not launched"}`,
						`Session: ${sessionId || "not started"} · phase: ${state.phase}`,
						`cmux: ${process.env.CMUX_WORKSPACE_ID ?? "not attached"} · children: ${state.children}`,
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Floating pet failed: ${String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		state = initialPetState();
		latestContext = ctx;
		try {
			await launchCompanion();
			await emit(ctx);
			await startFocusWatcher(ctx);
		} catch (error) {
			ctx.ui.notify(`Floating pet unavailable: ${String(error)}`, "warning");
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		state = reducePetState(state, { type: "agent-start" });
		await emit(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		state = reducePetState(state, { type: "tool-start", toolName: event.toolName });
		await emit(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		state = reducePetState(state, { type: "tool-end", isError: event.isError });
		await emit(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		state = reducePetState(state, { type: "agent-settled" });
		await emit(ctx);
	});

	pi.events.on("subagent:async-started", async () => {
		state = reducePetState(state, { type: "subagent-start" });
		await emit();
	});

	pi.events.on("subagent:async-complete", async () => {
		state = reducePetState(state, { type: "subagent-complete" });
		await emit();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		focusWatcher?.close();
		focusWatcher = undefined;
		if (enabled) await clearSnapshot();
	});
}
