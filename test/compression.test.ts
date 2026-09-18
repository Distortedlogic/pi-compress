import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	initTheme,
	SessionManager,
	type TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	aggregateConsumers,
	band,
	estimateEntryTokens,
	fmtTokens,
	serializeEntries,
	snapshotSession,
} from "../src/context.ts";
import {
	autoSelect,
	contextTurns,
	cropCandidates,
	planCrop,
	planRemoveTurns,
	renderReconstruction,
} from "../src/crop.ts";
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
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	type RangeCompressionPrepareRequest,
	type RangeCompressionRequest,
	type RangeCompressionResult,
} from "../src/protocol.ts";
import {
	applyCompression,
	applyPreparedRangeCompression,
	compressRange,
	type PreparedRangeCompression,
	prepareCompression,
	prepareRangeCompression,
	type RangeCompressionInput,
	type RangeCompressionOutcome,
	type RangeCompressionTarget,
	rangeCompressHandler,
	registerRangeCompressionService,
	renderRangeTail,
	reviewRangeCompression,
} from "../src/range-compression.ts";
import { applyRewrite, candidateByEntryId, prepareRewrite, rangeCandidates, sourceSha8 } from "../src/rewrite.ts";

initTheme("dark");

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
	const latest = session.toolUse("chrome.snapshot", { url: "after" }, "B".repeat(400));
	session.assistant("done");
	return { session, old, latest, snapshot: snapshotSession(session.manager) };
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

function selectorEntryIds(component: Component): string[] {
	const selector = component as TreeSelectorComponent;
	const list = selector.getTreeList();
	const ids: string[] = [];
	for (let count = 0; count < 100; count++) {
		const entryId = list.getSelectedNode()?.entry.id;
		if (!entryId || ids.includes(entryId)) break;
		ids.push(entryId);
		selector.handleInput("\x1b[B");
	}
	return ids;
}

function selectSelectorEntry(component: Component, entryId: string): void {
	const selector = component as TreeSelectorComponent;
	for (let count = 0; count < 100; count++) {
		if (selector.getTreeList().getSelectedNode()?.entry.id === entryId) {
			selector.handleInput("\r");
			return;
		}
		selector.handleInput("\x1b[B");
	}
	throw new Error(`Selector entry ${entryId} was not found.`);
}

function captureRangeSelectors(ctx: ExtensionCommandContext, choices: readonly (string | undefined)[]): string[][] {
	const projections: string[][] = [];
	let selectionIndex = 0;
	const ui = ctx.ui as unknown as {
		custom: <T>(factory: (...args: any[]) => Component) => Promise<T>;
	};
	ui.custom = async <T>(factory: (...args: any[]) => Component): Promise<T> =>
		new Promise<T>((resolve) => {
			const component = factory({ terminal: { rows: 30 }, requestRender: () => {} }, {}, {}, resolve);
			projections.push(selectorEntryIds(component));
			const choice = choices[selectionIndex++];
			if (choice === undefined) component.handleInput?.("\x1b");
			else selectSelectorEntry(component, choice);
		});
	return projections;
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
	for (const [tokens, expected] of [
		[0, "0"],
		[950, "950"],
		[19_400, "19.4k"],
		[200_000, "200k"],
	] as const) {
		it(`formats ${tokens} tokens as ${expected}`, () => {
			assert.equal(fmtTokens(tokens), expected);
		});
	}

	for (const [percent, expected] of [
		[4.9, "low"],
		[5, "healthy"],
		[15, "filling"],
		[40, "filling"],
		[40.1, "red"],
	] as const) {
		it(`maps ${percent} percent to ${expected}`, () => {
			assert.equal(band(percent), expected);
		});
	}

	it("counts image input and groups context by source", () => {
		const session = new MemorySession();
		session.manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "x", mimeType: "image/png" }],
			timestamp: 1,
		});
		const result = session.toolUse("read", { path: "large.txt" }, "x".repeat(8_000));
		const snapshot = snapshotSession(session.manager);
		assert.ok(estimateEntryTokens(session.manager.getEntry(result.call)!) > 0);
		const consumers = aggregateConsumers(snapshot.contextEntries);
		assert.equal(consumers[0]?.key, "read");
		assert.ok(Math.abs(consumers.reduce((total, row) => total + row.share, 0) - 1) < 0.005);
	});
});

