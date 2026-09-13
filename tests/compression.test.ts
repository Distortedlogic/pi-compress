import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
	createEventBus,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { applyCompression, prepareCompression, registerBatchCompression } from "../src/batch.ts";
import {
	autoSelect,
	contextTurns,
	cropCandidates,
	planCrop,
	planRemoveTurns,
	rangeCompressHandler,
	renderReconstruction,
} from "../src/compression.ts";
import { aggregateConsumers } from "../src/core/consumers.ts";
import { band, estimateEntryTokens, fmtTokens } from "../src/core/estimate.ts";
import {
	applyRewrite,
	candidateByEntryId,
	prepareRewrite,
	rangeCandidates,
	resolveRangeEndpoint,
	sourceSha8,
} from "../src/core/range-rewrite.ts";
import { serializeEntries } from "../src/core/serialize.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_REQUEST,
	COMPRESSION_RESULT,
	COMPRESSION_TAIL,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CompressionRequest,
	type CompressionResult,
	QUEUED_TASK_TAIL,
} from "../src/protocol.ts";
import {
	type PreparedRangeCompression,
	type RangeCompressionInput,
	type RangeCompressionOutcome,
	type RangeCompressionTarget,
	applyPreparedRangeCompression,
	compressRange,
	prepareRangeCompression,
	renderRangeTail,
	reviewRangeCompression,
} from "../src/range-compression.ts";
import { snapshotSession } from "../src/session.ts";

initTheme("dark");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

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
	const latest = session.toolUse("chrome.snapshot", { url: "after" }, "B".repeat(400));
	session.assistant("done");
	return { session, old, latest, snapshot: snapshotSession(session.manager) };
}

function extensionContext(
	manager: SessionManager,
	complete?: () => Promise<AssistantMessage>,
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

describe("estimation and consumers", () => {
	it.each([
		[0, "0"],
		[950, "950"],
		[19_400, "19.4k"],
		[200_000, "200k"],
	])("formats %i tokens as %s", (tokens, expected) => {
		expect(fmtTokens(tokens)).toBe(expected);
	});

	it.each([
		[4.9, "low"],
		[5, "healthy"],
		[15, "filling"],
		[40, "filling"],
		[40.1, "red"],
	])("maps %s percent to %s", (percent, expected) => {
		expect(band(percent)).toBe(expected);
	});

	it("counts image input and groups context by source", () => {
		const session = new MemorySession();
		session.manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "x", mimeType: "image/png" }],
			timestamp: 1,
		});
		const result = session.toolUse("read", { path: "large.txt" }, "x".repeat(8_000));
		const snapshot = snapshotSession(session.manager);
		expect(estimateEntryTokens(session.manager.getEntry(result.call)!)).toBeGreaterThan(0);
		const consumers = aggregateConsumers(snapshot.contextEntries);
		expect(consumers[0]?.key).toBe("read");
		expect(consumers.reduce((total, row) => total + row.share, 0)).toBeCloseTo(1);
	});
});

describe("crop and whole-turn planning", () => {
	it("protects the latest result and keeps matching tools or arguments during auto selection", () => {
		const { old, latest, snapshot } = cropScenario();
		const candidates = cropCandidates(snapshot);
		expect(candidates.find((candidate) => candidate.entryId === old.result)?.protected).toBe(false);
		expect(candidates.find((candidate) => candidate.entryId === latest.result)?.protected).toBe(true);
		expect(autoSelect(candidates, { minTokens: 1, olderThanTurns: 0 })).toContain(old.result);
		expect(autoSelect(candidates, { minTokens: 1, olderThanTurns: 0, keep: ["chrome.*"] })).not.toContain(old.result);
		expect(autoSelect(candidates, { minTokens: 1, olderThanTurns: 0, keep: ["tab-*"] })).not.toContain(old.result);
	});

	it("stubs selected results, keeps continuation order, and preserves originals", () => {
		const { old, snapshot } = cropScenario();
		const plan = planCrop(snapshot, [old.result]);
		const rendered = renderReconstruction(plan);
		expect(plan.startEntryId).toBe(old.call);
		expect(plan.stubs[0]?.sha8).toMatch(/^[a-f0-9]{8}$/);
		expect(rendered).toContain("[cropped: chrome.snapshot tab-audit");
		expect(rendered).toContain("analysis");
		expect(rendered).not.toContain("A".repeat(200));
		expect(snapshot.entries.find((entry) => entry.id === old.result)).toBeDefined();
	});

	it("removes complete non-current turns and keeps a recovery marker", () => {
		const session = new MemorySession();
		session.user("root");
		session.assistant("root answer");
		const removed = session.user("remove this question");
		session.toolUse("read", { path: "large" }, "x".repeat(20_000));
		session.assistant("remove this answer");
		session.user("keep this question");
		session.assistant("keep this answer");
		const snapshot = snapshotSession(session.manager);
		const turns = contextTurns(snapshot);
		expect(turns.map((turn) => turn.userId)).toContain(removed);
		const plan = planRemoveTurns(snapshot, [removed]);
		const rendered = renderReconstruction(plan);
		expect(plan.dropped[0]?.entryIds.length).toBe(4);
		expect(rendered).toContain("[dropped turn —");
		expect(rendered).not.toContain("remove this question");
		expect(rendered).toContain("keep this answer");
	});
});

