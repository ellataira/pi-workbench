import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	checkpointFromPiEntries,
	classifyPiChildEnvironment,
} from "../src/adapters/pi.mjs";
import { AgentJournal } from "../src/journal.mjs";
import { importFreshSourceModule } from "../src/fresh-module.mjs";
import {
	distillationCatchupPlan,
	distillationTarget,
	maintenanceDefaults,
	previousLocalDate,
	shouldRunCleanupAudit,
} from "../src/maintenance-policy.mjs";
import {
	auditRetentionReceipts,
	claimDriveBackup,
	confirmDriveBackup,
	evictDriveArchivedNotes,
	recordDriveIntegrity,
	retentionIntegritySample,
	retentionCandidates,
} from "../src/retention-audit.mjs";

const Summary = Type.Object({
	goal: Type.String({ maxLength: 600 }),
	outcomes: Type.Array(Type.String({ maxLength: 360 }), { maxItems: 8 }),
	decisions: Type.Array(Type.String({ maxLength: 360 }), { maxItems: 6 }),
	nextSteps: Type.Array(Type.String({ maxLength: 360 }), { maxItems: 6 }),
	artifacts: Type.Array(Type.String({ maxLength: 800 }), { maxItems: 12 }),
	tags: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 4 }),
});

const DateValue = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}$",
	maxLength: 10,
});

function roots() {
	return {
		vaultRoot:
			process.env.AGENT_JOURNAL_VAULT_ROOT ??
			path.join(homedir(), "Documents", "Obsidian Vault", "ella.taira", "agent-journal"),
		stateRoot:
			process.env.AGENT_JOURNAL_STATE_ROOT ??
			path.join(homedir(), ".agents", "state", "agent-journal"),
	};
}

