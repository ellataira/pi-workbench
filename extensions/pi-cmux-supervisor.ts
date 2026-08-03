import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	buildAgentChoices,
	buildChildCommand,
	buildSpawnArguments,
	buildWorktreeArguments,
	childWorktreePlan,
	orchestrationPolicy,
	parseWorkspaceIdentifiers,
	requireOwnedWorkspace,
	shellQuote,
} from "../src/cmux-supervisor.mjs";
import {
	classifyOwnedWorktree,
	cleanupEligibility,
	recoveryPlan,
} from "../src/worktree-lifecycle.mjs";

const Action = Type.Union([
	Type.Literal("spawn"),
	Type.Literal("list"),
	Type.Literal("focus"),
	Type.Literal("send"),
	Type.Literal("interrupt"),
	Type.Literal("status"),
	Type.Literal("recover"),
	Type.Literal("prepare-patch"),
	Type.Literal("cleanup"),
]);

export default function cmuxSupervisorExtension(pi: ExtensionAPI) {
	const registryPath =
		process.env.PI_CMUX_CHILD_REGISTRY ??
		path.join(homedir(), ".pi", "agent", "cmux-children.json");
	const worktreeBaseDir =
		process.env.PI_CMUX_WORKTREE_BASE ??
		path.join(homedir(), ".pi", "agent", "worktrees");
	let registryMutation = Promise.resolve();

	type OwnedChild = {
		identifiers: string[];
		sessionId: string;
		parentSessionId: string;
		name: string;
		createdAt: string;
		cwd: string;
		repositoryRoot?: string;
		worktreePath?: string;
		branch?: string;
		baseCommit?: string;
	};

	async function readRegistry(): Promise<OwnedChild[]> {
		try {
			const parsed = JSON.parse(await readFile(registryPath, "utf8"));
			return Array.isArray(parsed?.children) ? parsed.children : [];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async function writeRegistry(children: OwnedChild[]) {
		await mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 });
		const temporary = `${registryPath}.${process.pid}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ version: 1, children }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		await rename(temporary, registryPath);
		await chmod(registryPath, 0o600);
	}

	async function appendRegistry(child: OwnedChild) {
		return mutateRegistry((children) => [...children, child]);
	}

	async function mutateRegistry(
		update: (children: OwnedChild[]) => OwnedChild[],
	) {
		const mutation = registryMutation.then(async () => {
			const children = await readRegistry();
			const next = update(children);
			await writeRegistry(next);
			return next;
		});
		registryMutation = mutation.catch(() => {});
		return mutation;
	}

	async function cmux(args: string[]) {
		if (!process.env.CMUX_WORKSPACE_ID) {
			throw new Error("cmux_session requires Pi to be running inside a cmux terminal");
		}
		const result = await pi.exec("cmux", args);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `cmux exited ${result.code}`);
		}
		return result.stdout.trim();
	}

	async function spawn(
		params: {
			name?: string;
			task?: string;
			cwd?: string;
			childClass?: "lightweight" | "substantial";
		},
		parentSessionId: string,
	) {
		if (!params.task?.trim()) throw new Error("spawn requires a concrete task");
		if (params.childClass === "lightweight") {
			throw new Error("Lightweight fan-out must use background pi-subagents, not cmux");
		}
		const sessionId = randomUUID();
		const name = params.name?.trim() || `child-${sessionId.slice(0, 8)}`;
		const requestedCwd = params.cwd?.trim() || process.cwd();
		let childCwd = requestedCwd;
		let worktree:
			| { path: string; branch: string; repositoryRoot: string }
			| undefined;

		const rootResult = await pi.exec("git", [
			"-C",
			requestedCwd,
			"rev-parse",
			"--show-toplevel",
		]);
		if (rootResult.code !== 0) {
			throw new Error(
				"Implementing cmux children require a Git repository for their isolated worktree",
			);
		}
		const repositoryRoot = rootResult.stdout.trim();
		const baseResult = await pi.exec("git", [
			"-C",
			repositoryRoot,
			"rev-parse",
			"HEAD",
		]);
		if (baseResult.code !== 0) {
			throw new Error("Unable to resolve the child worktree base commit");
		}
		const baseCommit = baseResult.stdout.trim();
		const plan = childWorktreePlan({
			repoRoot: repositoryRoot,
			worktreeBaseDir,
			name,
			sessionId,
		});
		await mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
		const result = await pi.exec("git", [
			"-C",
			repositoryRoot,
			...buildWorktreeArguments({ ...plan, baseRef: "HEAD" }),
		]);
		if (result.code !== 0) {
			throw new Error(
				result.stderr.trim() ||
					result.stdout.trim() ||
					"Failed to create isolated child worktree",
			);
		}
		worktree = { ...plan, repositoryRoot };
		childCwd = plan.path;

		const command = buildChildCommand({
			sessionId,
			name,
			task: params.task,
			parentSessionId,
			childClass: "substantial",
		});
		let identifiers: string[] | undefined;
		try {
			const output = await cmux(
				buildSpawnArguments({
					name: `Pi · ${name}`,
					cwd: childCwd,
					command,
				}),
			);
			identifiers = parseWorkspaceIdentifiers(output);
			const child: OwnedChild = {
				identifiers,
				sessionId,
				parentSessionId,
				name,
				createdAt: new Date().toISOString(),
				cwd: childCwd,
				repositoryRoot: worktree?.repositoryRoot,
				worktreePath: worktree?.path,
				branch: worktree?.branch,
				baseCommit,
			};
			await appendRegistry(child);
			return { ...child, output };
		} catch (error) {
			if (identifiers?.[0]) {
				try {
					await cmux(["close-workspace", "--workspace", identifiers[0]]);
				} catch {
					// Preserve the original failure; the orphan workspace remains visible in cmux.
				}
			}
			if (worktree) {
				await pi.exec("git", [
					"-C",
					worktree.repositoryRoot,
					"worktree",
					"remove",
					"--force",
					worktree.path,
				]);
				await pi.exec("git", [
					"-C",
					worktree.repositoryRoot,
					"branch",
					"-D",
					worktree.branch,
				]);
			}
			throw error;
		}
	}

	function findChild(children: OwnedChild[], sessionId?: string) {
		if (!sessionId) throw new Error("A child sessionId is required");
		const child = children.find((candidate) => candidate.sessionId === sessionId);
		if (!child) throw new Error(`Unknown owned child session: ${sessionId}`);
		return child;
	}

	async function pathExists(value?: string) {
		if (!value) return false;
		try {
			await access(value);
			return true;
		} catch {
			return false;
		}
	}

	async function workspaceStatus(child: OwnedChild) {
		if (!process.env.CMUX_WORKSPACE_ID) {
			return { known: false, alive: false };
		}
		const result = await pi.exec("cmux", ["list-workspaces"]);
		if (result.code !== 0) return { known: false, alive: false };
		return {
			known: true,
			alive: child.identifiers.some((identifier) =>
				`${result.stdout}\n${result.stderr}`.includes(identifier),
			),
		};
	}

	async function lifecycleFacts(child: OwnedChild) {
		const exists = await pathExists(child.worktreePath);
		let dirty = false;
		let merged = false;
		if (exists && child.worktreePath) {
			const status = await pi.exec("git", [
				"-C",
				child.worktreePath,
				"status",
				"--porcelain",
			]);
			dirty = status.code !== 0 || Boolean(status.stdout.trim());
		}
		if (child.repositoryRoot && child.branch) {
			const ancestry = await pi.exec("git", [
				"-C",
				child.repositoryRoot,
				"merge-base",
				"--is-ancestor",
				child.branch,
				"HEAD",
			]);
			merged = ancestry.code === 0;
		}
		const workspace = await workspaceStatus(child);
		return {
			pathExists: exists,
			workspaceKnown: workspace.known,
			workspaceAlive: workspace.alive,
			dirty,
			merged,
		};
	}

	async function statusChildren() {
		const children = await readRegistry();
		return Promise.all(
			children.map(async (child) =>
				classifyOwnedWorktree(child, await lifecycleFacts(child)),
			),
		);
	}

	async function recoverChild(sessionId?: string) {
		const children = await readRegistry();
		const child = findChild(children, sessionId);
		const plan = recoveryPlan(child);
		if (!(await pathExists(plan.cwd))) {
			throw new Error("Cannot recover a child whose worktree path is missing");
		}
		const workspace = await workspaceStatus(child);
		if (!workspace.known) {
			throw new Error("Cannot verify cmux workspace liveness");
		}
		if (workspace.alive) {
			throw new Error("The child workspace is already active");
		}
		const command = `pi --session-id ${shellQuote(plan.sessionId)} --name ${shellQuote(plan.name)}`;
		const output = await cmux(
			buildSpawnArguments({
				name: `Pi · ${plan.name}`,
				cwd: plan.cwd,
				command,
			}),
		);
		const identifiers = parseWorkspaceIdentifiers(output);
		await mutateRegistry((current) =>
			current.map((candidate) =>
				candidate.sessionId === child.sessionId
					? { ...candidate, identifiers }
					: candidate,
			),
		);
		return { ...plan, identifiers, output };
	}

	async function preparePatch(sessionId?: string) {
		const child = findChild(await readRegistry(), sessionId);
		if (!child.repositoryRoot || !child.worktreePath || !child.baseCommit) {
			throw new Error("This child predates patch metadata; inspect it manually");
		}
		const untracked = await pi.exec("git", [
			"-C",
			child.worktreePath,
			"ls-files",
			"--others",
			"--exclude-standard",
		]);
		if (untracked.code !== 0) {
			throw new Error(untracked.stderr.trim() || "Unable to inspect untracked files");
		}
		if (untracked.stdout.trim()) {
			throw new Error("Add or remove untracked child files before preparing a complete patch");
		}
		const result = await pi.exec("git", [
			"-C",
			child.worktreePath,
			"diff",
			"--binary",
			child.baseCommit,
		]);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || "Unable to create child patch");
		}
		if (Buffer.byteLength(result.stdout) > 10 * 1024 * 1024) {
			throw new Error("Child patch exceeds the 10 MiB safety limit");
		}
		const patchDir = path.join(homedir(), ".pi", "agent", "child-patches");
		const destination = path.join(patchDir, `${child.sessionId}.patch`);
		await mkdir(patchDir, { recursive: true, mode: 0o700 });
		const temporary = `${destination}.${process.pid}.tmp`;
		await writeFile(temporary, result.stdout, { mode: 0o600 });
		await rename(temporary, destination);
		await chmod(destination, 0o600);
		return { sessionId: child.sessionId, patchPath: destination };
	}

	async function cleanupChild(sessionId?: string) {
		const children = await readRegistry();
		const child = findChild(children, sessionId);
		const facts = await lifecycleFacts(child);
		const eligibility = cleanupEligibility(facts);
		if (!eligibility.allowed) throw new Error(eligibility.reason);
		if (!child.repositoryRoot || !child.worktreePath || !child.branch) {
			throw new Error("Child registry lacks cleanup metadata");
		}
		const removal = await pi.exec("git", [
			"-C",
			child.repositoryRoot,
			"worktree",
			"remove",
			child.worktreePath,
		]);
		if (removal.code !== 0) {
			throw new Error(removal.stderr.trim() || "Worktree removal failed");
		}
		const branch = await pi.exec("git", [
			"-C",
			child.repositoryRoot,
			"branch",
			"-d",
			child.branch,
		]);
		if (branch.code !== 0) {
			throw new Error(
				`Worktree removed but branch cleanup failed: ${branch.stderr.trim()}`,
			);
		}
		await mutateRegistry((current) =>
			current.filter((candidate) => candidate.sessionId !== child.sessionId),
		);
		return { sessionId: child.sessionId, removed: true };
	}

	pi.registerTool({
		name: "cmux_session",
		label: "cmux child session",
		description:
			"Manage owned, persistent Pi-native child sessions in cmux. Implementing children get isolated Git worktrees by default and remain enterable with /tree and /resume; use pi-subagents for lightweight fan-out.",
		parameters: Type.Object({
			action: Action,
			workspace: Type.Optional(Type.String()),
			name: Type.Optional(Type.String({ maxLength: 80 })),
			task: Type.Optional(Type.String({ maxLength: 4000 })),
			cwd: Type.Optional(Type.String({ maxLength: 1000 })),
			message: Type.Optional(Type.String({ maxLength: 4000 })),
			childClass: Type.Optional(
				Type.Union([Type.Literal("lightweight"), Type.Literal("substantial")]),
			),
			sessionId: Type.Optional(Type.String({ maxLength: 160 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let details: unknown;
			switch (params.action) {
				case "spawn":
					details = await spawn(params, ctx.sessionManager.getSessionId());
					break;
				case "list":
					details = {
						children: await readRegistry(),
					};
					break;
				case "focus":
					if (!params.workspace) throw new Error("focus requires workspace");
					requireOwnedWorkspace(await readRegistry(), params.workspace);
					details = {
						output: await cmux(["select-workspace", "--workspace", params.workspace]),
					};
					break;
				case "send":
					if (!params.workspace || !params.message) {
						throw new Error("send requires workspace and message");
					}
					requireOwnedWorkspace(await readRegistry(), params.workspace);
					await cmux(["send", "--workspace", params.workspace, params.message]);
					details = {
						output: await cmux(["send-key", "--workspace", params.workspace, "enter"]),
					};
					break;
				case "interrupt":
					if (!params.workspace) throw new Error("interrupt requires workspace");
					requireOwnedWorkspace(await readRegistry(), params.workspace);
					details = {
						output: await cmux(["send-key", "--workspace", params.workspace, "ctrl-c"]),
					};
					break;
				case "status":
					details = { children: await statusChildren() };
					break;
				case "recover":
					details = await recoverChild(params.sessionId);
					break;
				case "prepare-patch":
					details = await preparePatch(params.sessionId);
					break;
				case "cleanup":
					details = await cleanupChild(params.sessionId);
					break;
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
				details,
			};
		},
	});

	async function startPersistent(task: string, ctx: any) {
		const result = await spawn(
			{ task },
			ctx.sessionManager.getSessionId(),
		);
		ctx.ui.notify(`Persistent agent started · ${result.name}`, "info");
	}

	function startBackground(task: string, ctx: any) {
		pi.sendMessage(
			{
				customType: "pi-agents-background",
				content:
					`Fan out this bounded task to lightweight background subagents. ` +
					`Synthesize their findings here; do not create a persistent cmux child:\n\n${task}`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		ctx.ui.setStatus("pi-agents", "agents:queued");
	}

	async function focusChild(child: OwnedChild) {
		const workspace = child.identifiers[0];
		if (!workspace) throw new Error("The child has no cmux workspace identifier");
		await cmux(["select-workspace", "--workspace", workspace]);
		await pi.exec("open", ["-a", "cmux"]);
	}

	async function manageChild(sessionId: string, ctx: any) {
		const child = findChild(await readRegistry(), sessionId);
		const selected = await ctx.ui.select(
			`${child.name} · ${child.cwd}`,
			["Focus in cmux", "Recover session", "Prepare patch", "Clean up worktree"],
		);
		if (!selected) return;
		if (selected === "Focus in cmux") {
			await focusChild(child);
		} else if (selected === "Recover session") {
			await recoverChild(sessionId);
			ctx.ui.notify(`Recovered ${child.name}`, "info");
		} else if (selected === "Prepare patch") {
			const result = await preparePatch(sessionId);
			ctx.ui.notify(`Patch ready · ${result.patchPath}`, "info");
		} else {
			await cleanupChild(sessionId);
			ctx.ui.notify(`Cleaned up ${child.name}`, "info");
		}
	}

	async function openAgentsChooser(ctx: any) {
		const children = await statusChildren();
		const choices = buildAgentChoices(children);
		const selected = await ctx.ui.select(
			"Agents · choose a workflow",
			choices.map((choice: any) => choice.label),
		);
		if (!selected) return;
		const choice = choices.find((candidate: any) => candidate.label === selected);
		if (choice?.action === "child") {
			await manageChild(choice.sessionId, ctx);
			return;
		}
		const task = await ctx.ui.input(
			choice?.action === "background"
				? "Task to fan out"
				: "Implementation task for the persistent agent",
			"",
		);
		if (!task?.trim()) return;
		if (choice?.action === "background") startBackground(task, ctx);
		else await startPersistent(task, ctx);
	}

	pi.registerCommand("agents", {
		description: "Start, inspect, focus, recover, patch, or clean up agents",
		handler: async (args, ctx) => {
			const input = args.trim();
			try {
				if (!input) {
					await openAgentsChooser(ctx);
					return;
				}
				const [action, ...rest] = input.split(/\s+/);
				const value = rest.join(" ").trim();
				if (action === "persistent" || action === "child") {
					if (!value) throw new Error("Usage: /agents persistent <task>");
					await startPersistent(value, ctx);
				} else if (action === "background") {
					if (!value) throw new Error("Usage: /agents background <task>");
					startBackground(value, ctx);
				} else if (action === "list") {
					const choices = buildAgentChoices(await statusChildren()).slice(2);
					ctx.ui.notify(
						choices.length ? choices.map((choice: any) => choice.label).join("\n") : "No persistent agents.",
						"info",
					);
				} else if (action === "focus") {
					await focusChild(findChild(await readRegistry(), value));
				} else if (action === "recover") {
					await recoverChild(value);
					ctx.ui.notify("Agent session recovered.", "info");
				} else if (action === "patch") {
					const result = await preparePatch(value);
					ctx.ui.notify(`Patch ready · ${result.patchPath}`, "info");
				} else if (action === "cleanup") {
					await cleanupChild(value);
					ctx.ui.notify("Agent worktree cleaned up.", "info");
				} else {
					throw new Error(
						"Usage: /agents [persistent|background|list|focus|recover|patch|cleanup]",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Agents: ${String(error)}`, "error");
			}
		},
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${orchestrationPolicy}\n`,
	}));
}