describe("crop and whole-turn planning", () => {
	it("protects the latest result and keeps matching tools or arguments during auto selection", () => {
		const { old, latest, snapshot } = cropScenario();
		const candidates = cropCandidates(snapshot);
		assert.equal(candidates.find((candidate) => candidate.entryId === old.result)?.protected, false);
		assert.equal(candidates.find((candidate) => candidate.entryId === latest.result)?.protected, true);
		assert.ok(autoSelect(candidates, { minTokens: 1, olderThanTurns: 0 }).includes(old.result));
		assert.ok(!autoSelect(candidates, { minTokens: 1, olderThanTurns: 0, keep: ["chrome.*"] }).includes(old.result));
		assert.ok(!autoSelect(candidates, { minTokens: 1, olderThanTurns: 0, keep: ["tab-*"] }).includes(old.result));
	});

	it("stubs selected results, keeps continuation order, and preserves originals", () => {
		const { old, snapshot } = cropScenario();
		const plan = planCrop(snapshot, [old.result]);
		const rendered = renderReconstruction(plan);
		assert.equal(plan.startEntryId, old.call);
		assert.match(plan.stubs[0]?.sha8 ?? "", /^[a-f0-9]{8}$/);
		assert.ok(rendered.includes("[cropped: chrome.snapshot tab-audit"));
		assert.ok(rendered.includes("analysis"));
		assert.ok(!rendered.includes("A".repeat(200)));
		assert.notEqual(
			snapshot.entries.find((entry) => entry.id === old.result),
			undefined,
		);
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
		assert.ok(turns.map((turn) => turn.userId).includes(removed));
		const plan = planRemoveTurns(snapshot, [removed]);
		const rendered = renderReconstruction(plan);
		assert.equal(plan.dropped[0]?.entryIds.length, 4);
		assert.ok(rendered.includes("[dropped turn —"));
		assert.ok(!rendered.includes("remove this question"));
		assert.ok(rendered.includes("keep this answer"));
	});
});