export default async function agentJournalExtension(pi: ExtensionAPI) {
	const schemaPath = fileURLToPath(
		new URL("../src/schema.mjs", import.meta.url),
	);
	const { sanitizeArtifactReferences } = await importFreshSourceModule(schemaPath);
	const policyPath = fileURLToPath(
		new URL("../src/pi-memory-policy.mjs", import.meta.url),
	);
	const {
		CHECKPOINT_STATE_ENTRY,
		automaticRecallDefaults,
		autoCheckpointMessage,
		autoCheckpointRetryMessage,
		assistantRunFailed,
		checkpointCadenceFromEntries,
		classifyCheckpointTurn,
		checkpointSourceEntries,
		createRunState,
		dailyDistillationMessage,
		driveIntegrityMessage,
		driveWorkspaceFallback,
		formatRecallContext,
		isDistillationPrompt,
		isDriveIntegrityPrompt,
		isDurableCheckpointRun,
		recordToolCompletion,
		recordToolStart,
		recallUsageMetric,
		shouldCheckpointBeforeCompaction,
		shouldProactivelyRecall,
		shouldSearchDriveWorkspace,
		shouldQueueAutoCheckpoint,
	} = await importFreshSourceModule(policyPath);
	const journal = new AgentJournal(roots());
	const repositoryCache = new Map<string, string>();
	let currentRun: ReturnType<typeof createRunState> | undefined;
	let memoryOperation = "";
	let autoCheckpointPending = false;
	let autoCheckpointRetries = 0;
	let distillationDue: string | undefined;
	let integrityDue = false;
	let lastCheckpointAt: number | undefined;
	let durableWorkPending = false;
	let compactionCheckpointAttempted = false;
	let deferredCompaction:
		| {
				customInstructions?: string;
		  }
		| undefined;

	function persistCheckpointCadence() {
		pi.appendEntry(CHECKPOINT_STATE_ENTRY, {
			savedAt:
				lastCheckpointAt === undefined
					? undefined
					: new Date(lastCheckpointAt).toISOString(),
			durableWorkPending,
		});
	}

	function markDurableWorkPending() {
		if (durableWorkPending) return;
		durableWorkPending = true;
		persistCheckpointCadence();
	}

	function markCheckpointSaved(now = Date.now()) {
		lastCheckpointAt = now;
		durableWorkPending = false;
		autoCheckpointRetries = 0;
		persistCheckpointCadence();
	}

	function queueAutomaticCheckpoint(
		customType = "agent-journal-auto-checkpoint",
		content = autoCheckpointMessage(),
	) {
		if (autoCheckpointPending) return;
		autoCheckpointPending = true;
		pi.sendMessage(
			{
				customType,
				content,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function resumeDeferredCompaction(ctx: ExtensionContext) {
		const pending = deferredCompaction;
		if (!pending) return;
		deferredCompaction = undefined;
		ctx.compact({
			customInstructions: pending.customInstructions,
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Compaction after journal checkpoint failed: ${error.message}`,
						"warning",
					);
				}
			},
		});
	}

	async function repositoryForCwd(cwd: string) {
		const cached = repositoryCache.get(cwd);
		if (cached !== undefined) return cached;
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
		const repository =
			result.code === 0 && result.stdout.trim()
				? path.basename(result.stdout.trim())
				: "";
		repositoryCache.set(cwd, repository);
		return repository;
	}

	async function metadata(ctx: ExtensionContext) {
		const cwd = ctx.cwd;
		const branchResult = await pi.exec("git", ["-C", cwd, "branch", "--show-current"]);
		const repository = await repositoryForCwd(cwd);
		const child = classifyPiChildEnvironment(process.env);
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			sourcePath: ctx.sessionManager.getSessionFile() ?? "",
			cwd,
			repository,
			branch: branchResult.code === 0 ? branchResult.stdout.trim() : "",
			parent: child.parent,
			childClass: child.childClass,
		};
	}

	async function capture(
		ctx: ExtensionContext,
		checkpointKind: "checkpoint",
		summary: {
			goal: string;
			outcomes: string[];
			decisions: string[];
			nextSteps: string[];
			artifacts: string[];
			tags: string[];
		},
		checkpointId: string,
	) {
		const entries = checkpointSourceEntries(ctx.sessionManager.getBranch());
		if (!entries.some((entry) => entry.type === "message")) return undefined;
		const meta = await metadata(ctx);
		const artifactResult = sanitizeArtifactReferences(summary.artifacts);
		const value = checkpointFromPiEntries(entries, {
			...meta,
			checkpointKind,
			checkpointId,
			summary: {
				...summary,
				artifacts: artifactResult.artifacts,
			},
			status: checkpointKind,
		});
		const result = await journal.ingest(value);
		ctx.ui.setStatus(
			"agent-journal",
			result.status === "appended" ? "journal:saved" : "journal:current",
		);
		return {
			...result,
			discardedArtifactCount: artifactResult.discardedArtifactCount,
		};
	}

	async function refreshDistillationDue(now = new Date()) {
		const state = await journal.maintenanceState();
		distillationDue =
			distillationTarget(now, state, {
				hour: maintenanceDefaults.distillationHour,
				timeZone: maintenanceDefaults.timeZone,
			}) ?? distillationDue;
		return distillationDue;
	}

	async function queueDistillation(ctx: ExtensionContext) {
		if (!ctx.hasUI || !distillationDue) return;
		const initialDate = distillationDue;
		distillationDue = undefined;
		if (!(await journal.claimDistillation(initialDate))) return;
		const plan = await distillationCatchupPlan(
			initialDate,
			previousLocalDate(),
			(date) => journal.distillationCandidates(date),
		);
		if (plan.emptyThrough) {
			await journal.markDistillationCompleted(plan.emptyThrough, []);
		}
		if (!plan.reviewDate) {
			ctx.ui.notify(
				`Daily memory review caught up through ${plan.emptyThrough}; no promotion candidates.`,
				"info",
			);
			return;
		}
		const date = plan.reviewDate;
		if (date !== initialDate && !(await journal.claimDistillation(date))) return;
		pi.events.emit("action-inbox:upsert", {
			id: `distillation:${date}`,
			state: "approval",
			source: "distillation",
			code: "daily-distillation",
			sessionId: ctx.sessionManager.getSessionId(),
			workspaceId: process.env.CMUX_WORKSPACE_ID,
			updatedAt: new Date().toISOString(),
		});
		pi.sendMessage(
			{
				customType: "agent-journal-daily-distillation",
				content: dailyDistillationMessage(date),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	async function queueIntegrity(ctx: ExtensionContext) {
		if (!ctx.hasUI || !integrityDue) return;
		integrityDue = false;
		pi.sendMessage(
			{
				customType: "agent-journal-drive-integrity",
				content: driveIntegrityMessage(),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	async function runRetentionAudit(
		now = new Date(),
		options: { cursor?: string; limit?: number } = {},
	) {
		const configuredRoots = roots();
		const maintenanceState = await journal.maintenanceState();
		const sessionsRoot =
			process.env.PI_CODING_AGENT_SESSION_DIR ??
			path.join(homedir(), ".pi", "agent", "sessions");
		const result = await retentionCandidates({
			sessionsRoot,
			journalRoot: path.join(configuredRoots.vaultRoot, "sessions"),
			receiptsRoot: path.join(configuredRoots.stateRoot, "retention-receipts"),
			now,
			retentionDays: maintenanceDefaults.nativeSessionRetentionDays,
			cursor: options.cursor,
			limit: options.limit ?? 5,
		});
		await journal.updateMaintenanceState({
			lastCleanupAuditAt: result.scannedAt,
			lastCleanupCandidateCount: result.candidateCount,
			lastCleanupDeletionCount: 0,
		});
		return {
			...result,
			driveFolderId:
				process.env.AGENT_JOURNAL_DRIVE_FOLDER_ID ??
				maintenanceState.driveArchiveFolderId ??
				"",
		};
	}

	async function runColdTierEviction(now = new Date()) {
		const configuredRoots = roots();
		const result = await evictDriveArchivedNotes({
			journalRoot: path.join(configuredRoots.vaultRoot, "sessions"),
			receiptsRoot: path.join(configuredRoots.stateRoot, "retention-receipts"),
			now,
			localRetentionDays: 90,
		});
		await journal.updateMaintenanceState({
			lastColdTierEvictionAt: result.checkedAt,
			lastColdTierEvictionCount: result.evictedCount,
		});
		return result;
	}

	pi.registerTool({
		name: "journal_retention_candidates",
		label: "Drive retention candidates",
		description:
			"Return 30-day-old native Pi sessions and their compressed-summary-v1 backup payloads. The payload never contains the native transcript.",
		parameters: Type.Object({
			cursor: Type.Optional(Type.String({ maxLength: 2000 })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
		}),
		async execute(_toolCallId, params) {
			const result = await runRetentionAudit(new Date(), params);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_claim_drive_backup",
		label: "Claim one Drive retention upload",
		description:
			"Atomically claim one compressed-summary upload for 15 minutes. Only a claimed result authorizes Drive search/create; in-progress must be skipped.",
		parameters: Type.Object({
			sessionPath: Type.String({ maxLength: 1200 }),
			notePath: Type.String({ maxLength: 1200 }),
			noteSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
			backupName: Type.String({ maxLength: 400 }),
		}),
		async execute(_toolCallId, params) {
			const configuredRoots = roots();
			const result = await claimDriveBackup({
				...params,
				receiptsRoot: path.join(configuredRoots.stateRoot, "retention-receipts"),
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_audit_retention_receipts",
		label: "Audit retention receipts",
		description:
			"Report corrupt, schema-invalid, and duplicate Drive retention receipts without repairing or deleting them.",
		parameters: Type.Object({}),
		async execute() {
			const configuredRoots = roots();
			const result = await auditRetentionReceipts(
				path.join(configuredRoots.stateRoot, "retention-receipts"),
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_drive_integrity_sample",
		label: "Drive archive integrity sample",
		description:
			"Return up to five least-recently-verified Drive archive receipts for the weekly integrity monitor.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
		}),
		async execute(_toolCallId, params) {
			const configuredRoots = roots();
			const result = await retentionIntegritySample(
				path.join(configuredRoots.stateRoot, "retention-receipts"),
				params.limit ?? 5,
			);
			await journal.updateMaintenanceState({
				lastDriveIntegrityAuditAt: new Date().toISOString(),
				lastDriveIntegritySampleCount: result.items.length,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_evict_cold_memory",
		label: "Evict verified cold memory",
		description:
			"Delete local compressed session Markdown older than 90 days only when an exact verified Drive receipt exists. Search metadata and the receipt remain local.",
		parameters: Type.Object({}),
		async execute() {
			const result = await runColdTierEviction();
			return {
				content: [
					{
						type: "text",
						text: `Cold-tier eviction: ${result.evictedCount} local compressed notes removed; ${result.keptCount} kept.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_record_drive_integrity",
		label: "Record Drive archive integrity",
		description:
			"Record a Drive archive integrity result. Verified status requires exact content matching the receipt SHA-256.",
		parameters: Type.Object({
			driveFileId: Type.String({ maxLength: 400 }),
			status: Type.Union([Type.Literal("verified"), Type.Literal("unavailable")]),
			readBackText: Type.Optional(Type.String({ maxLength: 250_000 })),
		}),
		async execute(_toolCallId, params) {
			const configuredRoots = roots();
			const result = await recordDriveIntegrity({
				receiptsRoot: path.join(
					configuredRoots.stateRoot,
					"retention-receipts",
				),
				...params,
			});
			return {
				content: [
					{
						type: "text",
						text: `Drive archive ${result.driveFileId}: ${result.integrityStatus}.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_confirm_drive_backup",
		label: "Verify Drive backup and clean local session",
		description:
			"Verify that content read back from a specific Drive file exactly matches a local compressed session summary, persist a verification receipt, then delete only the corresponding 30-day-old native Pi JSONL.",
		parameters: Type.Object({
			sessionPath: Type.String({ maxLength: 1200 }),
			notePath: Type.String({ maxLength: 1200 }),
			claimToken: Type.String({ maxLength: 100 }),
			driveFileId: Type.String({ maxLength: 400 }),
			remoteContent: Type.String({ maxLength: 250_000 }),
		}),
		async execute(_toolCallId, params) {
			const configuredRoots = roots();
			const maintenanceState = await journal.maintenanceState();
			const driveFolderId =
				process.env.AGENT_JOURNAL_DRIVE_FOLDER_ID ??
				maintenanceState.driveArchiveFolderId ??
				"";
			if (!driveFolderId) throw new Error("Drive archive folder ID is not configured");
			const sessionsRoot =
				process.env.PI_CODING_AGENT_SESSION_DIR ??
				path.join(homedir(), ".pi", "agent", "sessions");
			const result = await confirmDriveBackup({
				...params,
				sessionsRoot,
				journalRoot: path.join(configuredRoots.vaultRoot, "sessions"),
				receiptsRoot: path.join(configuredRoots.stateRoot, "retention-receipts"),
				driveFolderId,
				retentionDays: maintenanceDefaults.nativeSessionRetentionDays,
				onVerified: (receipt) =>
					journal.recordDriveArchive({
						notePath: receipt.notePath,
						driveFileId: receipt.driveFileId,
						driveFolderId: receipt.driveFolderId,
						driveFileName: receipt.driveFileName,
						noteSha256: receipt.noteSha256,
					}),
			});
			await journal.updateMaintenanceState({
				lastCleanupDeletionAt: new Date().toISOString(),
				lastCleanupDeletionCount: 1,
			});
			return {
				content: [
					{
						type: "text",
						text: `Drive backup verified; deleted native session ${result.deletedPath}. The compressed journal note and verification receipt remain.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_rehydrate_drive_memory",
		label: "Rehydrate verified Drive memory",
		description:
			"Restore a locally missing compressed journal note from an indexed Drive archive. The Drive file ID must be registered and the exact read-back content must match its recorded SHA-256.",
		parameters: Type.Object({
			driveFileId: Type.String({ maxLength: 400 }),
			readBackText: Type.String({ maxLength: 250_000 }),
		}),
		async execute(_toolCallId, params) {
			const result = await journal.rehydrateDriveArchive(
				params.driveFileId,
				params.readBackText,
			);
			return {
				content: [
					{
						type: "text",
						text: `Verified and restored compressed memory ${result.notePath}. Local indexed retrieval is active again.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_checkpoint",
		label: "Journal checkpoint",
		description:
			"Save a concise durable checkpoint only when the user explicitly requests one or an agent-journal automatic checkpoint message requires it. Store goals, outcomes, decisions, next steps, artifact paths, and stable tags. Never include raw transcripts.",
		parameters: Summary,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const leafId = ctx.sessionManager.getLeafId() ?? toolCallId;
			const result = await capture(ctx, "checkpoint", params, `explicit-${leafId}`);
			return {
				content: [
					{
						type: "text",
						text: result
							? `Journal checkpoint ${result.status}: ${result.notePath}`
							: "No persisted session activity to journal.",
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_distillation_candidates",
		label: "Daily memory candidates",
		description:
			"Return compressed, provenance-linked session summaries for one calendar date so the user can choose what to promote.",
		parameters: Type.Object({ date: DateValue }),
		async execute(_toolCallId, params) {
			const candidates = await journal.distillationCandidates(params.date);
			return {
				content: [{ type: "text", text: JSON.stringify({ date: params.date, candidates }, null, 2) }],
				details: { date: params.date, candidates },
			};
		},
	});

	pi.registerTool({
		name: "journal_promote",
		label: "Promote memory",
		description:
			"Promote one user-approved compressed lesson into durable global or project memory.",
		parameters: Type.Object({
			title: Type.String({ maxLength: 240 }),
			content: Type.String({ maxLength: 4000 }),
			scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
			repository: Type.Optional(Type.String({ maxLength: 240 })),
			sourceIdentity: Type.String({ maxLength: 240 }),
			tags: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 4 }),
		}),
		async execute(_toolCallId, params) {
			const result = await journal.promote(params);
			return {
				content: [{ type: "text", text: `Promoted memory: ${result.notePath}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "journal_distillation_complete",
		label: "Complete daily memory review",
		description:
			"Mark a daily memory distillation complete after the user has promoted, edited, or skipped every candidate.",
		parameters: Type.Object({
			date: DateValue,
			promotedMemoryIds: Type.Array(Type.String({ maxLength: 240 }), {
				maxItems: 64,
			}),
		}),
		async execute(_toolCallId, params) {
			const rollups = await journal.dailyRollupsThrough(params.date);
			const state = await journal.markDistillationCompleted(
				params.date,
				params.promotedMemoryIds,
			);
			pi.events.emit("action-inbox:acknowledge", {
				id: `distillation:${params.date}`,
			});
			return {
				content: [{ type: "text", text: `Daily memory review completed through ${params.date}.` }],
				details: { state, rollups },
			};
		},
	});

	async function requestCheckpoint(ctx: ExtensionContext) {
		ctx.ui.setStatus("agent-journal", "checkpoint:queued");
		await pi.sendUserMessage(
			"Create a compressed session checkpoint now. Call journal_checkpoint exactly once. Summarize only the goal, outcomes, decisions, next steps, artifact paths, and stable tags. Do not quote, reproduce, or store any user prompt, assistant response, tool argument, or transcript excerpt.",
			{ deliverAs: "followUp" },
		);
	}

	async function requestDistillation(args: string, ctx: ExtensionContext) {
		const date = args.trim() || previousLocalDate();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			throw new Error("Usage: /distill [YYYY-MM-DD]");
		}
		await journal.markDistillationPrompted(date);
		pi.events.emit("action-inbox:upsert", {
			id: `distillation:${date}`,
			state: "approval",
			source: "distillation",
			code: "daily-distillation",
			sessionId: ctx.sessionManager.getSessionId(),
			workspaceId: process.env.CMUX_WORKSPACE_ID,
			updatedAt: new Date().toISOString(),
		});
		ctx.ui.setStatus("agent-journal", `memory-review:queued · ${date}`);
		await pi.sendUserMessage(dailyDistillationMessage(date), {
			deliverAs: "followUp",
		});
	}

	async function auditRetention(ctx: ExtensionContext) {
		const result = await runRetentionAudit();
		const needsBackup = result.candidates.filter(
			(candidate) => candidate.backupState === "needs-drive-backup",
		).length;
		const missingSummary = result.candidates.filter(
			(candidate) => candidate.backupState === "compressed-summary-missing",
		).length;
		ctx.ui.notify(
			`Retention audit · ${needsBackup} need Drive backup · ${missingSummary} lack a compressed summary · 0 deleted`,
			"info",
		);
	}

	async function requestRetentionCleanup(ctx: ExtensionContext) {
		const state = await journal.maintenanceState();
		const driveFolderId =
			process.env.AGENT_JOURNAL_DRIVE_FOLDER_ID ??
			state.driveArchiveFolderId ??
			"";
		if (!driveFolderId) {
			throw new Error(
				"Cleanup needs AGENT_JOURNAL_DRIVE_FOLDER_ID or driveArchiveFolderId in maintenance state",
			);
		}
		ctx.ui.setStatus("agent-journal", "retention-cleanup:queued");
		await pi.sendUserMessage(
			[
				"Run the user-approved Drive retention cleanup now.",
				"1. Call journal_retention_candidates with limit 5 and no cursor.",
				"2. For each needs-drive-backup candidate, call journal_claim_drive_backup. Continue only when status is claimed; skip in-progress and do not create a Drive file.",
				"3. For each claimed candidate, use only backupName and backupContent. Never read or upload sessionPath.",
				`4. Search google-workspace folder ${driveFolderId} for the exact backupName. Reuse an exact existing file; otherwise create one text/markdown Drive file in that folder with backupContent.`,
				"5. Read that Drive file back with get_file_content using snake_case file_id.",
				"6. Call journal_confirm_drive_backup with the claimToken, candidate sessionPath, notePath, Drive file ID, and exact read-back content.",
				"7. If nextCursor is present, call journal_retention_candidates again with that cursor and repeat. Keep and report every compressed-summary-missing, in-progress, or verification-failed candidate.",
				"8. After every batch is handled, call journal_evict_cold_memory once so verified notes beyond the 90-day local window move immediately to Drive-only storage.",
				"Report counts and Drive file IDs; do not quote backup content.",
			].join("\n"),
			{ deliverAs: "followUp" },
		);
	}

	async function requestIntegrity(ctx: ExtensionContext) {
		ctx.ui.setStatus("agent-journal", "drive-integrity:queued");
		await pi.sendUserMessage(driveIntegrityMessage(), {
			deliverAs: "followUp",
		});
	}

	async function auditReceipts(ctx: ExtensionContext) {
		const configuredRoots = roots();
		const result = await auditRetentionReceipts(
			path.join(configuredRoots.stateRoot, "retention-receipts"),
		);
		ctx.ui.notify(
			`Retention receipts · ${result.issueCount} issues · ${result.corruptCount} corrupt · ${result.invalidCount} invalid · ${result.duplicateCount} duplicate groups`,
			result.issueCount > 0 ? "warning" : "info",
		);
	}

	async function memoryStatus(ctx: ExtensionContext) {
		const state = await journal.maintenanceState();
		ctx.ui.notify(
			[
				`Checkpoint: ${lastCheckpointAt ? new Date(lastCheckpointAt).toLocaleString() : "not saved this session"}${durableWorkPending ? " · durable work pending" : ""}`,
				`Daily review: ${state.lastDistillationCompletedDate ?? "not completed"}`,
				`Cleanup audit: ${state.lastCleanupAuditAt ?? "not run"} · ${state.lastCleanupCandidateCount ?? 0} candidates`,
				`Drive integrity: ${state.lastDriveIntegrityAt ?? "not verified"}`,
			].join("\n"),
			"info",
		);
	}

	async function runMemoryAction(action: string, value: string, ctx: ExtensionContext) {
		if (action === "status") await memoryStatus(ctx);
		else if (action === "checkpoint") await requestCheckpoint(ctx);
		else if (action === "distill") await requestDistillation(value, ctx);
		else if (action === "audit") await auditRetention(ctx);
		else if (action === "cleanup") await requestRetentionCleanup(ctx);
		else if (action === "integrity") await requestIntegrity(ctx);
		else if (action === "receipts") await auditReceipts(ctx);
		else throw new Error("Usage: /memory [status|checkpoint|distill|audit|cleanup|integrity|receipts]");
	}

	pi.registerCommand("checkpoint", {
		description: "Save a compressed durable session summary",
		handler: async (_args, ctx) => {
			try {
				await requestCheckpoint(ctx);
			} catch (error) {
				ctx.ui.notify(`Checkpoint request failed: ${String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("distill", {
		description: "Review compressed sessions and choose durable memories to promote",
		handler: async (args, ctx) => {
			try {
				await requestDistillation(args, ctx);
			} catch (error) {
				ctx.ui.notify(`Daily memory review failed: ${String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("memory", {
		description: "Inspect memory, checkpoint, distill, and manage retention",
		handler: async (args, ctx) => {
			try {
				const input = args.trim();
				if (input) {
					const [action, ...rest] = input.split(/\s+/);
					await runMemoryAction(action, rest.join(" "), ctx);
					return;
				}
				const choices = [
					["Status", "status"],
					["Checkpoint this session", "checkpoint"],
					["Run daily memory review", "distill"],
					["Audit retention readiness", "audit"],
					["Run verified Drive cleanup", "cleanup"],
					["Verify a Drive archive sample", "integrity"],
					["Audit retention receipts", "receipts"],
				];
				const selected = await ctx.ui.select(
					"Memory · choose an action",
					choices.map(([label]) => label),
				);
				if (!selected) return;
				const action = choices.find(([label]) => label === selected)?.[1];
				if (action) await runMemoryAction(action, "", ctx);
			} catch (error) {
				ctx.ui.notify(`Memory: ${String(error)}`, "error");
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const checkpointTurn = classifyCheckpointTurn(
			event.prompt,
			autoCheckpointPending,
		);
		const { automaticCheckpoint, checkpointRun } = checkpointTurn;
		const distillationRun = isDistillationPrompt(event.prompt);
		const maintenanceRun = isDriveIntegrityPrompt(event.prompt);
		memoryOperation =
			checkpointRun ? "checkpoint" :
			distillationRun ? "memory-review" :
			maintenanceRun ? "drive-integrity" :
			event.prompt.includes("Run the user-approved Drive retention cleanup now.")
				? "retention-cleanup"
				: "";
		if (memoryOperation && ctx.hasUI) {
			ctx.ui.setStatus("agent-journal", `${memoryOperation}:running`);
		}
		currentRun = createRunState(event.prompt, {
			checkpointRun,
			distillationRun,
			maintenanceRun,
			automaticCheckpoint,
		});
		if (checkpointTurn.consumePendingAutomaticCheckpoint) {
			autoCheckpointPending = false;
		}
		if (!checkpointRun && !distillationRun && ctx.hasUI) {
			try {
				await refreshDistillationDue();
			} catch {
				// A reminder must never block the user's task.
			}
		}

		let recalled = "";
		let recallResult: { items: unknown[] } = { items: [] };
		if (shouldProactivelyRecall(event.prompt)) {
			try {
				const repository = await repositoryForCwd(ctx.cwd);
					const result = await journal.recall(event.prompt, {
						automatic: true,
						repository: repository || undefined,
						limit: automaticRecallDefaults.limit,
						tokenBudget: automaticRecallDefaults.tokenBudget,
					});
					recallResult = result;
					recalled = formatRecallContext(result);
					pi.appendEntry(
						"agent-journal-recall-metrics",
						recallUsageMetric(result, { repository }),
					);
			} catch {
				// Recall is an optimization. A missing/corrupt index must never block the task.
			}
		}
		const driveFallback = shouldSearchDriveWorkspace(
			event.prompt,
			recallResult,
		)
			? driveWorkspaceFallback(event.prompt)
			: "";

		return {
			systemPrompt:
				event.systemPrompt +
				`

SESSION JOURNAL
Automatic journaling saves the first durable change once per session. Later work remains pending until context compression or an explicit checkpoint; there is no timer-based checkpoint. Do not call journal_checkpoint on your own, including after completed work or milestones. Call it only when the user explicitly requests a checkpoint or an agent-journal automatic checkpoint message requires it. Never call it for greetings, clarification, review-only work, trivial lookups, or mechanical fan-out. Never quote or reproduce user prompts, assistant responses, tool arguments, or transcript excerpts. The journal and its search index may contain only the compressed representation.
${recalled ? `\n${recalled}\n` : ""}
${driveFallback ? `\n${driveFallback}\n` : ""}`,
		};
	});

	pi.on("tool_execution_start", async (event) => {
		if (currentRun) recordToolStart(currentRun, event);
	});

	pi.on("tool_execution_end", async (event) => {
		if (currentRun) recordToolCompletion(currentRun, event);
	});

	pi.on("agent_end", async (event, ctx) => {
		const run = currentRun;
		currentRun = undefined;
		if (!run) return;
		if (memoryOperation && ctx.hasUI) {
			ctx.ui.setStatus(
				"agent-journal",
				`${memoryOperation}:${assistantRunFailed(event.messages) ? "failed" : "completed"}`,
			);
			memoryOperation = "";
		}

		if (run.checkpointSaved) markCheckpointSaved();

		if (run.distillationRun) {
			await queueIntegrity(ctx);
			return;
		}
		if (run.maintenanceRun) {
			await queueDistillation(ctx);
			return;
		}
		if (run.checkpointRun) {
			if (!run.checkpointSaved) {
				if (run.automaticCheckpoint && autoCheckpointRetries < 1) {
					autoCheckpointRetries += 1;
					queueAutomaticCheckpoint(
						"agent-journal-auto-checkpoint-retry",
						autoCheckpointRetryMessage(),
					);
					return;
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Automatic journal checkpoint was not saved; run /checkpoint to retry.",
						"warning",
					);
				}
			}
			resumeDeferredCompaction(ctx);
			await queueDistillation(ctx);
			await queueIntegrity(ctx);
			return;
		}

		const durableRun = isDurableCheckpointRun(run, event.messages);
		if (durableRun) markDurableWorkPending();
		if (
			!shouldQueueAutoCheckpoint(run, event.messages, {
				lastCheckpointAt,
			})
		) {
			await queueDistillation(ctx);
			await queueIntegrity(ctx);
			return;
		}

		autoCheckpointRetries = 0;
		queueAutomaticCheckpoint();
	});

	pi.on("session_start", async (_event, ctx) => {
		const cadence = checkpointCadenceFromEntries(ctx.sessionManager.getBranch());
		lastCheckpointAt = cadence.lastCheckpointAt;
		durableWorkPending = cadence.durableWorkPending;
		compactionCheckpointAttempted = false;
		deferredCompaction = undefined;
		try {
			await refreshDistillationDue();
			const state = await journal.maintenanceState();
			if (shouldRunCleanupAudit(new Date(), state)) {
				const audit = await runRetentionAudit();
				const eviction = await runColdTierEviction();
				integrityDue = true;
				if (audit.candidateCount > 0 && ctx.hasUI) {
					const needsBackup = audit.candidates.filter(
						(candidate) => candidate.backupState === "needs-drive-backup",
					).length;
					ctx.ui.notify(
						`${audit.candidateCount} Pi sessions are older than 30 days; ${needsBackup} can be processed with /retention-cleanup.`,
						"info",
					);
				}
				if (eviction.evictedCount > 0 && ctx.hasUI) {
					ctx.ui.notify(
						`${eviction.evictedCount} verified compressed notes moved to Drive-only cold storage.`,
						"info",
					);
				}
			}
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Journal maintenance audit failed: ${String(error)}`, "warning");
			}
		}
	});

	pi.on("session_before_compact", async (event) => {
		if (
			!shouldCheckpointBeforeCompaction({
				durableWorkPending,
				checkpointInProgress: currentRun?.checkpointRun === true,
				attempted: compactionCheckpointAttempted,
			})
		) {
			return;
		}
		compactionCheckpointAttempted = true;
		deferredCompaction = {
			customInstructions: event.customInstructions,
		};
		queueAutomaticCheckpoint(
			"agent-journal-pre-compaction-checkpoint",
			autoCheckpointMessage(),
		);
		return { cancel: true };
	});

	pi.on("session_compact", async () => {
		compactionCheckpointAttempted = false;
		deferredCompaction = undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentRun = undefined;
		memoryOperation = "";
		autoCheckpointPending = false;
		autoCheckpointRetries = 0;
		distillationDue = undefined;
		integrityDue = false;
		lastCheckpointAt = undefined;
		durableWorkPending = false;
		compactionCheckpointAttempted = false;
		deferredCompaction = undefined;
		ctx.ui.setStatus("agent-journal", undefined);
	});
}
