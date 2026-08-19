import { homedir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	acknowledgeInbox,
	buildInboxChoices,
	clearCompletedInbox,
	clearStaleInbox,
	inboxLabel,
	selectInboxItem,
	upsertInboxItem,
} from "../src/action-inbox.mjs";
import {
	mutateInboxFile,
	readInboxFile,
} from "../src/action-inbox-store.mjs";

const State = Type.Union([
	Type.Literal("approval"),
	Type.Literal("blocked"),
	Type.Literal("completed"),
	Type.Literal("failed"),
]);
const Source = Type.Union([
	Type.Literal("session"),
	Type.Literal("subagent"),
	Type.Literal("automation"),
	Type.Literal("distillation"),
	Type.Literal("mcp"),
]);
const Code = Type.Union([
	Type.Literal("agent-complete"),
	Type.Literal("automation-complete"),
	Type.Literal("automation-failed"),
	Type.Literal("authentication"),
	Type.Literal("daily-distillation"),
	Type.Literal("external-approval"),
	Type.Literal("health-audit"),
	Type.Literal("subagent-complete"),
	Type.Literal("subagent-failed"),
	Type.Literal("tool-error"),
]);

export default function actionInboxExtension(pi: ExtensionAPI) {
	const inboxPath =
		process.env.PI_ACTION_INBOX_PATH ??
		path.join(homedir(), ".agents", "runtime", "pi-pet", "inbox.json");
	let sessionId = "";
	let workspaceId = "";
	let mutation = Promise.resolve();

	async function readItems(): Promise<any[]> {
		return readInboxFile(inboxPath);
	}

	async function update(updater: (items: any[]) => any[]) {
		const operation = mutation.then(() => mutateInboxFile(inboxPath, updater));
		mutation = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async function upsert(value: Record<string, unknown>) {
		return update((items) => upsertInboxItem(items, value));
	}

	async function acknowledge(id: string) {
		return update((items) => acknowledgeInbox(items, id));
	}

	async function clearCompleted() {
		return update(clearCompletedInbox);
	}

	async function clearStale() {
		return update((items) => clearStaleInbox(items));
	}

	function currentItem(state: string, code: string) {
		return {
			id: `session:${sessionId}`,
			state,
			source: "session",
			code,
			sessionId,
			workspaceId,
			updatedAt: new Date().toISOString(),
		};
	}

	pi.registerTool({
		name: "action_inbox",
		label: "Pi action inbox",
		description:
			"List, acknowledge, or publish fixed-metadata action states for Pi sessions, subagents, automations, distillation, and MCP. Never stores prompts, task text, or transcripts.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("acknowledge"),
				Type.Literal("upsert"),
			]),
			id: Type.Optional(Type.String({ maxLength: 160 })),
			state: Type.Optional(State),
			source: Type.Optional(Source),
			code: Type.Optional(Code),
			sessionId: Type.Optional(Type.String({ maxLength: 160 })),
			workspaceId: Type.Optional(Type.String({ maxLength: 160 })),
			automationId: Type.Optional(Type.String({ maxLength: 160 })),
		}),
		async execute(_toolCallId, params) {
			let items;
			if (params.action === "acknowledge") {
				if (!params.id) throw new Error("acknowledge requires id or all");
				items = await acknowledge(params.id);
			} else if (params.action === "upsert") {
				if (!params.id || !params.state || !params.source || !params.code) {
					throw new Error("upsert requires id, state, source, and code");
				}
				items = await upsert({ ...params, updatedAt: new Date().toISOString() });
			} else {
				items = await readItems();
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ items, next: selectInboxItem(items) }, null, 2) }],
				details: { items, next: selectInboxItem(items) },
			};
		},
	});

	pi.registerCommand("inbox", {
		description: "Review, focus, acknowledge, or clear persistent action items",
		handler: async (args, ctx) => {
			try {
				const [verb, id] = args.trim().split(/\s+/, 2);
				if (verb === "ack" || verb === "acknowledge") {
					const items = await acknowledge(id || "all");
					ctx.ui.notify(`${items.length} action items remain.`, "info");
					return;
				}
				if (verb === "clear" && id === "completed") {
					const items = await clearCompleted();
					ctx.ui.notify(`${items.length} action items remain.`, "info");
					return;
				}
				if (verb === "clear" && id === "stale") {
					const items = await clearStale();
					ctx.ui.notify(`${items.length} action items remain.`, "info");
					return;
				}
				const items = await readItems();
				if (!items.length) {
					ctx.ui.notify("Action inbox is empty.", "info");
					return;
				}
				if (verb === "list") {
					ctx.ui.notify(buildInboxChoices(items).map((item) => item.label).join("\n"), "info");
					return;
				}
				const choices = [
					...buildInboxChoices(items),
					{ id: "__clear-completed", label: "Clear completed items" },
					{ id: "__clear-stale", label: "Clear completed items older than 7 days" },
				];
				const selected = await ctx.ui.select(
					`Action inbox · ${items.length} items`,
					choices.map((item) => item.label),
				);
				if (!selected) return;
				const choice = choices.find((item) => item.label === selected);
				if (choice?.id === "__clear-completed") {
					await clearCompleted();
					return;
				}
				if (choice?.id === "__clear-stale") {
					await clearStale();
					return;
				}
				const item = items.find((candidate) => candidate.id === choice?.id);
				if (!item) return;
				const action = await ctx.ui.select(
					inboxLabel(item),
					[item.workspaceId ? "Focus in cmux" : undefined, "Acknowledge"].filter(Boolean),
				);
				if (!action) return;
				if (action === "Acknowledge") {
					await acknowledge(item.id);
				} else {
					const result = await pi.exec("cmux", [
						"select-workspace",
						"--workspace",
						item.workspaceId,
					]);
					if (result.code !== 0) {
						throw new Error(result.stderr.trim() || "cmux could not focus the workspace");
					}
					await pi.exec("open", ["-a", "cmux"]);
				}
			} catch (error) {
				ctx.ui.notify(`Action inbox failed: ${String(error)}`, "error");
			}
		},
	});

	pi.events.on("action-inbox:upsert", (value) => {
		void upsert(value as Record<string, unknown>);
	});
	pi.events.on("action-inbox:acknowledge", (value) => {
		const id = (value as { id?: string })?.id;
		if (id) void acknowledge(id);
	});
	pi.events.on("subagent:async-complete", (value) => {
		const payload = value as {
			runId?: string;
			id?: string;
			status?: string;
		};
		const runId = payload.runId ?? payload.id;
		if (!runId) return;
		const failed = payload.status === "failed" || payload.status === "error";
		void upsert({
			id: `subagent:${runId}`,
			state: failed ? "failed" : "completed",
			source: "subagent",
			code: failed ? "subagent-failed" : "subagent-complete",
			sessionId,
			workspaceId,
			updatedAt: new Date().toISOString(),
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		workspaceId = process.env.CMUX_WORKSPACE_ID ?? "";
	});

	pi.on("agent_start", async () => {
		if (sessionId) await acknowledge(`session:${sessionId}`);
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "ask_user_question" && sessionId) {
			await upsert(currentItem("approval", "external-approval"));
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!sessionId) return;
		if (event.isError) {
			await upsert(currentItem("failed", "tool-error"));
		} else if (event.toolName === "ask_user_question") {
			await acknowledge(`session:${sessionId}`);
		}
	});

}
