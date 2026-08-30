import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { importFreshSourceModule } from "../src/fresh-module.mjs";

const Action = Type.Union([
	Type.Literal("spawn"),
	Type.Literal("fork"),
	Type.Literal("list"),
	Type.Literal("focus"),
	Type.Literal("send"),
	Type.Literal("interrupt"),
	Type.Literal("status"),
	Type.Literal("recover"),
	Type.Literal("prepare-patch"),
	Type.Literal("cleanup"),
]);

export default async function cmuxSupervisorExtension(pi: ExtensionAPI) {
	const supervisorSourcePath = fileURLToPath(
		new URL("../src/cmux-supervisor.mjs", import.meta.url),
	);
	const {
		buildAgentCenterActions,
		buildAgentChoices,
		backgroundSubagentRoot,
		buildChildCommand,
		buildChildEnvironment,
		buildDetachedForkCommand,
		buildDetachedForkEnvironment,
		buildShellReadyCommand,
		buildSpawnArguments,
		buildWorktreeArguments,
		childWorktreePlan,
		childScreenTail,
		formatChildProgressLines,
		formatChildIdentityLines,
		normalizeBackgroundSubagentRun,
		normalizeChildProgress,
		orchestrationPolicy,
		parseWorkspaceIdentifiers,
		requireOwnedWorkspace,
		resolveCurrentChild,
		resolveOwnedChildSelector,
		supervisorWorkspaceCandidates,
		slug,
		waitForPath,
	} = await importFreshSourceModule(supervisorSourcePath);
	const worktreeSourcePath = fileURLToPath(
		new URL("../src/worktree-lifecycle.mjs", import.meta.url),
	);
	const {
		classifyOwnedWorktree,
		cleanupEligibility,
		recoveryPlan,
	} = await importFreshSourceModule(worktreeSourcePath);
	const registryPath =
		process.env.PI_CMUX_CHILD_REGISTRY ??
		path.join(homedir(), ".pi", "agent", "cmux-children.json");
	const worktreeBaseDir =
		process.env.PI_CMUX_WORKTREE_BASE ??
		path.join(homedir(), ".pi", "agent", "worktrees");
	const launchRuntimeDir =
		process.env.PI_CMUX_LAUNCH_RUNTIME ??
		path.join(homedir(), ".pi", "agent", "cmux-launches");
	const progressRuntimeDir =
		process.env.PI_CMUX_PROGRESS_RUNTIME ??
		path.join(homedir(), ".pi", "agent", "cmux-progress");
	const inheritedProgressPath = process.env.PI_CMUX_CHILD_PROGRESS_PATH;
	let registryMutation = Promise.resolve();
	let childProgressPath = inheritedProgressPath ?? "";
	let childProgressSessionId = "";
	let childProgress: any;
	let childHeartbeatTimer: NodeJS.Timeout | undefined;
	let parentProgressTimer: NodeJS.Timeout | undefined;
	let latestContext: any;
	let currentParentSessionId = "";
	let watchedChildSessionId = "";
	let liveTailEnabled = true;
	let parentProgressRefreshing = false;

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
		parentWorkspace?: string;
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

	function progressPathFor(sessionId: string) {
		return path.join(progressRuntimeDir, `${sessionId}.json`);
	}

	async function writeProgress(targetPath: string, value: any) {
		const normalized = normalizeChildProgress(value);
		if (!normalized) throw new Error("Invalid child progress metadata");
		await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
		const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, targetPath);
	}

	async function emitChildProgress(
		phase: string,
		toolName = "",
		extra: Record<string, unknown> = {},
	) {
		if (!childProgressPath || !childProgressSessionId) return;
		childProgress = {
			version: 1,
			sessionId: childProgressSessionId,
			phase,
			...(toolName ? { toolName } : {}),
			...(childProgress?.lastUserInputAt
				? { lastUserInputAt: childProgress.lastUserInputAt }
				: {}),
			...extra,
			updatedAt: new Date().toISOString(),
		};
		await writeProgress(childProgressPath, childProgress);
	}

	async function readProgress(sessionId: string) {
		try {
			return normalizeChildProgress(
				JSON.parse(await readFile(progressPathFor(sessionId), "utf8")),
			);
		} catch (error: any) {
			if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
			throw error;
		}
	}

	async function progressForChildren(children: OwnedChild[]) {
		const entries = await Promise.all(
			children.map(async (child) => [child.sessionId, await readProgress(child.sessionId)]),
		);
		return new Map(entries.filter((entry) => entry[1]));
	}

	async function backgroundSubagentRuns({
		states = ["queued", "running", "paused"],
		limit = 8,
	}: {
		states?: string[];
		limit?: number;
	} = {}) {
		const allowedStates = new Set(states);
		let entries;
		try {
			entries = await readdir(backgroundSubagentRoot(), { withFileTypes: true });
		} catch (error: any) {
			if (error?.code === "ENOENT") return [];
			throw error;
		}
		const runs = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map(async (entry) => {
					try {
						const statusPath = path.join(backgroundSubagentRoot(), entry.name, "status.json");
						return normalizeBackgroundSubagentRun(
							JSON.parse(await readFile(statusPath, "utf8")),
						);
					} catch (error: any) {
						if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
						throw error;
					}
				}),
		);
		return runs
			.filter((run: any) => run && allowedStates.has(run.state))
			.sort((a: any, b: any) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.slice(0, Math.max(0, limit));
	}

	async function refreshProgressWidget(ctx = latestContext) {
		if (!ctx || !currentParentSessionId || childProgressPath) return;
		if (parentProgressRefreshing) return;
		parentProgressRefreshing = true;
		try {
			const children = (await readRegistry()).filter(
				(child) => child.parentSessionId === currentParentSessionId,
			);
			const newest = [...children].sort(
				(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
			)[0];
			let watched = children.find((child) => child.sessionId === watchedChildSessionId);
			if (!watched && newest) {
				watched = newest;
				watchedChildSessionId = newest.sessionId;
			}
			const screenTailBySessionId = new Map<string, string[]>();
			if (liveTailEnabled && watched?.identifiers[0]) {
				try {
					const screen = await cmux([
						"read-screen",
						"--workspace",
						watched.identifiers[0],
						"--lines",
						"12",
					]);
					const tail = childScreenTail(screen);
					if (tail.length) screenTailBySessionId.set(watched.sessionId, tail);
				} catch {
					// A closed or non-terminal child still retains its metadata status.
				}
			}
			const lines = formatChildProgressLines(
				children,
				await progressForChildren(children),
				{
					screenTailBySessionId,
					backgroundRuns: await backgroundSubagentRuns(),
				},
			);
			ctx.ui.setWidget("pi-agents-progress", lines.length ? lines : undefined, {
				placement: "belowEditor",
			});
		} finally {
			parentProgressRefreshing = false;
		}
	}

	function startChildHeartbeat() {
		if (!childProgressPath) return;
		if (childHeartbeatTimer) clearInterval(childHeartbeatTimer);
		childHeartbeatTimer = setInterval(() => {
			if (childProgress) void writeProgress(childProgressPath, {
				...childProgress,
				updatedAt: new Date().toISOString(),
			});
		}, 5_000);
		childHeartbeatTimer.unref?.();
	}

	function startParentProgressPolling(ctx: any) {
		if (childProgressPath) return;
		if (parentProgressTimer) clearInterval(parentProgressTimer);
		parentProgressTimer = setInterval(() => void refreshProgressWidget(ctx), 2_000);
		parentProgressTimer.unref?.();
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

	async function launchWorkspace({
		sessionId,
		name,
		cwd,
		command,
		environment,
		focus = false,
	}: {
		sessionId: string;
		name: string;
		cwd: string;
		command: string;
		environment: string[];
		focus?: boolean;
	}) {
		await mkdir(launchRuntimeDir, { recursive: true, mode: 0o700 });
		const shellReadyPath = path.join(launchRuntimeDir, `${sessionId}.shell-ready`);
		const childStartedPath = path.join(launchRuntimeDir, `${sessionId}.child-started`);
		const progressPath = progressPathFor(sessionId);
		await Promise.all([
			rm(shellReadyPath, { force: true }),
			rm(childStartedPath, { force: true }),
			rm(progressPath, { force: true }),
		]);

		let identifiers: string[] | undefined;
		try {
			const output = await cmux(
				buildSpawnArguments({
					name: `Pi · ${name}`,
					cwd,
						environment: [
							...environment,
							`PI_CMUX_CHILD_STARTED_PATH=${childStartedPath}`,
							`PI_CMUX_CHILD_PROGRESS_PATH=${progressPath}`,
					],
					focus,
				}),
			);
			identifiers = parseWorkspaceIdentifiers(output);
			const workspace = identifiers[0];
			await cmux([
				"send",
				"--workspace",
				workspace,
				`${buildShellReadyCommand(shellReadyPath)}\\n`,
			]);
			await waitForPath(shellReadyPath, { exists: pathExists, timeoutMs: 10_000 });
			await cmux(["send", "--workspace", workspace, `${command}\\n`]);
			await waitForPath(childStartedPath, { exists: pathExists, timeoutMs: 30_000 });
			return { identifiers, output };
		} catch (error) {
			await rm(progressPath, { force: true });
			if (identifiers?.[0]) {
				try {
					await cmux(["close-workspace", "--workspace", identifiers[0]]);
				} catch {
					// Preserve the launch error; cmux may already have closed the workspace.
				}
			}
			throw error;
		} finally {
			await Promise.all([
				rm(shellReadyPath, { force: true }),
				rm(childStartedPath, { force: true }),
			]);
		}
	}

	async function createDetachedFork({
		ctx,
		entryId,
		position,
		task,
		name,
		prefill,
	}: {
		ctx: any;
		entryId: string;
		position: "before" | "at";
		task?: string;
		name?: string;
		prefill?: string;
	}) {
		if (!process.env.CMUX_WORKSPACE_ID) {
			throw new Error("Detached /fork requires Pi to be running inside cmux");
		}
		const sourceSessionFile = ctx.sessionManager.getSessionFile();
		if (!sourceSessionFile) {
			throw new Error("The current session has not been saved yet");
		}
		const selectedEntry = ctx.sessionManager.getEntry(entryId);
		if (!selectedEntry) throw new Error("The selected fork point no longer exists");
		const targetEntryId = position === "at" ? entryId : selectedEntry.parentId;
		if (!targetEntryId) {
			throw new Error("Cannot detach a fork before the first saved session entry");
		}

		const detached = SessionManager.open(
			sourceSessionFile,
			ctx.sessionManager.getSessionDir(),
		);
		const sessionFile = detached.createBranchedSession(targetEntryId);
		if (!sessionFile) throw new Error("Failed to create the detached fork session");

		const parentSessionId = ctx.sessionManager.getSessionId();
		const labelSource = name?.trim() || task?.trim() || prefill?.trim() || "fork";
		const label = slug(labelSource, "fork");
		let launch: { identifiers: string[]; output: string } | undefined;
		try {
			launch = await launchWorkspace({
				sessionId: detached.getSessionId(),
				name: `fork · ${label}`,
				cwd: ctx.sessionManager.getCwd(),
				command: buildDetachedForkCommand({ includeTask: Boolean(task?.trim()) }),
				environment: buildDetachedForkEnvironment({
					sessionFile,
				parentSessionId,
				parentWorkspaceId: process.env.CMUX_WORKSPACE_ID,
				childName: `fork · ${label}`,
				task: task?.trim(),
				}),
				focus: true,
			});
			if (prefill) {
				await cmux(["send", "--workspace", launch.identifiers[0], prefill]);
			}
			const child: OwnedChild = {
				identifiers: launch.identifiers,
				sessionId: detached.getSessionId(),
				parentSessionId,
				name: `fork · ${label}`,
				createdAt: new Date().toISOString(),
				cwd: ctx.sessionManager.getCwd(),
				parentWorkspace: process.env.CMUX_WORKSPACE_ID,
			};
			await appendRegistry(child);
			return { ...child, sessionFile, output: launch.output };
		} catch (error) {
			if (launch?.identifiers[0]) {
				try {
					await cmux(["close-workspace", "--workspace", launch.identifiers[0]]);
				} catch {
					// Preserve the launch error; cmux may already have closed the tab.
				}
			}
			await rm(sessionFile, { force: true });
			throw error;
		}
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

		const command = buildChildCommand();
		let identifiers: string[] | undefined;
		try {
			const launch = await launchWorkspace({
				sessionId,
				name,
				cwd: childCwd,
				command,
				environment: buildChildEnvironment({
					sessionId,
					name,
					task: params.task,
					parentSessionId,
					childClass: "substantial",
					parentWorkspaceId: process.env.CMUX_WORKSPACE_ID,
				}),
			});
			identifiers = launch.identifiers;
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
				parentWorkspace: process.env.CMUX_WORKSPACE_ID,
			};
			await appendRegistry(child);
			return { ...child, output: launch.output };
		} catch (error) {
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
		return resolveOwnedChildSelector(children, sessionId);
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
		const progress = await progressForChildren(children);
		return Promise.all(
			children.map(async (child) => ({
				...classifyOwnedWorktree(child, await lifecycleFacts(child)),
				progress: progress.get(child.sessionId) ?? null,
			})),
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
		const command = buildChildCommand({ includeTask: false });
		const launch = await launchWorkspace({
			sessionId: plan.sessionId,
			name: plan.name,
			cwd: plan.cwd,
			command,
			environment: [
				"AGENT_JOURNAL_PARENT_CLIENT=pi",
				`AGENT_JOURNAL_PARENT_SESSION_ID=${child.parentSessionId}`,
				"AGENT_JOURNAL_CHILD_CLASS=substantial",
				`PI_CMUX_CHILD_SESSION_ID=${plan.sessionId}`,
				`PI_CMUX_CHILD_NAME=${plan.name}`,
				`PI_CMUX_CHILD_DISPLAY_NAME=${plan.name}`,
				...(child.parentWorkspace
					? [`PI_CMUX_SUPERVISOR_WORKSPACE_ID=${child.parentWorkspace}`]
					: []),
			],
		});
		const identifiers = launch.identifiers;
		await mutateRegistry((current) =>
			current.map((candidate) =>
				candidate.sessionId === child.sessionId
					? { ...candidate, identifiers }
					: candidate,
			),
		);
		return { ...plan, identifiers, output: launch.output };
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
			"Manage owned, persistent Pi-native child sessions in cmux. Use action=fork whenever the user explicitly asks to start work in a /fork: it copies the current conversation branch into a focused cmux tab, starts the task there, and leaves the parent idle. Implementing spawn children get isolated Git worktrees by default; use pi-subagents only for lightweight fan-out that was not requested as a /fork.",
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
				case "fork": {
					if (!params.task?.trim()) throw new Error("fork requires a concrete task");
					const leafId = ctx.sessionManager.getLeafId();
					if (!leafId) throw new Error("The current session has nothing to fork yet");
					details = await createDetachedFork({
						ctx,
						entryId: leafId,
						position: "at",
						task: params.task,
						name: params.name,
					});
					break;
				}
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
			if (params.action === "spawn" || params.action === "fork") {
				watchedChildSessionId = (details as OwnedChild).sessionId;
				await refreshProgressWidget(ctx);
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
		watchedChildSessionId = result.sessionId;
		await refreshProgressWidget(ctx);
		ctx.ui.notify(
			[
				`Implementation agent started · ${result.name}`,
				`Branch: ${result.branch}`,
				"Live output now follows in this parent.",
				"Run /agents to manage it without leaving this tab.",
			].join("\n"),
			"info",
		);
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

	async function discoverSupervisorWorkspace(current: OwnedChild, ctx: any) {
		const children = await readRegistry();
		const listing = await cmux(["list-workspaces"]);
		const candidates = supervisorWorkspaceCandidates(
			listing,
			children,
			process.env.CMUX_WORKSPACE_ID,
		);
		if (!candidates.length) {
			throw new Error("No non-child cmux workspace is available for the supervisor");
		}
		let selected = candidates[0];
		if (candidates.length > 1) {
			const choices = await Promise.all(
				candidates.map(async (workspace: string) => {
					try {
						const screen = await cmux(["read-screen", "--workspace", workspace, "--lines", "6"]);
						const preview = childScreenTail(screen, { maxLines: 1, maxLineChars: 100 })[0];
						return { workspace, label: preview ? `${workspace} · ${preview}` : workspace };
					} catch {
						return { workspace, label: workspace };
					}
				}),
			);
			const label = await ctx.ui.select(
				"Which tab is the supervisor? This choice is remembered.",
				choices.map((choice) => choice.label),
			);
			if (!label) return "";
			selected = choices.find((choice) => choice.label === label)?.workspace ?? "";
		}
		if (!selected) return "";
		await mutateRegistry((entries) =>
			entries.map((entry) =>
				entry.sessionId === current.sessionId
					? { ...entry, parentWorkspace: selected }
					: entry,
			),
		);
		process.env.PI_CMUX_SUPERVISOR_WORKSPACE_ID = selected;
		return selected;
	}

	async function currentChildForContext(ctx: any) {
		return resolveCurrentChild(await readRegistry(), {
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.sessionManager.getCwd(),
		}) as OwnedChild | null;
	}

	async function returnToSupervisor(ctx: any) {
		const current = await currentChildForContext(ctx);
		let parentWorkspace =
			process.env.PI_CMUX_SUPERVISOR_WORKSPACE_ID ?? current?.parentWorkspace;
		if (!parentWorkspace && current) {
			parentWorkspace = await discoverSupervisorWorkspace(current, ctx);
		}
		if (!parentWorkspace) {
			throw new Error("This child is not registered and its supervisor cannot be discovered");
		}
		await cmux(["select-workspace", "--workspace", parentWorkspace]);
	}

	async function openChildAgentsChooser(ctx: any) {
		const current = await currentChildForContext(ctx);
		const name = current?.name ?? "this child";
		const selected = await ctx.ui.select(
			`Agent Center · ${name} (child tab)`,
			[
				"Return to Agent Center",
				"Show this child’s routing details",
			],
		);
		if (selected === "Return to Agent Center") {
			await returnToSupervisor(ctx);
		} else if (selected === "Show this child’s routing details") {
			ctx.ui.notify(
				[
					`Child: ${name}`,
					`Worktree: ${current?.worktreePath ?? current?.cwd ?? ctx.sessionManager.getCwd()}`,
					`Return: /agents parent`,
				].join("\n"),
				"info",
			);
		}
	}

	async function manageChild(sessionId: string, ctx: any) {
		const child = findChild(await readRegistry(), sessionId);
		const selected = await ctx.ui.select(
			`Agent Center · ${child.name} · stays in this tab`,
			buildAgentCenterActions(),
		);
		if (!selected) return;
		if (selected === "Follow here") {
			watchedChildSessionId = child.sessionId;
			liveTailEnabled = true;
			await refreshProgressWidget(ctx);
			ctx.ui.notify(`Following ${child.name} here.`, "info");
		} else if (selected === "Send instruction…") {
			const message = await ctx.ui.input(`Instruction for ${child.name}`, "");
			if (!message?.trim()) return;
			const workspace = child.identifiers[0];
			if (!workspace) throw new Error("The child has no cmux workspace identifier");
			await cmux(["send", "--workspace", workspace, message.trim()]);
			await cmux(["send-key", "--workspace", workspace, "enter"]);
			ctx.ui.notify(`Instruction sent to ${child.name}.`, "info");
		} else if (selected === "Review changes…") {
			const result = await preparePatch(child.sessionId);
			const command = `/review ${JSON.stringify(result.patchPath)}`;
			if (ctx.ui.getEditorText?.().trim()) {
				ctx.ui.notify(`Review ready · ${command}`, "info");
			} else {
				ctx.ui.setEditorText?.(command);
				ctx.ui.notify("Review command is ready; press Enter to open it.", "info");
			}
		} else if (selected === "Open child tab…") {
			await focusChild(child);
		} else {
			const advanced = await ctx.ui.select(`More · ${child.name}`, [
				"Interrupt current work",
				"Recover session in child tab…",
				"Prepare patch",
				"Clean up finished worktree",
			]);
			if (advanced === "Interrupt current work") {
				const workspace = child.identifiers[0];
				if (!workspace) throw new Error("The child has no cmux workspace identifier");
				await cmux(["send-key", "--workspace", workspace, "ctrl-c"]);
				ctx.ui.notify(`Interrupted ${child.name}; its tab and files remain.`, "warning");
			} else if (advanced === "Recover session in child tab…") {
				await recoverChild(sessionId);
				ctx.ui.notify(`Recovered ${child.name}`, "info");
			} else if (advanced === "Prepare patch") {
				const result = await preparePatch(sessionId);
				ctx.ui.notify(`Patch ready · ${result.patchPath}`, "info");
			} else if (advanced === "Clean up finished worktree") {
				await cleanupChild(sessionId);
				ctx.ui.notify(`Cleaned up ${child.name}`, "info");
			}
		}
	}

	async function openAgentsChooser(ctx: any) {
		const children = await statusChildren();
		const choices = buildAgentChoices(children, await backgroundSubagentRuns());
		const selected = await ctx.ui.select(
			"Agent Center · stays in this tab",
			choices.map((choice: any) => choice.label),
		);
		if (!selected) return;
		const choice = choices.find((candidate: any) => candidate.label === selected);
		if (choice?.action === "child") {
			await manageChild(choice.sessionId, ctx);
			return;
		}
		if (choice?.action === "background-run") {
			ctx.ui.notify(
				[
					"Background subagents are managed by the lightweight subagent fleet.",
					"Inspect or steer them with /subagents-fleet.",
				].join("\n"),
				"info",
			);
			return;
		}
		const task = await ctx.ui.input(
			choice?.action === "background"
				? "Parallel task"
				: "Implementation task",
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
						if (childProgressPath) await openChildAgentsChooser(ctx);
						else await openAgentsChooser(ctx);
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
					const choices = buildAgentChoices(
						await statusChildren(),
						await backgroundSubagentRuns(),
					).slice(2);
					ctx.ui.notify(
						choices.length ? choices.map((choice: any) => choice.label).join("\n") : "No agents.",
						"info",
					);
				} else if (action === "status") {
					const owned = (await readRegistry()).filter(
						(child) => child.parentSessionId === ctx.sessionManager.getSessionId(),
					);
					const selected = value ? [findChild(owned, value)] : owned;
					const lines = formatChildProgressLines(
						selected,
						await progressForChildren(selected),
						{ backgroundRuns: value ? [] : await backgroundSubagentRuns() },
					);
					ctx.ui.notify(
						lines.length ? lines.join("\n") : "No delegated agents for this session.",
						"info",
					);
				} else if (action === "watch") {
					if (value === "off") {
						liveTailEnabled = false;
						ctx.ui.notify("Live child tail hidden; metadata remains visible.", "info");
					} else {
						const owned = (await readRegistry()).filter(
							(child) => child.parentSessionId === ctx.sessionManager.getSessionId(),
						);
						const child = findChild(owned, value);
						watchedChildSessionId = child.sessionId;
						liveTailEnabled = true;
						ctx.ui.notify(`Following ${child.name} in this parent.`, "info");
					}
					await refreshProgressWidget(ctx);
				} else if (action === "focus") {
					await focusChild(findChild(await readRegistry(), value));
					} else if (action === "parent") {
						await returnToSupervisor(ctx);
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
						"Usage: /agents [persistent|background|list|status|watch|focus|parent|recover|patch|cleanup]",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Agents: ${String(error)}`, "error");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (childProgressPath && childProgress?.phase === "waiting") {
			await emitChildProgress("thinking", "", {
				lastUserInputAt: new Date().toISOString(),
			});
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${orchestrationPolicy}\n`,
		};
	});

	pi.on("session_before_fork", async (event, ctx) => {
		// Native /clone emits the same hook with position=at. Keep clone's native
		// behavior; only the /fork message selector opens a detached cmux tab.
		if (event.position !== "before") return;
		const selected = ctx.sessionManager.getEntry(event.entryId);
		const content =
			selected?.type === "message" && selected.message.role === "user"
				? selected.message.content
				: "";
		const prefill =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
						.filter((part: any) => part?.type === "text")
						.map((part: any) => part.text)
						.join("\n")
					: "";
		try {
			await createDetachedFork({
				ctx,
				entryId: event.entryId,
				position: event.position,
				prefill,
			});
			ctx.ui.notify(
				"Fork opened in a new cmux tab; the parent session is unchanged.",
				"info",
			);
		} catch (error) {
			ctx.ui.notify(`Fork was not opened: ${String(error)}`, "error");
		}
		return { cancel: true };
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		currentParentSessionId = ctx.sessionManager.getSessionId();
		if (
			!childProgressPath &&
			process.env.AGENT_JOURNAL_CHILD_CLASS === "substantial" &&
			process.env.AGENT_JOURNAL_PARENT_SESSION_ID
		) {
			childProgressPath = progressPathFor(currentParentSessionId);
		}
		const startedPath = process.env.PI_CMUX_CHILD_STARTED_PATH;
		if (childProgressPath) {
			const currentChild = await currentChildForContext(ctx);
			childProgressSessionId = ctx.sessionManager.getSessionId();
			await emitChildProgress("starting");
			startChildHeartbeat();
			ctx.ui.setWidget(
				"pi-agents-progress",
				formatChildIdentityLines(
					process.env.PI_CMUX_CHILD_DISPLAY_NAME ?? currentChild?.name,
				),
				{ placement: "belowEditor" },
			);
			delete process.env.PI_CMUX_CHILD_PROGRESS_PATH;
		} else {
			const supervisorWorkspace = process.env.CMUX_WORKSPACE_ID;
			if (supervisorWorkspace) {
				await mutateRegistry((children) =>
					children.map((child) =>
						child.parentSessionId === currentParentSessionId && !child.parentWorkspace
							? { ...child, parentWorkspace: supervisorWorkspace }
							: child,
					),
				);
			}
			startParentProgressPolling(ctx);
			await refreshProgressWidget(ctx);
		}
		if (startedPath) {
			await writeFile(startedPath, `${ctx.sessionManager.getSessionId()}\n`, {
				mode: 0o600,
			});
			delete process.env.PI_CMUX_CHILD_STARTED_PATH;
		}
	});

	pi.on("agent_start", async () => {
		await emitChildProgress("thinking");
	});

	pi.on("tool_execution_start", async (event) => {
		await emitChildProgress("tool", event.toolName);
	});

	pi.on("tool_execution_end", async (event) => {
		await emitChildProgress(event.isError ? "failed" : "thinking");
	});

	pi.on("agent_settled", async () => {
		await emitChildProgress("waiting");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (childHeartbeatTimer) clearInterval(childHeartbeatTimer);
		if (parentProgressTimer) clearInterval(parentProgressTimer);
		childHeartbeatTimer = undefined;
		parentProgressTimer = undefined;
		if (childProgressPath) {
			await emitChildProgress("stopped");
			ctx.ui.setWidget("pi-agents-progress", undefined);
		}
		else ctx.ui.setWidget("pi-agents-progress", undefined);
	});
}
