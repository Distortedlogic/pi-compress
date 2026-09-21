import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { snapshotSession } from "../src/context.ts";
import { planCrop, renderReconstruction } from "../src/crop.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	QUEUED_TASK_TAIL,
} from "../src/protocol.ts";
import {
	applyCompression,
	applyPreparedRangeCompression,
	type PreparedRangeCompression,
	prepareCompression,
	prepareRangeCompression,
	type RangeCompressionTarget,
	renderRangeTail,
	reviewRangeCompression,
} from "../src/range-compression.ts";
import { applyRewrite, candidateByEntryId, prepareRewrite, rangeCandidates, sourceSha8 } from "../src/rewrite.ts";

const HASH_A = "a".repeat(64);

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

class MemorySession {
	readonly manager = SessionManager.inMemory("/test/project");
	private now = 1;

	user(text: string): string {
		return this.manager.appendMessage({ role: "user", content: text, timestamp: this.now++ });
	}

	assistant(text: string, toolCalls: ToolCall[] = []): string {
		return this.manager.appendMessage({
			role: "assistant",
			content: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls],
			api: "openai-completions",
			provider: "openai",
			model: "test-model",
			usage: usage(),
			stopReason: toolCalls.length ? "toolUse" : "stop",
			timestamp: this.now++,
		});
	}

	toolResult(name: string, text: string, toolCallId: string): string {
		return this.manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: name,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: this.now++,
		});
	}

	toolUse(name: string, args: Record<string, unknown>, text: string): { call: string; result: string } {
		const id = `call-${this.now}`;
		const call = this.assistant("", [{ type: "toolCall", id, name, arguments: args }]);
		return { call, result: this.toolResult(name, text, id) };
	}

	decision(text = "decision"): string {
		return this.manager.appendCustomMessageEntry(CTREE_DECISION, text, true, {
			v: 1,
			forkEntryId: "fork",
			branchName: "decision",
		});
	}
}

function cropScenario() {
	const session = new MemorySession();
	session.user("audit tabs");
	session.assistant("anchor");
	const old = session.toolUse("chrome.snapshot", { url: "tab-audit" }, "A".repeat(80_000));
	session.assistant("analysis");
	session.toolUse("chrome.snapshot", { url: "after" }, "B".repeat(400));
	session.assistant("done");
	return { session, old, snapshot: snapshotSession(session.manager) };
}

function extensionContext(
	manager: SessionManager,
	complete?: (...args: unknown[]) => Promise<AssistantMessage>,
): ExtensionCommandContext {
	const model = {
		provider: "openai",
		id: "test-model",
		name: "Test model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	};
	return {
		sessionManager: manager,
		model,
		modelRegistry: {
			getAll: () => [model],
			find: () => model,
			complete: complete ?? (async () => assistantResponse("summary")),
		},
		ui: {
			editor: async (_title: string, prefill?: string) => prefill,
			notify: () => {},
		},
		cwd: "/test/project",
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
		compact: () => {},
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: "/test/project" }),
		waitForIdle: async () => {},
		navigateTree: async (entryId: string) => {
			manager.branch(entryId);
			return { cancelled: false };
		},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	} as unknown as ExtensionCommandContext;
}

function assistantResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function mutationApi(manager: SessionManager): ExtensionAPI {
	const api = {
		sendMessage: (message) => {
			manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
		appendEntry: (customType, data) => {
			manager.appendCustomEntry(customType, data);
		},
	} satisfies Partial<ExtensionAPI>;
	return api as unknown as ExtensionAPI;
}

describe("crop reconstruction", () => {
	it("stubs selected results, keeps continuation order, and preserves originals", () => {
		const { old, snapshot } = cropScenario();
		const plan = planCrop(snapshot, [old.result]);
		const rendered = renderReconstruction(plan);
		assert.equal(plan.startEntryId, old.call);
		assert.match(plan.stubs[0]?.sha8 ?? "", /^[a-f0-9]{8}$/);
		assert.ok(rendered.includes("[cropped: chrome.snapshot tab-audit"));
		assert.ok(rendered.includes("analysis"));
		assert.ok(!rendered.includes("A".repeat(200)));
		assert.ok(snapshot.entries.some((entry) => entry.id === old.result));
	});
});

describe("shared range safety", () => {
	it("keeps an assistant tool-call batch and all contiguous results atomic", () => {
		const session = new MemorySession();
		session.user("root");
		session.assistant("anchor");
		const call = session.assistant("", [
			{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
		]);
		const firstResult = session.toolResult("read", "a", "call-a");
		const secondResult = session.toolResult("read", "b", "call-b");
		const snapshot = snapshotSession(session.manager);
		const groups = candidateByEntryId(rangeCandidates(snapshot));
		assert.deepEqual(groups.get(call)?.entryIds, [call, firstResult, secondResult]);
		assert.equal(groups.get(secondResult)?.startEntryId, call);
		assert.throws(() => prepareRewrite(snapshot, firstResult, secondResult), /split a required tool-call group/);
	});

	it("protects session metadata, structural records, and incomplete message groups", () => {
		const session = new MemorySession();
		const root = session.user("root");
		const anchor = session.assistant("anchor");
		const metadata = session.manager.appendCustomEntry("metadata");
		const decision = session.decision();
		const orphan = session.toolResult("read", "orphan", "missing");
		const incompleteToolGroup = session.assistant("", [
			{ type: "toolCall", id: "unanswered", name: "read", arguments: { path: "x" } },
		]);
		const pending = session.user("pending");
		const groups = candidateByEntryId(rangeCandidates(snapshotSession(session.manager)));

		assert.equal(groups.get(root)?.protectReason, "no anchor before this message group");
		assert.equal(groups.get(metadata)?.protectReason, "context-inert session metadata");
		assert.equal(groups.get(decision)?.protectReason, "decision record");
		assert.equal(groups.get(orphan)?.protectReason, "tool result without its assistant tool call");
		assert.equal(groups.get(incompleteToolGroup)?.protectReason, "incomplete assistant tool-call group");
		assert.equal(groups.get(pending)?.protectReason, "incomplete current user turn");

		const structural = new MemorySession();
		structural.user("root");
		const structuralAnchor = structural.assistant("anchor");
		const summary = structural.manager.branchWithSummary(structuralAnchor, "summary");
		const structuralGroups = candidateByEntryId(rangeCandidates(snapshotSession(structural.manager)));
		assert.equal(structuralGroups.get(summary)?.protectReason, "structural context entry");
		assert.throws(() => prepareRewrite(snapshotSession(session.manager), anchor, pending), /protected/);
	});

	it("keeps complete selected source, a stable hash, and unchanged continuation", () => {
		const { old, snapshot } = cropScenario();
		const plan = prepareRewrite(snapshot, old.call, old.result);
		assert.ok(plan.source.includes("A".repeat(20_000)));
		assert.ok(!plan.source.includes("(truncated)"));
		assert.match(plan.sourceSha256, /^[a-f0-9]{64}$/);
		assert.equal(sourceSha8(plan), plan.sourceSha256.slice(0, 8));
		assert.equal(prepareRewrite(snapshot, old.call, old.result).sourceSha256, plan.sourceSha256);
		const rendered = renderRangeTail(plan, "approved summary");
		assert.ok(rendered.includes("approved summary"));
		assert.ok(rendered.includes("unchanged continuation"));
		assert.ok(!rendered.includes("A".repeat(200)));
	});
});

describe("shared rewrite apply", () => {
	function validWorld() {
		const scenario = cropScenario();
		const plan = prepareRewrite(scenario.snapshot, scenario.old.call, scenario.old.result);
		const entriesBefore = scenario.session.manager.getEntries().length;
		return {
			...scenario,
			plan,
			entriesBefore,
			ctx: extensionContext(scenario.session.manager),
			pi: mutationApi(scenario.session.manager),
		};
	}

	it("rejects stale source before navigation or writes", async () => {
		const world = validWorld();
		const selected = world.session.manager.getEntry(world.plan.endEntryId);
		if (!selected || selected.type !== "message" || selected.message.role !== "toolResult") {
			throw new Error("invalid rewrite fixture");
		}
		selected.message.content = [{ type: "text", text: "changed source" }];
		await assert.rejects(
			applyRewrite(world.pi, world.ctx, world.plan, {
				messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
				marker: { customType: CTREE_CROP, data: {} },
			}),
			/source changed/,
		);
		assert.equal(world.session.manager.getEntries().length, world.entriesBefore);
	});

	it("navigates without a summary, then appends replacements before the marker", async () => {
		const world = validWorld();
		const result = await applyRewrite(world.pi, world.ctx, world.plan, {
			messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
			marker: { customType: CTREE_CROP, data: { sourceLeafId: world.plan.sourceLeafId } },
		});
		assert.equal(result, true);
		const branch = world.session.manager.getBranch();
		assert.deepEqual(
			branch.slice(-2).map((entry) => ("customType" in entry ? entry.customType : entry.type)),
			[CTREE_CROP_TAIL, CTREE_CROP],
		);
	});
});

describe("direct range compression API", () => {
	function directWorld(complete?: (...args: unknown[]) => Promise<AssistantMessage>) {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("anchor");
		const selected = session.assistant("selected");
		return {
			session,
			anchor,
			selected,
			ctx: extensionContext(session.manager, complete),
			pi: mutationApi(session.manager),
		};
	}

	it("prepares, reviews, and applies one readonly range value", async () => {
		const world = directWorld();
		const target: RangeCompressionTarget = {
			operationId: "direct-operation",
			startEntryId: world.selected,
			endEntryId: world.selected,
		};
		const prepared: PreparedRangeCompression = await prepareRangeCompression(world.ctx, target);
		assert.deepEqual(prepared.plan.selectedEntryIds, [world.selected]);
		const reviewed = await reviewRangeCompression(world.ctx, prepared);
		assert.ok(reviewed);
		const details = await applyPreparedRangeCompression(world.pi, world.ctx, reviewed);
		assert.partialDeepStrictEqual(details, { operationId: "direct-operation", anchorId: world.anchor });
		const types = world.session.manager
			.getBranch()
			.filter((entry) => "customType" in entry)
			.map((entry) => (entry as { customType: string }).customType);
		assert.deepEqual(types.slice(-2), [CTREE_RANGE_TAIL, CTREE_RANGE_COMPACT]);
	});

	it("drafts with the current model", async () => {
		let draftedWith: unknown;
		const world = directWorld(async (...args: unknown[]) => {
			draftedWith = args[0];
			return assistantResponse("summary");
		});
		await prepareRangeCompression(world.ctx, {
			operationId: "current-model",
			startEntryId: world.selected,
			endEntryId: world.selected,
		});
		assert.equal(draftedWith, world.ctx.model);
	});

	it("rejects an oversized range before drafting or writing", async () => {
		let draftCalls = 0;
		const world = directWorld(async () => {
			draftCalls += 1;
			return assistantResponse("summary");
		});
		const model = world.ctx.model;
		if (!model) throw new Error("missing test model");
		Object.assign(model, { contextWindow: 16, maxTokens: 4 });
		const entriesBefore = world.session.manager.getEntries().length;
		await assert.rejects(
			prepareRangeCompression(world.ctx, {
				operationId: "oversized-range",
				startEntryId: world.selected,
				endEntryId: world.selected,
			}),
			/selected range is too large/,
		);
		assert.equal(draftCalls, 0);
		assert.equal(world.session.manager.getEntries().length, entriesBefore);
	});
});

describe("batch compression", () => {
	function batchSession() {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("batch anchor");
		const task = session.user("Run the batch");
		const settled = session.assistant("batch completed");
		return { session, anchor, task, settled };
	}

	const batch: BatchSnapshot = {
		planId: HASH_A,
		batchId: HASH_A,
		structuralRevision: HASH_A,
		fileRevision: HASH_A,
		bitmap: [false, true],
	};

	it("reuses range safety and appends the task, summary, then marker", async () => {
		const world = batchSession();
		const ctx = extensionContext(world.session.manager);
		const plan = prepareCompression(ctx, world.anchor, world.settled, "operation");
		assert.equal(plan.taskMessageEntryId, world.task);
		assert.ok(plan.source.includes("batch completed"));
		await applyCompression(mutationApi(world.session.manager), ctx, "run", batch, plan, "summary");
		const types = world.session.manager
			.getBranch()
			.filter((entry) => "customType" in entry)
			.map((entry) => (entry as { customType: string }).customType);
		assert.deepEqual(types.slice(-3), [QUEUED_TASK_TAIL, COMPRESSION_TAIL, COMPRESSION_ENTRY]);
	});
});