describe("shared range safety", () => {
	it("keeps a tool call and all contiguous results in one atomic group", () => {
		const { old, snapshot } = cropScenario();
		const groups = candidateByEntryId(rangeCandidates(snapshot));
		assert.deepEqual(groups.get(old.result)?.entryIds, [old.call, old.result]);
		assert.equal(groups.get(old.result)?.startEntryId, old.call);
		assert.throws(() => prepareRewrite(snapshot, old.result, old.result), /split a required tool-call group/);
	});

	for (const [name, build] of [
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
	] as const) {
		it(`rejects ${name}`, () => {
			const value = build();
			assert.throws(() => prepareRewrite(value.snapshot, value.start, value.end));
		});
	}

	for (const kind of [
		"custom",
		"model_change",
		"thinking_level_change",
		"label",
		"session_info",
		"compaction",
		"branch_summary",
	] as const) {
		it(`protects the ${kind} metadata or structural boundary`, () => {
			const session = new MemorySession();
			session.user("root");
			session.assistant("anchor");
			const before = session.assistant("before boundary");
			let boundary: string;
			switch (kind) {
				case "custom":
					boundary = session.manager.appendCustomEntry("metadata");
					break;
				case "model_change":
					boundary = session.manager.appendModelChange("openai", "other-model");
					break;
				case "thinking_level_change":
					boundary = session.manager.appendThinkingLevelChange("high");
					break;
				case "label":
					boundary = session.manager.appendLabelChange(before, "checkpoint");
					break;
				case "session_info":
					boundary = session.manager.appendSessionInfo("named session");
					break;
				case "compaction":
					boundary = session.manager.appendCompaction("summary", before, 100);
					break;
				case "branch_summary":
					boundary = session.manager.branchWithSummary(before, "summary");
					break;
			}
			const after = session.assistant("after boundary");
			const snapshot = snapshotSession(session.manager);
			assert.throws(() => prepareRewrite(snapshot, boundary, boundary), /protected/);
			if (kind !== "compaction") assert.throws(() => prepareRewrite(snapshot, before, after), /protected/);
		});
	}

	it("shows only legal starts in the first selector", async () => {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("legal before boundary");
		const metadata = session.manager.appendCustomEntry("metadata");
		const after = session.assistant("legal after boundary");
		const pending = session.user("incomplete current turn");
		const ctx = extensionContext(session.manager);
		const projections = captureRangeSelectors(ctx, [undefined]);
		await rangeCompressHandler(mutationApi(session.manager), ctx, "");
		assert.equal(projections.length, 1);
		assert.deepEqual(new Set(projections[0]), new Set([anchor, after]));
		assert.ok(![metadata, pending].some((entryId) => projections[0]?.includes(entryId)));
	});

	it("shows only legal ends and stops at the first protected boundary", async () => {
		const session = new MemorySession();
		session.user("root");
		const start = session.assistant("selected start");
		const boundary = session.manager.appendCustomEntry("metadata");
		const later = session.assistant("after boundary");
		const ctx = extensionContext(session.manager);
		const projections = captureRangeSelectors(ctx, [start, undefined]);
		await rangeCompressHandler(mutationApi(session.manager), ctx, "");
		assert.equal(projections.length, 2);
		assert.deepEqual(projections[1], [start]);
		assert.ok(![boundary, later].some((entryId) => projections[1]?.includes(entryId)));
	});

	it("omits inactive branches from both selector projections", async () => {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("branch anchor");
		const inactive = session.assistant("inactive branch");
		session.manager.branch(anchor);
		const active = session.assistant("active branch");
		const ctx = extensionContext(session.manager);
		const projections = captureRangeSelectors(ctx, [anchor, undefined]);
		await rangeCompressHandler(mutationApi(session.manager), ctx, "");
		assert.equal(projections.length, 2);
		assert.ok(!projections.flat().includes(inactive));
		assert.ok([anchor, active].every((entryId) => projections[0]?.includes(entryId)));
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
		await rangeCompressHandler(mutationApi(session.manager), ctx, "");
		assert.equal(selections, 2);
		assert.equal(session.manager.getEntries().length, before);
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
		assert.equal(plan.selectedEntryIds.length, 500);
		assert.ok(performance.now() - start < 2_000);
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

	for (const change of ["session", "leaf", "selected", "continuation", "hash"] as const) {
		it(`rejects changed ${change} before navigation or writes`, async () => {
			const world = validWorld();
			let plan = world.plan;
			if (change === "session") plan = { ...plan, sessionId: "other" };
			if (change === "leaf") world.session.user("changed leaf");
			if (change === "selected") plan = { ...plan, selectedEntryIds: [...plan.selectedEntryIds, "other"] };
			if (change === "continuation") {
				plan = { ...plan, continuationEntryIds: [...plan.continuationEntryIds, "other"] };
			}
			if (change === "hash") plan = { ...plan, sourceSha256: "0".repeat(64) };
			await assert.rejects(
				applyRewrite(world.pi, world.ctx, plan, {
					messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
					marker: { customType: CTREE_CROP, data: {} },
				}),
			);
			assert.equal(world.session.manager.getEntries().length, world.entriesBefore + (change === "leaf" ? 1 : 0));
		});
	}

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

	it("orchestrates explicit no-review compression", async () => {
		const world = directWorld();
		const input: RangeCompressionInput = {
			operationId: "automated-operation",
			startEntryId: world.selected,
			endEntryId: world.selected,
			review: false,
		};
		const outcome: RangeCompressionOutcome = await compressRange(world.pi, world.ctx, input);
		assert.equal(outcome.status, "applied");
		if (outcome.status === "applied") assert.equal(outcome.details.operationId, "automated-operation");
	});

	it("cancels reviewed compression without writes when the editor closes", async () => {
		const world = directWorld();
		(world.ctx.ui as { editor: (title: string, prefill?: string) => Promise<string | undefined> }).editor = async () =>
			undefined;
		const before = world.session.manager.getEntries().length;
		const outcome = await compressRange(world.pi, world.ctx, {
			operationId: "review-cancelled",
			startEntryId: world.selected,
			endEntryId: world.selected,
			review: true,
		});
		assert.equal(outcome.status, "cancelled");
		assert.equal(world.session.manager.getEntries().length, before);
	});

	it("rejects an empty model summary", async () => {
		const world = directWorld(async () => assistantResponse(""));
		await assert.rejects(
			prepareRangeCompression(world.ctx, {
				operationId: "empty-summary",
				startEntryId: world.selected,
				endEntryId: world.selected,
			}),
			/empty draft/,
		);
	});

	it("passes and honors the caller abort signal", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const world = directWorld(async (...args: unknown[]) => {
			receivedSignal = (args[2] as { signal?: AbortSignal }).signal;
			controller.abort();
			controller.signal.throwIfAborted();
			return assistantResponse("unreachable");
		});
		await assert.rejects(
			prepareRangeCompression(world.ctx, {
				operationId: "aborted",
				startEntryId: world.selected,
				endEntryId: world.selected,
				signal: controller.signal,
			}),
			{ name: "AbortError" },
		);
		assert.equal(receivedSignal, controller.signal);
	});

	it("rejects a stale source leaf before applying", async () => {
		const world = directWorld();
		const prepared = await prepareRangeCompression(world.ctx, {
			operationId: "stale-leaf",
			startEntryId: world.selected,
			endEntryId: world.selected,
		});
		world.session.user("changed leaf");
		const before = world.session.manager.getEntries().length;
		await assert.rejects(applyPreparedRangeCompression(world.pi, world.ctx, prepared), /leaf changed/);
		assert.equal(world.session.manager.getEntries().length, before);
	});

	it("rejects a changed session before applying", async () => {
		const world = directWorld();
		const prepared = await prepareRangeCompression(world.ctx, {
			operationId: "changed-session",
			startEntryId: world.selected,
			endEntryId: world.selected,
		});
		world.session.manager.newSession();
		await assert.rejects(applyPreparedRangeCompression(world.pi, world.ctx, prepared), /session changed/);
		assert.equal(world.session.manager.getEntries().length, 0);
	});

	it("rejects pending messages before preparation", async () => {
		const world = directWorld();
		(world.ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages = () => true;
		await assert.rejects(
			prepareRangeCompression(world.ctx, {
				operationId: "pending-messages",
				startEntryId: world.selected,
				endEntryId: world.selected,
			}),
			/messages are pending/,
		);
	});

	it("reports a model failure without writes", async () => {
		const world = directWorld(async () => {
			throw new Error("provider failed");
		});
		const before = world.session.manager.getEntries().length;
		await assert.rejects(
			prepareRangeCompression(world.ctx, {
				operationId: "model-failure",
				startEntryId: world.selected,
				endEntryId: world.selected,
			}),
			/provider failed/,
		);
		assert.equal(world.session.manager.getEntries().length, before);
	});
});

describe("generic range compression service", () => {
	function serviceWorld(complete?: (...args: unknown[]) => Promise<AssistantMessage>) {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("anchor");
		const selected = session.assistant("selected");
		const events = createEventBus();
		const shutdownHandlers: Array<(event: unknown, ctx: ExtensionCommandContext) => unknown> = [];
		const pi = Object.assign(mutationApi(session.manager), {
			events,
			on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => {
				if (name === "session_shutdown") shutdownHandlers.push(handler);
			},
		}) as unknown as ExtensionAPI;
		const ctx = extensionContext(session.manager, complete);
		registerRangeCompressionService(pi);
		let requestNumber = 0;
		const request = (value: RangeCompressionRequest): Promise<RangeCompressionResult> =>
			new Promise((resolve) => {
				const unsubscribe = events.on(RANGE_COMPRESSION_RESULT, (result) => {
					const parsed = result as RangeCompressionResult;
					if (parsed.requestId !== value.requestId) return;
					unsubscribe();
					resolve(parsed);
				});
				events.emit(RANGE_COMPRESSION_REQUEST, { request: value, context: ctx });
			});
		const prepare = (
			operationId = "operation",
			overrides: Partial<RangeCompressionPrepareRequest> = {},
		): RangeCompressionPrepareRequest => ({
			v: 1,
			requestId: `prepare-${++requestNumber}`,
			sessionId: session.manager.getSessionId(),
			operationId,
			action: "prepare",
			startEntryId: selected,
			endEntryId: selected,
			review: false,
			...overrides,
		});
		const action = (
			action: "apply" | "cancel" | "status",
			operationId = "operation",
			overrides: { requestId?: string; sessionId?: string } = {},
		): RangeCompressionRequest => ({
			v: 1,
			requestId: `${action}-${++requestNumber}`,
			sessionId: session.manager.getSessionId(),
			operationId,
			action,
			...overrides,
		});
		return { session, anchor, selected, events, pi, ctx, shutdownHandlers, request, prepare, action };
	}

	it("supports prepare, status, apply, replay, cancel, missing, conflict, and session checks", async () => {
		const world = serviceWorld();
		assert.equal((await world.request(world.action("status"))).status, "missing");
		assert.equal((await world.request(world.prepare())).status, "prepared");
		assert.equal((await world.request(world.action("status"))).status, "prepared");
		assert.partialDeepStrictEqual(await world.request(world.prepare("operation", { instructions: "different" })), {
			status: "failed",
			code: "operation_conflict",
		});
		const applied = await world.request(world.action("apply"));
		assert.equal(applied.status, "applied");
		if (applied.status === "applied") assert.equal(applied.details.operationId, "operation");
		assert.equal((await world.request(world.action("apply"))).status, "applied");
		assert.partialDeepStrictEqual(await world.request(world.action("apply", "missing")), {
			status: "failed",
			code: "not_prepared",
		});
		assert.partialDeepStrictEqual(await world.request(world.action("status", "other", { sessionId: "other" })), {
			status: "failed",
			code: "session_changed",
		});

		const cancelled = serviceWorld();
		assert.equal((await cancelled.request(cancelled.action("cancel"))).status, "cancelled");
		assert.equal((await cancelled.request(cancelled.action("status"))).status, "cancelled");
	});

	it("reuses an identical in-flight preparation and rejects conflicting data", async () => {
		let release: (message: AssistantMessage) => void = () => {};
		let started: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const response = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const world = serviceWorld(async () => {
			calls += 1;
			started();
			return response;
		});
		const original = world.prepare("shared", { requestId: "first" });
		const first = world.request(original);
		await entered;
		const duplicate = world.request({ ...original, requestId: "duplicate" });
		const conflict = await world.request({ ...original, requestId: "conflict", instructions: "different" });
		assert.partialDeepStrictEqual(conflict, { status: "failed", code: "operation_conflict" });
		release(assistantResponse("summary"));
		assert.equal((await first).status, "prepared");
		assert.equal((await duplicate).status, "prepared");
		assert.equal(calls, 1);
	});

	it("aborts a pending preparation on cancel", async () => {
		let reportSignal: (signal: AbortSignal) => void = () => {};
		const started = new Promise<AbortSignal>((resolve) => {
			reportSignal = resolve;
		});
		const world = serviceWorld(async (...args: unknown[]) => {
			const signal = (args[2] as { signal: AbortSignal }).signal;
			reportSignal(signal);
			return new Promise<AssistantMessage>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const preparing = world.request(world.prepare("cancel-pending"));
		const signal = await started;
		assert.equal((await world.request(world.action("cancel", "cancel-pending"))).status, "cancelled");
		assert.equal(signal.aborted, true);
		assert.equal((await preparing).status, "cancelled");
	});

	it("returns busy for a concurrent session mutation", async () => {
		const world = serviceWorld();
		assert.equal((await world.request(world.prepare("first"))).status, "prepared");
		assert.equal((await world.request(world.prepare("second"))).status, "prepared");
		let enterNavigation: () => void = () => {};
		let releaseNavigation: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			enterNavigation = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releaseNavigation = resolve;
		});
		const navigate = world.ctx.navigateTree;
		(world.ctx as unknown as { navigateTree: ExtensionCommandContext["navigateTree"] }).navigateTree = async (
			targetId,
			options,
		) => {
			enterNavigation();
			await blocked;
			return navigate(targetId, options);
		};
		const applying = world.request(world.action("apply", "first"));
		await entered;
		assert.partialDeepStrictEqual(await world.request(world.action("apply", "second")), {
			status: "failed",
			code: "busy",
		});
		releaseNavigation();
		assert.equal((await applying).status, "applied");
	});

	it("aborts and removes pending state on session shutdown", async () => {
		let reportSignal: (signal: AbortSignal) => void = () => {};
		const started = new Promise<AbortSignal>((resolve) => {
			reportSignal = resolve;
		});
		const world = serviceWorld(async (...args: unknown[]) => {
			const signal = (args[2] as { signal: AbortSignal }).signal;
			reportSignal(signal);
			return new Promise<AssistantMessage>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const preparing = world.request(world.prepare("shutdown"));
		const signal = await started;
		for (const handler of world.shutdownHandlers) await handler({}, world.ctx);
		assert.equal(signal.aborted, true);
		assert.equal((await preparing).status, "cancelled");
		assert.equal((await world.request(world.action("status", "shutdown"))).status, "missing");
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

describe("serializer source policy", () => {
	it("caps decision prompts only when requested", () => {
		const { snapshot } = cropScenario();
		const full = serializeEntries(snapshot.contextEntries);
		const capped = serializeEntries(snapshot.contextEntries, { perEntryCap: 100 });
		assert.ok(full.length > capped.length);
		assert.ok(capped.includes("(truncated)"));
	});
});
