import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	removeReviewSession,
	writeReviewSession,
} from "../src/review-session-registry.mjs";
import { importFreshSourceModule } from "../src/fresh-module.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const REVIEW_RECOVERY_STATE = Symbol.for("pi.review.recovery-state.v1");
const reviewRecoveryStates: Map<string, any> =
	((globalThis as any)[REVIEW_RECOVERY_STATE] ??= new Map());

export default async function reviewSurfaceExtension(pi: ExtensionAPI) {
	const reviewSurfacePath = fileURLToPath(
		new URL("../src/review-surface.mjs", import.meta.url),
	);
	const {
		appendReviewDraft,
		classifyReviewFile,
		createReviewServer,
		MAX_REVIEW_FILE_BYTES,
	} = await importFreshSourceModule(reviewSurfacePath, {
		imports: {
			marked: require.resolve("marked"),
		},
	});
	const reviewRecentPath = fileURLToPath(
		new URL("../src/review-recent.mjs", import.meta.url),
	);
	const {
		beginRecentTurn,
		buildRecoveredTargetDiff,
		captureRecentPathInBaselines,
		finishRecentTurn,
	} = await importFreshSourceModule(reviewRecentPath);
	const reviewGitDiffPath = fileURLToPath(
		new URL("../src/review-git-diff.mjs", import.meta.url),
	);
	const {
		buildGitDiffArgs,
		gitDiffReviewFilename,
		recentTurnDiffFilename,
		resolveGitReviewCwd,
	} = await importFreshSourceModule(reviewGitDiffPath);
	const reviewSuggestionsPath = fileURLToPath(
		new URL("../src/review-suggestions.mjs", import.meta.url),
	);
	const {
		buildFileReviewChoices,
		buildReviewChooserChoices,
		buildReviewDisplayMetadata,
		buildSessionReviewTargets: buildSessionTargetList,
		filterReviewableSessionFileRecords,
		automaticReviewShortlistCandidates,
		mergeSessionReviewFiles,
		parseReviewPathArgument,
		restoreReviewFileCandidates,
		restoreRecentReviewFileCandidates,
		restoreRecentToolFileCandidates,
		reviewToolFilePaths,
		restoreReviewShortlist,
		sortSessionReviewFiles,
		updateReviewShortlist,
		REVIEW_SHORTLIST_ENTRY,
		REVIEW_SUGGESTIONS_ENTRY,
	} = await importFreshSourceModule(reviewSuggestionsPath);
	const reviewCmuxPath = fileURLToPath(
		new URL("../src/review-cmux.mjs", import.meta.url),
	);
	const {
		parseCmuxTarget,
		parseCmuxSurfaceTargets,
		reviewUrlMatches,
	} = await importFreshSourceModule(reviewCmuxPath);
	const registryDir = path.join(
		homedir(),
		".agents",
		"runtime",
		"pi-review",
		"sessions",
	);
	const commentsPath = path.join(
		homedir(),
		".agents",
		"reviews",
		"diff-comments.json",
	);
	let service: Awaited<ReturnType<typeof createReviewServer>> | undefined;
	let latestContext: any;

	function recordReviewOpen(mode: string) {
		pi.appendEntry("pi-review-open-metrics", {
			mode,
			at: new Date().toISOString(),
		});
	}
	let sessionId = "";
	let collectingChangedFiles = false;
	const recentBaselines = new Map<string, any>();
	let recentDiffPath = "";
	let recentDiffRecovered = false;
	let recentChangedFiles: string[] = [];
	const sessionBaselines = new Map<string, any>();
	let sessionChangedFiles: string[] = [];
	let reviewShortlist: Array<{ filePath: string; reason: string; source: string; addedAt: string }> = [];
	let reviewWindowId = "";
	let reviewSurfaceId = "";
	let turnSequence = 0;
	const generatedDiffDir = path.join(
		homedir(),
		".agents",
		"runtime",
		"pi-review",
		"generated",
	);
	const generatedDiffs = new Set<string>();

	async function refreshRegistry(ctx = latestContext) {
		if (!service || !sessionId || !ctx) return;
		await writeReviewSession(registryDir, {
			schemaVersion: 1,
			sessionId,
			pid: process.pid,
			cwd: ctx.cwd || process.cwd(),
			workspaceId: process.env.CMUX_WORKSPACE_ID ?? "",
			surfaceId: process.env.CMUX_SURFACE_ID ?? "",
			baseUrl: service.baseUrl,
			bridgeToken: service.bridgeToken,
			updatedAt: new Date().toISOString(),
		});
	}

	function rememberReviewWindow() {
		if (!service || !sessionId) return;
		reviewRecoveryStates.set(sessionId, {
			...service.recoveryState,
			reviewWindowId,
			reviewSurfaceId,
		});
	}

	async function closeReviewWindow(windowId: string) {
		if (!windowId) return;
		await pi.exec("cmux", ["close-window", "--window", windowId]);
	}

	async function reviewSurfaceShows(surfaceId: string, url: string) {
		if (!surfaceId) return false;
		const ready = await pi.exec("cmux", [
			"browser", "--surface", surfaceId, "wait", "--url", url, "--timeout-ms", "3000",
		]);
		if (ready.code !== 0) return false;
		const result = await pi.exec("cmux", [
			"browser", "--surface", surfaceId, "get", "url",
		]);
		return result.code === 0 && reviewUrlMatches(result.stdout, url);
	}

	async function pruneReviewWindowSurfaces(windowId: string, keepSurface: string) {
		const tree = await pi.exec("cmux", [
			"--json", "--id-format", "refs", "tree", "--window", windowId,
		]);
		if (tree.code !== 0) return;
		for (const candidate of parseCmuxSurfaceTargets(tree.stdout)) {
			if (candidate === keepSurface) continue;
			await pi.exec("cmux", [
				"close-surface", "--surface", candidate, "--window", windowId,
			]);
		}
	}

	async function openReviewUrl(url: string) {
		if (reviewSurfaceId) {
			const reused = await pi.exec("cmux", ["browser", "--surface", reviewSurfaceId, "navigate", url]);
			if (reused.code === 0 && await reviewSurfaceShows(reviewSurfaceId, url)) {
				if (reviewWindowId) await pi.exec("cmux", ["focus-window", "--window", reviewWindowId]);
				await pi.exec("cmux", ["browser", "--surface", reviewSurfaceId, "focus-webview"]);
				return;
			}
			await closeReviewWindow(reviewWindowId);
			reviewSurfaceId = "";
			reviewWindowId = "";
		}
		if (reviewWindowId) {
			await closeReviewWindow(reviewWindowId);
			reviewWindowId = "";
		}
		const windowResult = await pi.exec("cmux", ["--json", "new-window"]);
		let createdWindow = "";
		let browserError = "";
		if (windowResult.code === 0) {
			createdWindow = parseCmuxTarget(windowResult.stdout, "window");
			if (createdWindow) {
				const opened = await pi.exec("cmux", [
					"--json", "browser", "open", url, "--window", createdWindow, "--focus", "true", "--id-format", "refs",
				]);
				const createdSurface = parseCmuxTarget(opened.stdout, "surface");
				if (opened.code === 0 && await reviewSurfaceShows(createdSurface, url)) {
					await pruneReviewWindowSurfaces(createdWindow, createdSurface);
					reviewWindowId = createdWindow;
					reviewSurfaceId = createdSurface;
					await pi.exec("cmux", ["rename-window", "--window", createdWindow, "Pi Review"]);
					rememberReviewWindow();
					return;
				}
				browserError = opened.stderr;
				await pi.exec("cmux", ["close-window", "--window", createdWindow]);
			}
		}
		const fallback = await pi.exec("/usr/bin/open", [url]);
		if (fallback.code !== 0) {
			throw new Error(browserError || windowResult.stderr || fallback.stderr || "Unable to open review UI");
		}
	}

	async function reviewFile(filePath: string, ctx = latestContext, display?: any) {
		if (!service) throw new Error("Review surface is not ready");
		const resolved = path.resolve(
			ctx?.cwd || process.cwd(),
			parseReviewPathArgument(filePath),
		);
		await refreshRegistry(ctx);
		const opened = await service.openFile(resolved, display);
		await openReviewUrl(opened.url);
		return resolved;
	}

	async function reviewFiles(filePaths: any[], ctx = latestContext, options: any = {}) {
		if (!service) throw new Error("Review surface is not ready");
		const resolved = filePaths.map((value) => {
			const filePath = typeof value === "string" ? value : value.filePath;
			const absolute = path.resolve(
				ctx?.cwd || process.cwd(),
				parseReviewPathArgument(filePath),
			);
			return typeof value === "string" ? absolute : { ...value, filePath: absolute };
		});
		await refreshRegistry(ctx);
		const opened = await service.openFiles(resolved, options);
		await openReviewUrl(opened.url);
		return resolved;
	}

	async function clearRecentDiff() {
		const previous = recentDiffPath;
		recentDiffPath = "";
		recentDiffRecovered = false;
		if (!previous) return;
		generatedDiffs.delete(previous);
		try {
			await unlink(previous);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
	}

	async function writeRecentDiff(content: string) {
		await mkdir(generatedDiffDir, { recursive: true, mode: 0o700 });
		const destination = path.join(
			generatedDiffDir,
			recentTurnDiffFilename(sessionId, turnSequence),
		);
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, destination);
		await clearRecentDiff();
		recentDiffPath = destination;
		generatedDiffs.add(destination);
	}

	async function writeSessionModeDiff(key: string, content: string) {
		await mkdir(generatedDiffDir, { recursive: true, mode: 0o700 });
		const digest = createHash("sha256")
			.update(`mode:${sessionId}:${key}`)
			.digest("hex")
			.slice(0, 24);
		const destination = path.join(generatedDiffDir, `${digest}.diff`);
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, destination);
		generatedDiffs.add(destination);
		return destination;
	}

	async function materializeSessionGitMode(
		key: string,
		request: string,
		ctx: any,
		emptyMessage: string,
		unavailableMessage: string,
	) {
		try {
			const gitArgs = buildGitDiffArgs(request);
			const result = await execFileAsync("git", gitArgs, {
				cwd: ctx.cwd,
				encoding: "utf8",
				maxBuffer: MAX_DIFF_BYTES,
				timeout: 15_000,
			});
			const empty = !result.stdout;
			return {
				key,
				filePath: await writeSessionModeDiff(
					key,
					result.stdout || `# ${emptyMessage}\n`,
				),
				empty,
			};
		} catch (error) {
			return {
				key,
				filePath: await writeSessionModeDiff(
					key,
					`# ${unavailableMessage}\n`,
				),
				unavailable: true,
			};
		}
	}

	async function ensureSessionBaseline(cwd: string) {
		const baseline = await beginRecentTurn(cwd);
		if (!sessionBaselines.has(baseline.root)) {
			sessionBaselines.set(baseline.root, baseline);
		}
		return sessionBaselines.get(baseline.root);
	}

	async function refreshSessionChanges(ctx: any) {
		for (const [root, baseline] of sessionBaselines) {
			const result = await finishRecentTurn(baseline);
			sessionChangedFiles = mergeSessionReviewFiles(
				sessionChangedFiles,
				result.changedPaths.map((relative: string) => path.join(root, relative)),
				ctx.cwd,
				{ limit: 100, allowedRoot: homedir() },
			);
		}
	}

	async function inspectSessionReviewFiles(filePaths = sessionChangedFiles) {
		const records: Array<{
			filePath: string;
			mtimeMs: number;
			size: number;
			kind: string | null;
			isFile: boolean;
		}> = [];
		for (const filePath of filePaths) {
			try {
				const info = await stat(filePath);
				records.push({
					filePath,
					mtimeMs: info.mtimeMs,
					size: info.size,
					kind: classifyReviewFile(filePath),
					isFile: info.isFile(),
				});
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		const reviewable = filterReviewableSessionFileRecords(records, {
			maxBytes: MAX_REVIEW_FILE_BYTES,
		});
		return {
			currentFiles: sortSessionReviewFiles(reviewable),
			skippedCount: filePaths.length - reviewable.length,
		};
	}

	async function saveReviewShortlist(next: typeof reviewShortlist, ctx: any) {
		if (JSON.stringify(next) === JSON.stringify(reviewShortlist)) return false;
		reviewShortlist = next;
		pi.appendEntry(REVIEW_SHORTLIST_ENTRY, {
			cwd: path.resolve(ctx.cwd),
			items: reviewShortlist,
		});
		if (reviewSurfaceId && service) {
			const { targets } = await buildSessionReviewTargets(ctx);
			if (targets.length) await service.setWorkspace(targets, { workspaceKey: sessionId });
		}
		return true;
	}

	async function pinReviewFiles(
		filePaths: string[],
		ctx: any,
		{ reason = "agent-selected", source = "agent" } = {},
	) {
		const resolved = filePaths.map((filePath) =>
			path.resolve(ctx.cwd, parseReviewPathArgument(filePath)),
		);
		const status = await inspectSessionReviewFiles(resolved);
		if (!status.currentFiles.length) {
			throw new Error("No supplied paths are reviewable local files");
		}
		const reviewable = status.currentFiles.slice(0, 8);
		const next = updateReviewShortlist(
			reviewShortlist,
			reviewable.map((filePath: string) => ({ filePath, reason, source })),
			ctx.cwd,
			{ allowedRoot: homedir(), limit: 8 },
		);
		await saveReviewShortlist(next, ctx);
		return reviewable;
	}

	async function unpinReviewFile(filePath: string, ctx: any) {
		const target = path.resolve(ctx.cwd, parseReviewPathArgument(filePath));
		const next = reviewShortlist.filter((item) => item.filePath !== target);
		const removed = next.length !== reviewShortlist.length;
		await saveReviewShortlist(next, ctx);
		return removed;
	}

	async function rememberAutomaticReviewFiles(filePaths: string[], ctx: any) {
		const candidates = automaticReviewShortlistCandidates(filePaths, ctx.cwd);
		if (!candidates.length) return;
		const fixed = reviewShortlist.filter((item) => item.source !== "automatic");
		const automatic = updateReviewShortlist(
			reviewShortlist.filter((item) => item.source === "automatic"),
			candidates.map((filePath: string) => ({
				filePath,
				reason: "primary-change",
				source: "automatic",
			})),
			ctx.cwd,
			{ allowedRoot: homedir(), limit: Math.max(1, 8 - fixed.length) },
		);
		const next = updateReviewShortlist([], [...fixed, ...automatic], ctx.cwd, {
			allowedRoot: homedir(),
			limit: 8,
		});
		await saveReviewShortlist(next, ctx);
	}

	function reviewWidgetLines(reviewableCount: number, skippedCount: number) {
		return [
			"Session review ready — run /review",
			`${reviewableCount} reviewable file${reviewableCount === 1 ? "" : "s"}${
				skippedCount ? ` · ${skippedCount} unavailable, oversized, or unsupported skipped` : ""
			}`,
		];
	}

	async function buildSessionReviewTargets(ctx: any) {
		const fileStatus = await inspectSessionReviewFiles();
		const recentFileStatus = await inspectSessionReviewFiles(recentChangedFiles);
		const relevantStatus = await inspectSessionReviewFiles(
			reviewShortlist.map((item) => item.filePath),
		);
		const recentMode = recentDiffPath
			? {
				key: "recent",
				filePath: recentDiffPath,
				label: recentDiffRecovered ? "Last Pi turn · recovered" : undefined,
				scope: recentDiffRecovered
					? "Recovered current content; the exact pre-edit baseline is unavailable"
					: undefined,
			}
			: {
				key: "recent",
				filePath: await writeSessionModeDiff(
					"recent-empty",
					"# The immediately preceding Pi turn made no reviewable file changes.\n",
				),
				empty: true,
			};
		const gitModes = await Promise.all([
			materializeSessionGitMode(
				"staged",
				"staged",
				ctx,
				"There are no staged changes.",
				"The staged diff is unavailable because this directory is not a readable Git worktree.",
			),
			materializeSessionGitMode(
				"commit",
				"HEAD^..HEAD",
				ctx,
				"The latest commit contains no file changes.",
				"The latest commit diff is unavailable.",
			),
			materializeSessionGitMode(
				"branch",
				"origin/main",
				ctx,
				"There are no branch changes relative to origin/main.",
				"The branch diff against origin/main is unavailable.",
			),
		]);
		const targets = buildSessionTargetList({
			cwd: ctx.cwd,
			home: homedir(),
			filePaths: fileStatus.currentFiles,
			recentFilePaths: recentFileStatus.currentFiles,
			relevantFilePaths: relevantStatus.currentFiles,
			modes: [recentMode, ...gitModes],
		});
		return { targets, relevantCount: relevantStatus.currentFiles.length, ...fileStatus };
	}

	async function openSessionReview(ctx: any) {
		latestContext = ctx;
		await refreshSessionChanges(ctx);
		const { targets, currentFiles, skippedCount, relevantCount } = await buildSessionReviewTargets(ctx);
		if (!targets.length) {
			ctx.ui.notify("This session has no reviewable file changes yet.", "info");
			return [];
		}
		await reviewFiles(targets, ctx, { workspaceKey: sessionId });
		recordReviewOpen("session");
		ctx.ui.notify(
			`Opened session review workspace · ${currentFiles.length} session file${currentFiles.length === 1 ? "" : "s"} · ${relevantCount} relevant file${relevantCount === 1 ? "" : "s"}${
				skippedCount ? ` · ${skippedCount} skipped` : ""
			}`,
			"info",
		);
		return targets.map((target) => target.filePath);
	}

	async function openRecentReview(ctx: any) {
		latestContext = ctx;
		if (!recentDiffPath) {
			ctx.ui.notify("The immediately preceding Pi turn made no reviewable changes.", "info");
			return;
		}
		await reviewFile(
			recentDiffPath,
			ctx,
			buildReviewDisplayMetadata({
				kind: "recent",
				cwd: ctx.cwd,
				filePaths: recentChangedFiles,
				sourcePath: recentDiffPath,
			}),
		);
		recordReviewOpen("recent");
		return recentDiffPath;
	}

	async function openGitReview(args: string, ctx: any, requestedCwd = "") {
		const gitCwd = resolveGitReviewCwd(
			ctx.cwd,
			requestedCwd ? parseReviewPathArgument(requestedCwd) : "",
		);
		const gitArgs = buildGitDiffArgs(args);
		const result = await execFileAsync("git", gitArgs, {
			cwd: gitCwd,
			encoding: "utf8",
			maxBuffer: MAX_DIFF_BYTES,
			timeout: 15_000,
		});
		if (!result.stdout) {
			ctx.ui.notify("The requested Git diff is empty.", "info");
			return;
		}
		await mkdir(generatedDiffDir, { recursive: true, mode: 0o700 });
		const diffPath = path.join(
			generatedDiffDir,
			gitDiffReviewFilename(gitCwd, gitArgs),
		);
		const temporary = `${diffPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, result.stdout, {
			encoding: "utf8",
			mode: 0o600,
		});
		await chmod(temporary, 0o600);
		await rename(temporary, diffPath);
		generatedDiffs.add(diffPath);
		await reviewFile(
			diffPath,
			ctx,
			buildReviewDisplayMetadata({
				kind: "git",
				cwd: gitCwd,
				gitRequest: args.trim(),
				sourcePath: diffPath,
			}),
		);
		recordReviewOpen("git");
		return diffPath;
	}

	async function reviewFileCandidates(ctx: any) {
		const { currentFiles } = await inspectSessionReviewFiles();
		return mergeSessionReviewFiles(
			[],
			currentFiles,
			ctx.cwd,
			{ limit: 20, allowedRoot: homedir() },
		);
	}

	async function chooseFileReview(ctx: any, candidateFiles?: string[]) {
		const files = candidateFiles ?? (await reviewFileCandidates(ctx));
		const choices = buildFileReviewChoices(files, ctx.cwd);
		const selected = await ctx.ui.select(
			"Which complete file do you want to review?",
			choices.map((choice: any) => choice.label),
		);
		if (!selected) return;
		const choice = choices.find((candidate: any) => candidate.label === selected);
		let filePath = choice?.value;
		if (!filePath) {
			filePath = await ctx.ui.input(
				"File to review",
				files[0]
					? path.relative(ctx.cwd, files[0])
					: "docs/plan.md",
			);
		}
		if (!filePath?.trim()) return;
		const reviewed = await reviewFile(filePath, ctx);
		await pinReviewFiles([filePath], ctx, { reason: "user-pinned", source: "user" });
		recordReviewOpen("file");
		ctx.ui.notify(`Opened review UI for ${reviewed}`, "info");
	}

	async function openReviewChooser(ctx: any) {
		const candidateFiles = await reviewFileCandidates(ctx);
		const choices = buildReviewChooserChoices({
			changedFilePaths: candidateFiles,
			cwd: ctx.cwd,
			hasRecentDiff: Boolean(recentDiffPath),
		});
		const selected = await ctx.ui.select(
			"What would you like to review?",
			choices.map((choice: any) => choice.label),
		);
		if (!selected) return;
		const choice = choices.find((candidate: any) => candidate.label === selected);
		if (choice?.kind === "recent") {
			await openRecentReview(ctx);
		} else if (choice?.kind === "file") {
			await chooseFileReview(ctx, candidateFiles);
		} else if (choice?.kind === "git") {
			await openGitReview(choice.value ?? "", ctx);
		} else if (choice?.kind === "git-base") {
			const base = await ctx.ui.input("Compare the current branch with", "origin/main");
			if (base?.trim()) await openGitReview(base, ctx);
		}
	}

	pi.registerCommand("review", {
		description: "Open the session review workspace, or target an advanced view",
		handler: async (args, ctx) => {
			latestContext = ctx;
			try {
				if (!args.trim()) {
					await openSessionReview(ctx);
					return;
				}
				const command = args.trim();
				if (command === "choose") {
					await openReviewChooser(ctx);
					return;
				}
				if (command === "git" || command.startsWith("git ")) {
					await openGitReview(command.slice(3).trim(), ctx);
					return;
				}
				if (command.startsWith("pin ")) {
					const pinned = await pinReviewFiles(
						[command.slice(4).trim()],
						ctx,
						{ reason: "user-pinned", source: "user" },
					);
					ctx.ui.notify(`Pinned for review · ${pinned[0]}`, "info");
					return;
				}
				if (command.startsWith("unpin ")) {
					await unpinReviewFile(command.slice(6).trim(), ctx);
					ctx.ui.notify("Removed from relevant review files.", "info");
					return;
				}
				const reviewed = await reviewFile(command, ctx);
				await pinReviewFiles([command], ctx, { reason: "user-pinned", source: "user" });
				recordReviewOpen("file");
				ctx.ui.notify(`Opened review UI for ${reviewed}`, "info");
			} catch (error) {
				ctx.ui.notify(`Review UI failed: ${String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "review_open",
		label: "Open review",
		description:
			"Open the review UI directly when the user asks to review files or a diff, or save a bounded relevant-file shortlist with mode=pin. Session mode opens the cumulative session workspace in one reusable popout. File mode accepts up to 100 paths in one lazy navigable set; Git mode accepts staged, unstaged, a base ref, or an exact revision range; recent mode opens the immediately preceding Pi turn.",
		parameters: Type.Object({
			mode: Type.Union([
				Type.Literal("files"),
				Type.Literal("session"),
				Type.Literal("git"),
				Type.Literal("recent"),
				Type.Literal("pin"),
			]),
			files: Type.Optional(
				Type.Array(Type.String({ maxLength: 1200 }), {
					minItems: 1,
					maxItems: 100,
				}),
			),
			git: Type.Optional(Type.String({ maxLength: 300 })),
			cwd: Type.Optional(Type.String({ maxLength: 1200 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestContext = ctx;
			let opened: string[] = [];
			if (params.mode === "session") {
				opened = await openSessionReview(ctx);
			} else if (params.mode === "pin") {
				if (!params.files?.length) throw new Error("pin mode requires at least one path");
				opened = await pinReviewFiles(params.files, ctx, {
					reason: "agent-selected",
					source: "agent",
				});
			} else if (params.mode === "files") {
				if (!params.files?.length) throw new Error("files mode requires at least one path");
				opened = await reviewFiles(params.files, ctx);
				await pinReviewFiles(params.files, ctx, {
					reason: "agent-selected",
					source: "agent",
				});
				if (opened.length) recordReviewOpen("files");
			} else if (params.mode === "git") {
				const diffPath = await openGitReview(
					params.git ?? "",
					ctx,
					params.cwd ?? "",
				);
				if (diffPath) opened = [diffPath];
			} else {
				const recentPath = await openRecentReview(ctx);
				if (recentPath) opened = [recentPath];
			}
			const details = { mode: params.mode, opened };
			return {
				content: [{
					type: "text",
					text: opened.length
						? params.mode === "pin"
							? `Saved ${opened.length} relevant review file${opened.length === 1 ? "" : "s"}.`
							: `Opened review UI for ${opened.length} target${opened.length === 1 ? "" : "s"}.`
						: "No reviewable content was available.",
				}],
				details,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		const recoveryState = reviewRecoveryStates.get(sessionId);
		reviewShortlist = restoreReviewShortlist(
			ctx.sessionManager.getBranch(),
			ctx.cwd,
			{ limit: 8, allowedRoot: homedir() },
		);
		sessionChangedFiles = restoreReviewFileCandidates(
			ctx.sessionManager.getBranch(),
			ctx.cwd,
			{ limit: 100, allowedRoot: homedir() },
		);
		recentChangedFiles = restoreRecentReviewFileCandidates(
			ctx.sessionManager.getBranch(),
			ctx.cwd,
			{ limit: 100, allowedRoot: homedir() },
		);
		if (!recentChangedFiles.length) {
			recentChangedFiles = restoreRecentToolFileCandidates(
				ctx.sessionManager.getBranch(),
				ctx.cwd,
				{ limit: 100, allowedRoot: homedir() },
			);
		}
		sessionChangedFiles = mergeSessionReviewFiles(
			sessionChangedFiles,
			recentChangedFiles,
			ctx.cwd,
			{ limit: 100, allowedRoot: homedir() },
		);
		if (recentChangedFiles.length) {
			try {
				const recoveredDiff = await buildRecoveredTargetDiff(recentChangedFiles);
				if (recoveredDiff) {
					await writeRecentDiff(recoveredDiff);
					recentDiffRecovered = true;
				}
			} catch (error) {
				ctx.ui.notify(`Recovered review diff unavailable: ${String(error)}`, "warning");
			}
		}
		reviewWindowId = recoveryState?.reviewWindowId ?? "";
		reviewSurfaceId = recoveryState?.reviewSurfaceId ?? "";
		if (sessionChangedFiles.length) {
			const restoredStatus = await inspectSessionReviewFiles();
			ctx.ui.setWidget(
				"review-suggestions",
				reviewWidgetLines(
					restoredStatus.currentFiles.length,
					restoredStatus.skippedCount,
				),
				{ placement: "belowEditor" },
			);
		}
		try {
			service = await createReviewServer({
				allowedRoots: [homedir(), tmpdir()],
				commentsPath,
				onAppendDraft: async (addition: string) => {
					const editor = latestContext?.ui;
					if (!editor?.setEditorText) {
						throw new Error("This Pi build does not expose editor draft controls");
					}
					const current = editor.getEditorText?.() ?? "";
					editor.setEditorText(appendReviewDraft(current, addition));
					editor.notify("Review context added to the Pi draft.", "info");
				},
				onOpen: openReviewUrl,
				port: recoveryState?.port,
				recoverySecret: recoveryState?.secret,
			});
			reviewRecoveryStates.set(sessionId, service.recoveryState);
			rememberReviewWindow();
			if (sessionChangedFiles.length) {
				const { targets: restoredTargets } = await buildSessionReviewTargets(ctx);
				if (restoredTargets.length) {
					await service.setWorkspace(restoredTargets, { workspaceKey: sessionId });
				}
			}
			await refreshRegistry(ctx);
		} catch (error) {
			ctx.ui.notify(`Review UI unavailable: ${String(error)}`, "warning");
		}
		try {
			await ensureSessionBaseline(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`Session review baseline unavailable: ${String(error)}`, "warning");
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		latestContext = ctx;
		if (!collectingChangedFiles) {
			collectingChangedFiles = true;
			turnSequence += 1;
			recentBaselines.clear();
			ctx.ui.setWidget("review-suggestions", undefined);
			try {
				await ensureSessionBaseline(ctx.cwd);
				const baseline = await beginRecentTurn(ctx.cwd);
				recentBaselines.set(baseline.root, baseline);
			} catch (error) {
				recentBaselines.clear();
				ctx.ui.notify(`Recent review baseline unavailable: ${String(error)}`, "warning");
			}
		}
		try {
			await refreshRegistry(ctx);
		} catch {
			// A failed metadata refresh must not interrupt the agent turn.
		}
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nREVIEW RELEVANCE\nWhen a task has a small set of files the user will likely want to inspect, call review_open with mode=pin once and 1-8 paths. Pin primary implementation files, task plans, and user-facing artifacts. Do not pin lockfiles, generated output, vendored files, or incidental fixtures.`,
	}));

	pi.on("tool_execution_start", async (event, ctx) => {
		for (const changedArgument of reviewToolFilePaths(event.toolName, event.args)) {
			try {
				const changedPath = path.resolve(ctx.cwd, changedArgument);
				await captureRecentPathInBaselines(recentBaselines, changedPath);
				await captureRecentPathInBaselines(sessionBaselines, changedPath);
			} catch {
				// Git-visible changes are still captured when direct path capture fails.
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const changedAbsolute: string[] = [];
		const skippedAbsolute: string[] = [];
		const diffs: string[] = [];
		try {
			for (const [root, baseline] of recentBaselines) {
				const result = await finishRecentTurn(baseline);
				if (result.diff) diffs.push(result.diff);
				changedAbsolute.push(...result.changedPaths.map((relative: string) => path.join(root, relative)));
				skippedAbsolute.push(...result.skippedPaths.map((relative: string) => path.join(root, relative)));
			}
			if (diffs.length) {
				await writeRecentDiff(diffs.join("\n"));
				recentDiffRecovered = false;
			}
			else await clearRecentDiff();
		} catch (error) {
			await clearRecentDiff();
			ctx.ui.notify(`Recent review diff failed: ${String(error)}`, "warning");
		}
		recentChangedFiles = mergeSessionReviewFiles(
			[],
			changedAbsolute,
			ctx.cwd,
			{ limit: 100, allowedRoot: homedir() },
		);
		sessionChangedFiles = mergeSessionReviewFiles(
			sessionChangedFiles,
			changedAbsolute,
			ctx.cwd,
			{ limit: 100, allowedRoot: homedir() },
		);
		await rememberAutomaticReviewFiles(recentChangedFiles, ctx);
		pi.appendEntry(REVIEW_SUGGESTIONS_ENTRY, {
			cwd: path.resolve(ctx.cwd),
			files: sessionChangedFiles.slice(0, 100),
			recentFiles: recentChangedFiles.slice(0, 100),
			updatedAt: new Date().toISOString(),
		});
		if (recentDiffPath) {
			const settledStatus = await inspectSessionReviewFiles();
			ctx.ui.setWidget(
				"review-suggestions",
				reviewWidgetLines(
					settledStatus.currentFiles.length,
					settledStatus.skippedCount,
				),
				{ placement: "belowEditor" },
			);
			ctx.ui.notify("Session review ready — run /review", "info");
		}
		if (skippedAbsolute.length) {
			ctx.ui.notify(
				`Recent review skipped ${skippedAbsolute.length} oversized or unsupported files.`,
				"warning",
			);
		}
		if (reviewSurfaceId && service) {
			try {
				await refreshSessionChanges(ctx);
				const { targets } = await buildSessionReviewTargets(ctx);
				if (targets.length) {
					await service.setWorkspace(targets, { workspaceKey: sessionId });
				}
			} catch (error) {
				ctx.ui.notify(`Open review workspace refresh failed: ${String(error)}`, "warning");
			}
		}
		collectingChangedFiles = false;
		recentBaselines.clear();
	});

	pi.on("session_shutdown", async () => {
		latestContext?.ui?.setWidget?.("review-suggestions", undefined);
		if (sessionId) await removeReviewSession(registryDir, sessionId);
		await service?.close();
		service = undefined;
		for (const diffPath of generatedDiffs) {
			try {
				await unlink(diffPath);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		generatedDiffs.clear();
		recentDiffPath = "";
		recentDiffRecovered = false;
		recentChangedFiles = [];
		recentBaselines.clear();
		sessionChangedFiles = [];
		reviewShortlist = [];
		sessionBaselines.clear();
		reviewWindowId = "";
		reviewSurfaceId = "";
	});
}