describe("shared range safety", () => {
	it("keeps a tool call and all contiguous results in one atomic group", () => {
		const { old, snapshot } = cropScenario();
		const groups = candidateByEntryId(rangeCandidates(snapshot));
		expect(groups.get(old.result)?.entryIds).toEqual([old.call, old.result]);
		expect(() => prepareRewrite(snapshot, old.result, old.result)).toThrow(/split a required tool-call group/);
		expect(resolveRangeEndpoint(rangeCandidates(snapshot), old.result, "start")).toEqual({
			ok: true,
			entryId: old.call,
		});
	});

	it.each([
		[
			"root range",
			() => {
				const session = new MemorySession();
				const root = session.user("root");
				const leaf = session.assistant("leaf");
				return { snapshot: snapshotSession(session.manager), start: root, end: leaf };
			},
		],
		[
			"incomplete current turn",
			() => {
				const session = new MemorySession();
				session.user("root");
				session.assistant("anchor");
				const pending = session.user("pending");
				return { snapshot: snapshotSession(session.manager), start: pending, end: pending };
			},
		],
		[
			"decision record",
			() => {
				const session = new MemorySession();
				session.user("root");
				session.assistant("anchor");
				const decision = session.decision();
				session.assistant("leaf");
				return { snapshot: snapshotSession(session.manager), start: decision, end: decision };
			},
		],
		[
			"incomplete tool group",
			() => {
				const session = new MemorySession();
				session.user("root");
				session.assistant("anchor");
				const call = session.assistant("", [
					{ type: "toolCall", id: "missing", name: "read", arguments: { path: "x" } },
				]);
				return { snapshot: snapshotSession(session.manager), start: call, end: call };
			},
		],
		[
			"orphan result",
			() => {
				const session = new MemorySession();
				session.user("root");
				session.assistant("anchor");
				const result = session.toolResult("read", "orphan", "missing");
				session.assistant("leaf");
				return { snapshot: snapshotSession(session.manager), start: result, end: result };
			},
		],
	])("rejects %s", (_name, build) => {
		const value = build();
		expect(() => prepareRewrite(value.snapshot, value.start, value.end)).toThrow();
	});

	it("requires confirmation after the native two-pass range selection", async () => {
		const session = new MemorySession();
		session.user("root");
		session.assistant("anchor");
		session.assistant("selected leaf");
		const ctx = extensionContext(session.manager);
		let selections = 0;
		const ui = ctx.ui as unknown as {
			confirm: () => Promise<boolean>;
			custom: <T>(factory: (...args: any[]) => Component) => Promise<T>;
		};
		ui.confirm = async () => false;
		ui.custom = async <T>(factory: (...args: any[]) => Component): Promise<T> =>
			new Promise<T>((resolve) => {
				selections += 1;
				const component = factory({ terminal: { rows: 30 }, requestRender: () => {} }, {}, {}, resolve);
				component.handleInput?.("\r");
			});
		const before = session.manager.getEntries().length;
		await rangeCompressHandler(mutationApi(session.manager), ctx, "", { draft: async () => "summary" });
		expect(selections).toBe(2);
		expect(session.manager.getEntries()).toHaveLength(before);
	});

	it("keeps complete selected source, a stable hash, and unchanged continuation", () => {
		const { old, snapshot } = cropScenario();
		const plan = prepareRewrite(snapshot, old.call, old.result);
		expect(plan.source).toContain("A".repeat(20_000));
		expect(plan.source).not.toContain("(truncated)");
		expect(plan.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(sourceSha8(plan)).toBe(plan.sourceSha256.slice(0, 8));
		expect(prepareRewrite(snapshot, old.call, old.result).sourceSha256).toBe(plan.sourceSha256);
		const rendered = renderRangeTail(plan, "approved summary");
		expect(rendered).toContain("approved summary");
		expect(rendered).toContain("unchanged continuation");
		expect(rendered).not.toContain("A".repeat(200));
	});

	it("plans a long session within a bounded time", () => {
		const session = new MemorySession();
		session.user("root");
		session.assistant("anchor");
		let first = "";
		let last = "";
		for (let index = 0; index < 250; index++) {
			const pair = session.toolUse("read", { path: `${index}.txt` }, "data");
			first ||= pair.call;
			last = pair.result;
		}
		session.assistant("leaf");
		const start = performance.now();
		const plan = prepareRewrite(snapshotSession(session.manager), first, last);
		expect(plan.selectedEntryIds).toHaveLength(500);
		expect(performance.now() - start).toBeLessThan(2_000);
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

	it.each(["session", "leaf", "selected", "continuation", "hash"])(
		"rejects changed %s before navigation or writes",
		async (change) => {
			const world = validWorld();
			let plan = world.plan;
			if (change === "session") plan = { ...plan, sessionId: "other" };
			if (change === "leaf") world.session.user("changed leaf");
			if (change === "selected") plan = { ...plan, selectedEntryIds: [...plan.selectedEntryIds, "other"] };
			if (change === "continuation") {
				plan = { ...plan, continuationEntryIds: [...plan.continuationEntryIds, "other"] };
			}
			if (change === "hash") plan = { ...plan, sourceSha256: "0".repeat(64) };
			await expect(
				applyRewrite(world.pi, world.ctx, plan, {
					messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
					marker: { customType: CTREE_CROP, data: {} },
				}),
			).rejects.toThrow();
			expect(world.session.manager.getEntries().length).toBe(world.entriesBefore + (change === "leaf" ? 1 : 0));
		},
	);

	it("navigates without a summary, then appends replacements before the marker", async () => {
		const world = validWorld();
		const result = await applyRewrite(world.pi, world.ctx, world.plan, {
			messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
			marker: { customType: CTREE_CROP, data: { sourceLeafId: world.plan.sourceLeafId } },
		});
		expect(result.applied).toBe(true);
		const branch = world.session.manager.getBranch();
		expect(branch.slice(-2).map((entry) => ("customType" in entry ? entry.customType : entry.type))).toEqual([
			CTREE_CROP_TAIL,
			CTREE_CROP,
		]);
	});
});

describe("direct range compression API", () => {
	function directWorld() {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("anchor");
		const selected = session.assistant("selected");
		return { session, anchor, selected, ctx: extensionContext(session.manager), pi: mutationApi(session.manager) };
	}

	it("prepares, reviews, and applies one immutable range value", async () => {
		const world = directWorld();
		const target: RangeCompressionTarget = {
			operationId: "direct-operation",
			startEntryId: world.selected,
			endEntryId: world.selected,
		};
		const prepared: PreparedRangeCompression = await prepareRangeCompression(world.ctx, target);
		expect(Object.isFrozen(prepared)).toBe(true);
		expect(Object.isFrozen(prepared.plan)).toBe(true);
		expect(Object.isFrozen(prepared.plan.selectedEntryIds)).toBe(true);
		const reviewed = await reviewRangeCompression(world.ctx, prepared);
		expect(reviewed).toBeDefined();
		const details = await applyPreparedRangeCompression(world.pi, world.ctx, reviewed!);
		expect(details).toMatchObject({ operationId: "direct-operation", anchorId: world.anchor });
		const types = world.session.manager
			.getBranch()
			.filter((entry) => "customType" in entry)
			.map((entry) => (entry as { customType: string }).customType);
		expect(types.slice(-2)).toEqual([CTREE_RANGE_TAIL, CTREE_RANGE_COMPACT]);
	});

	it("orchestrates explicit no-review compression", async () => {
		const world = directWorld();
		const input: RangeCompressionInput = {
			operationId: "automated-operation",
			startEntryId: world.selected,
			endEntryId: world.selected,
			review: false,
		};
		const outcome: RangeCompressionOutcome = await compressRange(world.pi, world.ctx, input);
		expect(outcome.status).toBe("applied");
		if (outcome.status === "applied") expect(outcome.details.operationId).toBe("automated-operation");
	});
});

describe("batch compression", () => {
	function batchSession() {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("batch anchor");
		const task = session.user("[Queued task]\n\nRun the batch");
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

	it("reuses range safety and appends queued task, summary, then marker", async () => {
		const world = batchSession();
		const ctx = extensionContext(world.session.manager);
		const plan = prepareCompression(ctx, world.anchor, world.settled, "operation");
		expect(plan.taskMessageEntryId).toBe(world.task);
		expect(plan.source).toContain("batch completed");
		await applyCompression(mutationApi(world.session.manager), ctx, "run", batch, plan, "summary");
		const types = world.session.manager
			.getBranch()
			.filter((entry) => "customType" in entry)
			.map((entry) => (entry as { customType: string }).customType);
		expect(types.slice(-3)).toEqual([QUEUED_TASK_TAIL, COMPRESSION_TAIL, COMPRESSION_ENTRY]);
	});

	function serviceWorld(complete?: () => Promise<AssistantMessage>) {
		const world = batchSession();
		const events = createEventBus();
		const shutdownHandlers: Array<(event: unknown, ctx: ExtensionCommandContext) => void> = [];
		const pi = Object.assign(mutationApi(world.session.manager), {
			events,
			on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void) => {
				if (name === "session_shutdown") shutdownHandlers.push(handler);
			},
		}) as unknown as ExtensionAPI;
		const ctx = extensionContext(world.session.manager, complete);
		registerBatchCompression(pi);
		const request = (value: CompressionRequest): Promise<CompressionResult> =>
			new Promise((resolve) => {
				const unsubscribe = events.on(COMPRESSION_RESULT, (result) => {
					const parsed = result as CompressionResult;
					if (parsed.requestId !== value.requestId) return;
					unsubscribe();
					resolve(parsed);
				});
				events.emit(COMPRESSION_REQUEST, { request: value, context: ctx });
			});
		const make = (
			action: CompressionRequest["action"],
			overrides: Partial<CompressionRequest> = {},
		): CompressionRequest => ({
			v: 1,
			requestId: `${action}-${Math.random()}`,
			sessionId: world.session.manager.getSessionId(),
			operationId: "operation",
			runId: "run",
			action,
			batch,
			anchorEntryId: world.anchor,
			lastSettledEntryId: world.settled,
			review: false,
			...overrides,
		});
		return { ...world, ctx, request, make, shutdownHandlers };
	}

	it("preserves prepare, status, conflict, apply, replay, cancel, missing, and failure results", async () => {
		const world = serviceWorld();
		expect((await world.request(world.make("status"))).status).toBe("missing");
		expect((await world.request(world.make("prepare"))).status).toBe("prepared");
		expect((await world.request(world.make("status"))).status).toBe("prepared");
		const conflict = await world.request(world.make("prepare", { batch: { ...batch, batchId: HASH_B } }));
		expect(conflict).toMatchObject({ status: "failed", code: "operation_conflict" });
		const applied = await world.request(world.make("apply"));
		expect(applied.status).toBe("applied");
		expect((await world.request(world.make("apply"))).status).toBe("applied");

		const cancelled = serviceWorld();
		expect((await cancelled.request(cancelled.make("cancel"))).status).toBe("cancelled");
		expect((await cancelled.request(cancelled.make("status"))).status).toBe("cancelled");
		const missing = serviceWorld();
		expect(await missing.request(missing.make("apply"))).toMatchObject({ status: "failed", code: "not_prepared" });
		const invalid = serviceWorld();
		expect(await invalid.request(invalid.make("prepare", { anchorEntryId: undefined }))).toMatchObject({
			status: "failed",
			code: "invalid_request",
		});
		const changed = serviceWorld();
		expect(await changed.request(changed.make("status", { sessionId: "other" }))).toMatchObject({
			status: "failed",
			code: "session_changed",
		});
		const failed = serviceWorld(async () => {
			throw new Error("provider failed");
		});
		expect(await failed.request(failed.make("prepare"))).toMatchObject({
			status: "failed",
			code: "compression_failed",
		});
	});

	it("returns busy for a conflicting request while preparation is pending", async () => {
		let release: (message: AssistantMessage) => void = () => {};
		const pending = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		const world = serviceWorld(() => pending);
		const preparing = world.request(world.make("prepare", { requestId: "prepare" }));
		await Promise.resolve();
		const busy = await world.request(world.make("status", { requestId: "status" }));
		expect(busy).toMatchObject({ status: "failed", code: "busy" });
		release(assistantResponse("summary"));
		expect((await preparing).status).toBe("prepared");
	});
});

describe("serializer source policy", () => {
	it("caps decision prompts only when requested", () => {
		const { snapshot } = cropScenario();
		const full = serializeEntries(snapshot.contextEntries);
		const capped = serializeEntries(snapshot.contextEntries, { perEntryCap: 100 });
		expect(full.length).toBeGreaterThan(capped.length);
		expect(capped).toContain("(truncated)");
	});
});
