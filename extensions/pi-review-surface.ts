import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
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
const reviewRecoveryStates: Map<string, { port: number; secret: string }> =
	((globalThis as any)[REVIEW_RECOVERY_STATE] ??= new Map());

export default async function reviewSurfaceExtension(pi: ExtensionAPI) {
	const reviewSurfacePath = fileURLToPath(
		new URL("../src/review-surface.mjs", import.meta.url),
	);
	const {
		appendReviewDraft,
		createReviewServer,
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
		captureRecentPath,
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
		mergeReviewFileCandidates,
		parseReviewPathArgument,
		restoreReviewFileCandidates,
		REVIEW_SUGGESTIONS_ENTRY,
	} = await importFreshSourceModule(reviewSuggestionsPath);
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
	let sessionId = "";
	let collectingChangedFiles = false;
	let recentBaseline: any;
	let recentDiffPath = "";
	let recentChangedFiles: string[] = [];
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

	async function openReviewUrl(url: string) {
		const args = ["browser", "open", url];
		const workspaceId = process.env.CMUX_WORKSPACE_ID;
		if (workspaceId) args.push("--workspace", workspaceId);
		args.push("--focus", "true");
		const result = await pi.exec("cmux", args);
		if (result.code === 0) return;
		const fallback = await pi.exec("/usr/bin/open", [url]);
		if (fallback.code !== 0) {
			throw new Error(result.stderr || fallback.stderr || "Unable to open review UI");
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

	async function reviewFiles(filePaths: string[], ctx = latestContext) {
		if (!service) throw new Error("Review surface is not ready");
		const resolved = filePaths.map((filePath) =>
			path.resolve(
				ctx?.cwd || process.cwd(),
				parseReviewPathArgument(filePath),
			),
		);
		await refreshRegistry(ctx);
		const opened = await service.openFiles(resolved);
		await openReviewUrl(opened.url);
		return resolved;
	}

	async function clearRecentDiff() {
		const previous = recentDiffPath;
		recentDiffPath = "";
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
		return diffPath;
	}

	async function reviewFileCandidates(ctx: any) {
		const commands = [
			["diff", "--name-only", "-z", "--"],
			["diff", "--cached", "--name-only", "-z", "--"],
			["ls-files", "--others", "--exclude-standard", "-z"],
		];
		const results = await Promise.all(
			commands.map((args) => pi.exec("git", ["-C", ctx.cwd, ...args])),
		);
		const gitFiles = results.flatMap((result) =>
			result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [],
		);
		return mergeReviewFileCandidates(
			recentChangedFiles,
			gitFiles,
			ctx.cwd,
			{ limit: 20 },
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
		description: "Choose a review view, or open a file directly",
		handler: async (args, ctx) => {
			latestContext = ctx;
			try {
				if (!args.trim()) {
					await openReviewChooser(ctx);
					return;
				}
				const command = args.trim();
				if (command === "git" || command.startsWith("git ")) {
					await openGitReview(command.slice(3).trim(), ctx);
					return;
				}
				const reviewed = await reviewFile(command, ctx);
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
			"Open the review UI directly when the user asks to review files or a diff. Use this instead of telling the user to type /review. File mode accepts up to eight paths in one navigable review set; Git mode accepts staged, unstaged, a base ref, or an exact revision range; recent mode opens the immediately preceding Pi turn.",
		parameters: Type.Object({
			mode: Type.Union([
				Type.Literal("files"),
				Type.Literal("git"),
				Type.Literal("recent"),
			]),
			files: Type.Optional(
				Type.Array(Type.String({ maxLength: 1200 }), {
					minItems: 1,
					maxItems: 8,
				}),
			),
			git: Type.Optional(Type.String({ maxLength: 300 })),
			cwd: Type.Optional(Type.String({ maxLength: 1200 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestContext = ctx;
			let opened: string[] = [];
			if (params.mode === "files") {
				if (!params.files?.length) throw new Error("files mode requires at least one path");
				opened = await reviewFiles(params.files, ctx);
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
						? `Opened review UI for ${opened.length} target${opened.length === 1 ? "" : "s"}.`
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
		recentChangedFiles = restoreReviewFileCandidates(
			ctx.sessionManager.getBranch(),
			ctx.cwd,
			{ limit: 20 },
		);
		if (recentChangedFiles.length) {
			const restoredChoice = buildReviewChooserChoices({
				changedFilePaths: recentChangedFiles,
				cwd: ctx.cwd,
				hasRecentDiff: false,
			})[0];
			ctx.ui.setWidget(
				"review-suggestions",
				[
					"Files edited by Pi are ready — run /review",
					restoredChoice?.label ?? "Open a complete file",
				],
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
			await refreshRegistry(ctx);
		} catch (error) {
			ctx.ui.notify(`Review UI unavailable: ${String(error)}`, "warning");
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		latestContext = ctx;
		if (!collectingChangedFiles) {
			collectingChangedFiles = true;
			turnSequence += 1;
			ctx.ui.setWidget("review-suggestions", undefined);
			try {
				recentBaseline = await beginRecentTurn(ctx.cwd);
			} catch (error) {
				recentBaseline = undefined;
				ctx.ui.notify(`Recent review baseline unavailable: ${String(error)}`, "warning");
			}
		}
		try {
			await refreshRegistry(ctx);
		} catch {
			// A failed metadata refresh must not interrupt the agent turn.
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const changedArgument =
			typeof event.args?.path === "string"
				? event.args.path
				: typeof event.args?.file_path === "string"
					? event.args.file_path
					: "";
		if (
			recentBaseline &&
			(event.toolName === "edit" ||
				event.toolName === "write" ||
				event.toolName === "apply_patch") &&
			changedArgument.trim()
		) {
			try {
				await captureRecentPath(
					recentBaseline,
					path.resolve(ctx.cwd, changedArgument),
				);
			} catch {
				// Git-visible changes are still captured when direct path capture fails.
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		let recentResult = {
			diff: "",
			changedPaths: [] as string[],
			skippedPaths: [] as string[],
		};
		try {
			if (recentBaseline) recentResult = await finishRecentTurn(recentBaseline);
			if (recentResult.diff) await writeRecentDiff(recentResult.diff);
			else await clearRecentDiff();
		} catch (error) {
			await clearRecentDiff();
			ctx.ui.notify(`Recent review diff failed: ${String(error)}`, "warning");
		}
		const changedAbsolute = recentResult.changedPaths.map((relative: string) =>
			path.join(recentBaseline?.root ?? ctx.cwd, relative),
		);
		recentChangedFiles = changedAbsolute;
		pi.appendEntry(REVIEW_SUGGESTIONS_ENTRY, {
			cwd: path.resolve(ctx.cwd),
			files: recentChangedFiles.slice(0, 20),
			updatedAt: new Date().toISOString(),
		});
		if (recentDiffPath) {
			const recentChoice = buildReviewChooserChoices({
				changedFilePaths: recentChangedFiles,
				cwd: ctx.cwd,
				hasRecentDiff: true,
			})[0];
			ctx.ui.setWidget(
				"review-suggestions",
				[
					"Review ready — run /review",
					recentChoice?.label ?? "Changes from last Pi turn",
				],
				{ placement: "belowEditor" },
			);
			ctx.ui.notify("Review ready — run /review", "info");
		}
		if (recentResult.skippedPaths.length) {
			ctx.ui.notify(
				`Recent review skipped ${recentResult.skippedPaths.length} oversized or unsupported files.`,
				"warning",
			);
		}
		collectingChangedFiles = false;
		recentBaseline = undefined;
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
		recentChangedFiles = [];
	});
}
