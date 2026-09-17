import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshAmbient, registerAmbient, resetAmbient } from "../src/ambient.ts";
import {
	branchHandler,
	exportDecisionsMarkdown,
	mergeHandler,
	modelCompletions,
	registerBranch,
	renderDecisionRecord,
	resetModelCompletions,
	undoHandler,
} from "../src/branches.ts";
import { estimateEntryTokens, snapshotSession } from "../src/context.ts";
import { applyCropPlan, planCrop } from "../src/crop.ts";
import type { DraftFn } from "../src/draft.ts";
import piContextCompress from "../src/index.ts";
import { buildPanelInput, ContextPanel, cropHandler, registerPanel } from "../src/panel.ts";
import {
	COMPRESSION_ENTRY,
	type CompressionDetails,
	CTREE_CLOSE,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_FORK,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	compressionDetails,
	LEGACY_COMPRESSION_ENTRY,
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	type RangeCompressionRequest,
	type RangeCompressionResult,
} from "../src/protocol.ts";
import {
	prepareRangeCompression,
	rangeCompressHandler,
	registerRangeCompressionService,
} from "../src/range-compression.ts";
import { applyRewrite, prepareRewrite, rangeCandidates, revalidateRewrite } from "../src/rewrite.ts";

initTheme("dark");

const HASH = "a".repeat(64);

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

	toolUse(name: string, args: Record<string, unknown>, output: string): { call: string; result: string } {
		const id = `call-${this.now}`;
		const call = this.assistant("", [{ type: "toolCall", id, name, arguments: args }]);
		const result = this.manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: this.now++,
		});
		return { call, result };
	}
}

const models = [
	{
		provider: "openai",
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	},
	{
		provider: "openai",
		id: "cheap-model",
		name: "Cheap Model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	},
] as unknown as Model<any>[];

class TestUi {
	readonly theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	readonly notifications: Array<{ message: string; type?: string }> = [];
	readonly statuses = new Map<string, string | undefined>();
	readonly widgets = new Map<string, string[] | undefined>();
	readonly titles: string[] = [];
	readonly editorQueue: Array<string | undefined> = [];
	readonly inputQueue: Array<string | undefined> = [];
	readonly confirmQueue: boolean[] = [];
	readonly selectQueue: Array<string | undefined> = [];
	custom?: <T>(factory: unknown, options?: unknown) => Promise<T>;

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, type });
	}
	setStatus(key: string, value: string | undefined): void {
		this.statuses.set(key, value);
	}
	setWidget(key: string, value: string[] | undefined): void {
		this.widgets.set(key, value);
	}
	setTitle(value: string): void {
		this.titles.push(value);
	}
	async editor(_title: string, prefill?: string): Promise<string | undefined> {
		const value = this.editorQueue.shift();
		return value === "__PREFILL__" ? prefill : value;
	}
	async input(): Promise<string | undefined> {
		return this.inputQueue.shift();
	}
	async confirm(): Promise<boolean> {
		return this.confirmQueue.shift() ?? true;
	}
	async select(): Promise<string | undefined> {
		return this.selectQueue.shift();
	}
}

interface World {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	session: MemorySession;
	ui: TestUi;
	commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>;
	shortcuts: Map<string, (ctx: ExtensionContext) => Promise<void> | void>;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	renderers: Map<string, (...args: any[]) => Component | undefined>;
	navigations: Array<{ entryId: string; summarize?: boolean }>;
	modelsSet: string[];
	sentUserMessages: Array<{ content: unknown; options: unknown }>;
}

function world(): World {
	const session = new MemorySession();
	const ui = new TestUi();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const renderers = new Map<string, (...args: any[]) => Component | undefined>();
	const navigations: World["navigations"] = [];
	const modelsSet: string[] = [];
	const sentUserMessages: World["sentUserMessages"] = [];
	let currentModel = models[0] as Model<any>;
	const events = createEventBus();
	const pi = {
		registerCommand: (name, options) => commands.set(name, (args, ctx) => options.handler(args, ctx as never)),
		registerShortcut: (key, options) => shortcuts.set(key, (ctx) => options.handler(ctx as never)),
		registerMessageRenderer: (customType, renderer) => renderers.set(customType, renderer as never),
		on: (name, handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler as never);
			handlers.set(name, list);
		},
		sendMessage: (message) => {
			session.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
		sendUserMessage: (content, options) => {
			sentUserMessages.push({ content, options });
		},
		appendEntry: (customType, data) => {
			session.manager.appendCustomEntry(customType, data);
		},
		setLabel: (entryId, label) => {
			session.manager.appendLabelChange(entryId, label);
		},
		setModel: async (model) => {
			currentModel = model;
			modelsSet.push(`${model.provider}/${model.id}`);
			session.manager.appendModelChange(model.provider, model.id);
			return true;
		},
		getSessionName: () => undefined,
		events,
	} satisfies Partial<ExtensionAPI>;
	const ctx = {
		ui,
		sessionManager: session.manager,
		get model() {
			return currentModel;
		},
		modelRegistry: {
			getAll: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			complete: async () => assistantResponse("summary"),
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
		getContextUsage: () => ({ tokens: 30_000, contextWindow: 200_000, percent: 15 }),
		compact: () => {},
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: "/test/project" }),
		waitForIdle: async () => {},
		navigateTree: async (entryId: string, options?: { summarize?: boolean }) => {
			navigations.push({ entryId, summarize: options?.summarize });
			session.manager.branch(entryId);
			return { cancelled: false };
		},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	} as unknown as ExtensionCommandContext;
	return {
		pi: pi as unknown as ExtensionAPI,
		ctx,
		session,
		ui,
		commands,
		shortcuts,
		handlers,
		renderers,
		navigations,
		modelsSet,
		sentUserMessages,
	};
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

function durableSequence(session: SessionManager): string[] {
	return session
		.getEntries()
		.filter((entry) => entry.type === "custom" || entry.type === "custom_message")
		.map((entry) => entry.customType);
}

interface RangeSeed {
	rootId: string;
	anchorId: string;
	startId: string;
	endId: string;
	continuationUserId: string;
	leafId: string;
}

function seedRange(value: World): RangeSeed {
	const rootId = value.session.user("root request");
	const anchorId = value.session.assistant("root answer");
	const startId = value.session.user("selected question");
	const endId = value.session.assistant("selected answer");
	const continuationUserId = value.session.user("continuation question");
	const leafId = value.session.assistant("continuation answer");
	return { rootId, anchorId, startId, endId, continuationUserId, leafId };
}

function candidateFor(value: World, entryId: string) {
	return rangeCandidates(snapshotSession(value.session.manager)).find((candidate) =>
		candidate.entryIds.includes(entryId),
	);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function sendRangeRequest(value: World, request: RangeCompressionRequest): Promise<RangeCompressionResult> {
	return new Promise((resolve) => {
		const unsubscribe = value.pi.events.on(RANGE_COMPRESSION_RESULT, (event) => {
			const result = event as RangeCompressionResult;
			if (result.requestId !== request.requestId) return;
			unsubscribe();
			resolve(result);
		});
		value.pi.events.emit(RANGE_COMPRESSION_REQUEST, { request, context: value.ctx });
	});
}

function rangePrepareRequest(
	value: World,
	seed: RangeSeed,
	requestId: string,
	operationId: string,
	overrides: Partial<Pick<Extract<RangeCompressionRequest, { action: "prepare" }>, "endEntryId" | "review">> = {},
): Extract<RangeCompressionRequest, { action: "prepare" }> {
	return {
		v: 1,
		requestId,
		sessionId: value.session.manager.getSessionId(),
		operationId,
		action: "prepare",
		startEntryId: seed.startId,
		endEntryId: overrides.endEntryId ?? seed.endId,
		review: overrides.review ?? false,
	};
}

function rangeControlRequest(
	value: World,
	requestId: string,
	operationId: string,
	action: "apply" | "cancel" | "status",
): RangeCompressionRequest {
	const common = {
		v: 1 as const,
		requestId,
		sessionId: value.session.manager.getSessionId(),
		operationId,
	};
	if (action === "apply") return { ...common, action: "apply" };
	if (action === "cancel") return { ...common, action: "cancel" };
	return { ...common, action: "status" };
}

function compressionDetailsFixture(): CompressionDetails {
	return {
		v: 2,
		runId: "run-1",
		planId: "a".repeat(64),
		batchId: "b".repeat(64),
		operationId: "operation-1",
		structuralRevision: "c".repeat(64),
		fileRevision: "d".repeat(64),
		preCompletionBitmap: [false, true],
		sourceLeafId: "source-leaf",
		preTaskAnchorId: "anchor",
		taskMessageEntryId: "task",
		startEntryId: "start",
		endEntryId: "end",
		selectedEntryIds: ["start", "end"],
		sourceSha256: "e".repeat(64),
	};
}

async function seedBranch(value: World, name = "feature", model = "cheap-model"): Promise<string> {
	value.session.user("root");
	value.session.assistant("plan");
	await branchHandler(value.pi, value.ctx, `${name} ${model}`);
	const fork = value.session.manager
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.customType === CTREE_FORK);
	if (!fork) throw new Error("fork was not created");
	value.session.user("branch work");
	value.session.assistant("branch result");
	return fork.id;
}

const draft: DraftFn = async (_ctx, _model, system) =>
	system.includes("epitaph") ? "too complex" : "## Decision: feature\n**Outcome:** selected the safe option.\n";

beforeEach(() => {
	resetAmbient();
	resetModelCompletions();
});

describe("extension registration and policy", () => {
	it("registers every fixed command, Ctrl+Q, event integration, and the decision renderer", () => {
		const value = world();
		piContextCompress(value.pi);
		expect([...value.commands.keys()]).toEqual(["branch", "merge", "crop", "compress", "panel", "decisions", "undo"]);
		expect([...value.shortcuts.keys()]).toEqual(["ctrl+q"]);
		expect(value.renderers.has(CTREE_DECISION)).toBe(true);
		expect(value.handlers.has("session_start")).toBe(true);
	});

	it("registers the generic range compression service", async () => {
		const value = world();
		piContextCompress(value.pi);
		const requestId = "service-registration";
		const result = await new Promise<RangeCompressionResult>((resolve) => {
			const unsubscribe = value.pi.events.on(RANGE_COMPRESSION_RESULT, (event) => {
				const parsed = event as RangeCompressionResult;
				if (parsed.requestId !== requestId) return;
				unsubscribe();
				resolve(parsed);
			});
			value.pi.events.emit(RANGE_COMPRESSION_REQUEST, {
				request: {
					v: 1,
					action: "status",
					requestId,
					sessionId: value.session.manager.getSessionId(),
					operationId: "registration-check",
				},
				context: value.ctx,
			});
		});
		expect(result.status).toBe("missing");
	});

	it("keeps package entry points on the root source files", () => {
		const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
		expect(manifest.exports).toEqual({
			".": "./src/index.ts",
			"./protocol": "./src/protocol.ts",
			"./range-compression": "./src/range-compression.ts",
		});
		expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
	});
});

describe("range safety and rewrite contracts", () => {
	it("protects root entries and incomplete user turns", () => {
		const value = world();
		const rootId = value.session.user("root");
		value.session.assistant("answer");
		const incompleteId = value.session.user("unfinished");
		expect(candidateFor(value, rootId)).toMatchObject({
			protected: true,
			protectReason: "no anchor before this message group",
		});
		expect(candidateFor(value, incompleteId)).toMatchObject({
			protected: true,
			protectReason: "incomplete current user turn",
		});
	});

	it("keeps complete assistant tool-call groups atomic and selectable", () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		const calls: ToolCall[] = [
			{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
		];
		const assistantId = value.session.assistant("", calls);
		const firstResultId = value.session.manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "read",
			content: [{ type: "text", text: "a" }],
			isError: false,
			timestamp: 10,
		});
		const secondResultId = value.session.manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-b",
			toolName: "read",
			content: [{ type: "text", text: "b" }],
			isError: false,
			timestamp: 11,
		});
		const candidate = candidateFor(value, assistantId);
		expect(candidate).toMatchObject({
			startEntryId: assistantId,
			endEntryId: secondResultId,
			protected: false,
		});
		expect(candidate?.entryIds).toEqual([assistantId, firstResultId, secondResultId]);
	});

	it.each([
		["missing", undefined],
		["mismatched", "wrong-call"],
	] as const)("protects %s assistant tool-call groups", (_name, resultCallId) => {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		const assistantId = value.session.assistant("", [
			{ type: "toolCall", id: "expected-call", name: "read", arguments: { path: "a.ts" } },
		]);
		if (resultCallId) {
			value.session.manager.appendMessage({
				role: "toolResult",
				toolCallId: resultCallId,
				toolName: "read",
				content: [{ type: "text", text: "wrong" }],
				isError: false,
				timestamp: 12,
			});
		}
		expect(candidateFor(value, assistantId)).toMatchObject({
			protected: true,
			protectReason: "incomplete assistant tool-call group",
		});
	});

	it("protects standalone tool results and decision records", () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		const toolResultId = value.session.manager.appendMessage({
			role: "toolResult",
			toolCallId: "orphan",
			toolName: "read",
			content: [{ type: "text", text: "orphan" }],
			isError: false,
			timestamp: 13,
		});
		const decisionId = value.session.manager.appendCustomMessageEntry(CTREE_DECISION, "decision", true, {
			v: 1,
			forkEntryId: "fork",
			branchName: "choice",
		});
		expect(candidateFor(value, toolResultId)).toMatchObject({
			protected: true,
			protectReason: "tool result without its assistant tool call",
		});
		expect(candidateFor(value, decisionId)).toMatchObject({
			protected: true,
			protectReason: "decision record",
		});
	});

	it("protects branch summaries, compaction summaries, and context-inert metadata", () => {
		const branchValue = world();
		branchValue.session.user("root");
		const branchAnchor = branchValue.session.assistant("anchor");
		const branchSummaryId = branchValue.session.manager.branchWithSummary(branchAnchor, "branch summary");
		expect(candidateFor(branchValue, branchSummaryId)).toMatchObject({
			protected: true,
			protectReason: "structural context entry",
		});

		const compactValue = world();
		compactValue.session.user("root");
		compactValue.session.assistant("anchor");
		const keptId = compactValue.session.user("kept");
		compactValue.session.assistant("kept answer");
		const compactionId = compactValue.session.manager.appendCompaction("compact summary", keptId, 100);
		expect(candidateFor(compactValue, compactionId)).toMatchObject({
			protected: true,
			protectReason: "structural context entry",
		});

		const metadataValue = world();
		metadataValue.session.user("root");
		const targetId = metadataValue.session.assistant("anchor");
		const metadataIds = [
			metadataValue.session.manager.appendCustomEntry("test/state", { value: 1 }),
			metadataValue.session.manager.appendModelChange("openai", "cheap-model"),
			metadataValue.session.manager.appendThinkingLevelChange("high"),
			metadataValue.session.manager.appendLabelChange(targetId, "target"),
			metadataValue.session.manager.appendSessionInfo("session"),
		];
		for (const entryId of metadataIds) {
			expect(candidateFor(metadataValue, entryId)).toMatchObject({
				protected: true,
				protectReason: "context-inert session metadata",
			});
		}
	});

	it("plans selected and continuation IDs, source text, token estimates, and source hashes", () => {
		const value = world();
		const seed = seedRange(value);
		const snapshot = snapshotSession(value.session.manager);
		const plan = prepareRewrite(snapshot, seed.startId, seed.endId);
		const expectedSource = "user: selected question\n\nassistant: selected answer";
		expect(plan.anchorId).toBe(seed.anchorId);
		expect(plan.selectedEntryIds).toEqual([seed.startId, seed.endId]);
		expect(plan.continuationEntryIds).toEqual([seed.continuationUserId, seed.leafId]);
		expect(plan.source).toBe(expectedSource);
		expect(plan.continuationSerialized).toBe("user: continuation question\n\nassistant: continuation answer");
		expect(plan.selectedEstTokens).toBe(
			plan.selectedEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		);
		expect(plan.sourceSha256).toBe(createHash("sha256").update(expectedSource).digest("hex"));
	});

	it("rejects session, leaf, anchor, selected-source, and continuation changes", () => {
		const sessionChanged = world();
		const sessionSeed = seedRange(sessionChanged);
		const sessionPlan = prepareRewrite(
			snapshotSession(sessionChanged.session.manager),
			sessionSeed.startId,
			sessionSeed.endId,
		);
		expect(() => revalidateRewrite(world().ctx, sessionPlan)).toThrow("session changed");

		const leafChanged = world();
		const leafSeed = seedRange(leafChanged);
		const leafPlan = prepareRewrite(snapshotSession(leafChanged.session.manager), leafSeed.startId, leafSeed.endId);
		leafChanged.session.user("new leaf");
		expect(() => revalidateRewrite(leafChanged.ctx, leafPlan)).toThrow("leaf changed");

		const anchorMissing = world();
		const anchorSeed = seedRange(anchorMissing);
		const anchorPlan = prepareRewrite(
			snapshotSession(anchorMissing.session.manager),
			anchorSeed.startId,
			anchorSeed.endId,
		);
		expect(() => revalidateRewrite(anchorMissing.ctx, { ...anchorPlan, anchorId: "missing-anchor" })).toThrow(
			"anchor is no longer available",
		);

		const sourceChanged = world();
		const sourceSeed = seedRange(sourceChanged);
		const sourcePlan = prepareRewrite(
			snapshotSession(sourceChanged.session.manager),
			sourceSeed.startId,
			sourceSeed.endId,
		);
		const sourceEntry = sourceChanged.session.manager.getEntry(sourceSeed.startId);
		if (!sourceEntry || sourceEntry.type !== "message" || sourceEntry.message.role !== "user") {
			throw new Error("selected source fixture is invalid");
		}
		sourceEntry.message.content = "changed selected question";
		expect(() => revalidateRewrite(sourceChanged.ctx, sourcePlan)).toThrow("source changed");

		const continuationChanged = world();
		const continuationSeed = seedRange(continuationChanged);
		const continuationPlan = prepareRewrite(
			snapshotSession(continuationChanged.session.manager),
			continuationSeed.startId,
			continuationSeed.endId,
		);
		const continuationLeaf = continuationChanged.session.manager.getEntry(continuationSeed.leafId);
		if (!continuationLeaf) throw new Error("continuation fixture is invalid");
		continuationLeaf.parentId = continuationSeed.endId;
		expect(() => revalidateRewrite(continuationChanged.ctx, continuationPlan)).toThrow("source changed");
	});

	it("applies rewrites by branching and keeps the original source leaf recoverable", async () => {
		const value = world();
		const seed = seedRange(value);
		const plan = prepareRewrite(snapshotSession(value.session.manager), seed.startId, seed.endId);
		const countBefore = value.session.manager.getEntries().length;
		const result = await applyRewrite(value.pi, value.ctx, plan, {
			messages: [{ customType: "test/tail", content: "replacement", display: true }],
			marker: { customType: "test/marker", data: { sourceLeafId: seed.leafId } },
		});
		expect(result).toBe(true);
		expect(value.session.manager.getEntries()).toHaveLength(countBefore + 2);
		expect(durableSequence(value.session.manager)).toEqual(["test/tail", "test/marker"]);
		const originalBranchIds = value.session.manager.getBranch(seed.leafId).map((entry) => entry.id);
		expect(originalBranchIds).toEqual(expect.arrayContaining([...plan.selectedEntryIds, ...plan.continuationEntryIds]));
		for (const entryId of [...plan.selectedEntryIds, ...plan.continuationEntryIds]) {
			expect(value.session.manager.getEntry(entryId)).toBeDefined();
		}
	});

	it("writes nothing when rewrite navigation is cancelled", async () => {
		const value = world();
		const seed = seedRange(value);
		const plan = prepareRewrite(snapshotSession(value.session.manager), seed.startId, seed.endId);
		const entriesBefore = value.session.manager.getEntries();
		(value.ctx as unknown as { navigateTree: ExtensionCommandContext["navigateTree"] }).navigateTree = async () => ({
			cancelled: true,
		});
		const result = await applyRewrite(value.pi, value.ctx, plan, {
			messages: [{ customType: "test/tail", content: "replacement", display: true }],
			marker: { customType: "test/marker", data: {} },
		});
		expect(result).toBe(false);
		expect(value.session.manager.getEntries()).toEqual(entriesBefore);
		expect(value.session.manager.getLeafId()).toBe(seed.leafId);
	});
});

describe("range compression protocol", () => {
	it("keeps prepare, duplicate, conflict, status, apply, and repeated-apply behavior", async () => {
		const value = world();
		const seed = seedRange(value);
		registerRangeCompressionService(value.pi);
		const operationId = "range-main";
		expect(
			await sendRangeRequest(value, rangeControlRequest(value, "status-before", operationId, "status")),
		).toMatchObject({
			status: "missing",
		});
		expect(
			await sendRangeRequest(value, rangeControlRequest(value, "apply-before", operationId, "apply")),
		).toMatchObject({
			status: "failed",
			code: "not_prepared",
		});
		const prepare = rangePrepareRequest(value, seed, "prepare", operationId);
		expect(await sendRangeRequest(value, prepare)).toMatchObject({ status: "prepared" });
		expect(await sendRangeRequest(value, { ...prepare, requestId: "prepare-duplicate" })).toMatchObject({
			status: "prepared",
		});
		expect(
			await sendRangeRequest(
				value,
				rangePrepareRequest(value, seed, "prepare-conflict", operationId, { review: true }),
			),
		).toMatchObject({ status: "failed", code: "operation_conflict" });
		expect(
			await sendRangeRequest(value, rangeControlRequest(value, "status-after", operationId, "status")),
		).toMatchObject({
			status: "prepared",
		});
		const applied = await sendRangeRequest(value, rangeControlRequest(value, "apply", operationId, "apply"));
		expect(applied).toMatchObject({ status: "applied" });
		expect(durableSequence(value.session.manager)).toEqual([CTREE_RANGE_TAIL, CTREE_RANGE_COMPACT]);
		expect(value.session.manager.getBranch(seed.leafId).map((entry) => entry.id)).toContain(seed.endId);
		const repeated = await sendRangeRequest(value, rangeControlRequest(value, "apply-repeat", operationId, "apply"));
		expect(repeated).toMatchObject({ status: "applied" });
		expect(durableSequence(value.session.manager)).toEqual([CTREE_RANGE_TAIL, CTREE_RANGE_COMPACT]);
	});

	it("deduplicates an in-flight prepare and reports conflicts and busy actions", async () => {
		const value = world();
		const seed = seedRange(value);
		const started = deferred<void>();
		const release = deferred<AssistantMessage>();
		(value.ctx.modelRegistry as unknown as { complete: (...args: unknown[]) => Promise<AssistantMessage> }).complete =
			async () => {
				started.resolve(undefined);
				return release.promise;
			};
		registerRangeCompressionService(value.pi);
		const operationId = "range-pending";
		const prepare = rangePrepareRequest(value, seed, "pending-first", operationId);
		const first = sendRangeRequest(value, prepare);
		await started.promise;
		const duplicate = sendRangeRequest(value, { ...prepare, requestId: "pending-duplicate" });
		expect(
			await sendRangeRequest(
				value,
				rangePrepareRequest(value, seed, "pending-conflict", operationId, { review: true }),
			),
		).toMatchObject({ status: "failed", code: "operation_conflict" });
		expect(
			await sendRangeRequest(value, rangeControlRequest(value, "pending-apply", operationId, "apply")),
		).toMatchObject({
			status: "failed",
			code: "busy",
		});
		release.resolve(assistantResponse("range summary"));
		expect(await first).toMatchObject({ status: "prepared" });
		expect(await duplicate).toMatchObject({ status: "prepared" });
	});

	it("cancels absent, preparing, and prepared operations, including the model signal", async () => {
		const absent = world();
		seedRange(absent);
		registerRangeCompressionService(absent.pi);
		expect(
			await sendRangeRequest(absent, rangeControlRequest(absent, "cancel-absent", "range-absent", "cancel")),
		).toMatchObject({ status: "cancelled" });

		const preparing = world();
		const preparingSeed = seedRange(preparing);
		const started = deferred<void>();
		let modelSignal: AbortSignal | undefined;
		(
			preparing.ctx.modelRegistry as unknown as {
				complete: (...args: unknown[]) => Promise<AssistantMessage>;
			}
		).complete = async (...args: unknown[]) => {
			const options = args[2] as { signal?: AbortSignal } | undefined;
			if (!options?.signal) throw new Error("range preparation did not provide an abort signal");
			modelSignal = options.signal;
			started.resolve(undefined);
			return new Promise<AssistantMessage>((_resolve, reject) => {
				const abort = () => {
					const error = new Error("cancelled");
					error.name = "AbortError";
					reject(error);
				};
				if (options.signal?.aborted) abort();
				else options.signal?.addEventListener("abort", abort, { once: true });
			});
		};
		registerRangeCompressionService(preparing.pi);
		const preparingOperation = "range-preparing";
		const prepareResult = sendRangeRequest(
			preparing,
			rangePrepareRequest(preparing, preparingSeed, "cancel-preparing-prepare", preparingOperation),
		);
		await started.promise;
		expect(
			await sendRangeRequest(
				preparing,
				rangeControlRequest(preparing, "cancel-preparing", preparingOperation, "cancel"),
			),
		).toMatchObject({ status: "cancelled" });
		expect(modelSignal?.aborted).toBe(true);
		expect(await prepareResult).toMatchObject({ status: "cancelled" });

		const prepared = world();
		const preparedSeed = seedRange(prepared);
		registerRangeCompressionService(prepared.pi);
		const preparedOperation = "range-prepared";
		await sendRangeRequest(
			prepared,
			rangePrepareRequest(prepared, preparedSeed, "cancel-prepared-prepare", preparedOperation),
		);
		expect(
			await sendRangeRequest(prepared, rangeControlRequest(prepared, "cancel-prepared", preparedOperation, "cancel")),
		).toMatchObject({ status: "cancelled" });
		expect(
			await sendRangeRequest(prepared, rangeControlRequest(prepared, "cancelled-status", preparedOperation, "status")),
		).toMatchObject({ status: "cancelled" });
	});

	it("keeps apply non-interruptible and reports session changes", async () => {
		const value = world();
		const seed = seedRange(value);
		registerRangeCompressionService(value.pi);
		const operationId = "range-applying";
		await sendRangeRequest(value, rangePrepareRequest(value, seed, "applying-prepare", operationId));
		const enteredNavigation = deferred<void>();
		const releaseNavigation = deferred<void>();
		(value.ctx as unknown as { navigateTree: ExtensionCommandContext["navigateTree"] }).navigateTree = async (
			entryId,
			options,
		) => {
			value.navigations.push({ entryId, summarize: options?.summarize });
			enteredNavigation.resolve(undefined);
			await releaseNavigation.promise;
			value.session.manager.branch(entryId);
			return { cancelled: false };
		};
		const applying = sendRangeRequest(value, rangeControlRequest(value, "applying-apply", operationId, "apply"));
		await enteredNavigation.promise;
		expect(
			await sendRangeRequest(value, rangeControlRequest(value, "applying-cancel", operationId, "cancel")),
		).toMatchObject({ status: "failed", code: "busy" });
		releaseNavigation.resolve(undefined);
		expect(await applying).toMatchObject({ status: "applied" });

		const wrongSession = rangeControlRequest(value, "wrong-session", "wrong-session-operation", "status");
		wrongSession.sessionId = "different-session";
		expect(await sendRangeRequest(value, wrongSession)).toMatchObject({
			status: "failed",
			code: "session_changed",
		});
	});
});

describe("batch compression persistence", () => {
	it("parses legacy workstream compression markers", () => {
		const value = world();
		value.session.user("root");
		const details = compressionDetailsFixture();
		const markerId = value.session.manager.appendCustomEntry(LEGACY_COMPRESSION_ENTRY, details);
		const marker = value.session.manager.getEntry(markerId);
		if (!marker) throw new Error("legacy marker fixture is invalid");
		expect(compressionDetails(marker)).toEqual(details);
	});
});

describe("branch and merge contracts", () => {
	it("creates a named fork, native label, and optional model switch", async () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("plan");
		await branchHandler(value.pi, value.ctx, "feature cheap-model");
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK]);
		expect(value.modelsSet).toEqual(["openai/cheap-model"]);
		const fork = value.session.manager.getEntries().find((entry) => entry.type === "custom");
		expect(fork && value.session.manager.getLabel(fork.id)).toBe("feature");
	});

	it.each(["bad name", "feature unknown-model"])("rejects invalid branch input %s", async (input) => {
		const value = world();
		value.session.user("root");
		await branchHandler(value.pi, value.ctx, input);
		expect(durableSequence(value.session.manager)).toEqual([]);
	});

	it("rejects duplicate open names and keeps completion data as strings", async () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("plan");
		registerBranch(value.pi);
		for (const handler of value.handlers.get("session_start") ?? []) handler({}, value.ctx);
		expect(modelCompletions("feature cheap")).toEqual([{ value: "openai/cheap-model", label: "openai/cheap-model" }]);
		await branchHandler(value.pi, value.ctx, "feature");
		await branchHandler(value.pi, value.ctx, "feature");
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK]);
	});

	it.each(["--squash", "--no-llm"])("keeps the %s decision-before-close sequence", async (mode) => {
		const value = world();
		const forkId = await seedBranch(value);
		value.ui.editorQueue.push("__PREFILL__");
		await mergeHandler(value.pi, value.ctx, mode, draft);
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK, CTREE_DECISION, CTREE_CLOSE]);
		expect(value.navigations).toContainEqual({ entryId: forkId, summarize: false });
		expect(value.modelsSet.at(-1)).toBe("openai/test-model");
	});

	it("writes nothing when the mandatory decision editor is cancelled", async () => {
		const value = world();
		await seedBranch(value);
		value.ui.editorQueue.push(undefined);
		await mergeHandler(value.pi, value.ctx, "--squash", draft);
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK]);
		expect(value.navigations).toHaveLength(0);
	});

	it("keeps the inline discard sequence", async () => {
		const value = world();
		const forkId = await seedBranch(value);
		await mergeHandler(value.pi, value.ctx, "--discard rejected", draft);
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK, CTREE_CLOSE]);
		expect(value.navigations).toContainEqual({ entryId: forkId, summarize: false });
	});

	it("keeps the inline tournament sequence and sibling epitaph closures", async () => {
		const value = world();
		value.session.user("root");
		const anchor = value.session.assistant("three options");
		for (const name of ["option-a", "option-b", "option-c"]) {
			value.session.manager.branch(anchor);
			await branchHandler(value.pi, value.ctx, name);
			value.session.user(`${name} work`);
			value.session.assistant(`${name} result`);
		}
		value.ui.editorQueue.push("__PREFILL__");
		await mergeHandler(value.pi, value.ctx, "--tournament", draft);
		expect(durableSequence(value.session.manager)).toEqual([
			CTREE_FORK,
			CTREE_FORK,
			CTREE_FORK,
			CTREE_DECISION,
			CTREE_CLOSE,
			CTREE_CLOSE,
			CTREE_CLOSE,
		]);
	});
});

describe("crop command and inline recovery sequence", () => {
	function cropWorld() {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		const old = value.session.toolUse("snapshot", { path: "old" }, "x".repeat(80_000));
		value.session.assistant("analysis one");
		value.session.assistant("analysis two");
		value.session.toolUse("snapshot", { path: "latest" }, "small");
		value.session.assistant("done");
		return { value, old };
	}

	it("keeps the inline crop-tail-before-marker sequence", async () => {
		const { value, old } = cropWorld();
		const plan = planCrop(snapshotSession(value.session.manager), [old.result]);
		await applyCropPlan(value.pi, value.ctx, plan);
		expect(durableSequence(value.session.manager)).toEqual([CTREE_CROP_TAIL, CTREE_CROP]);
		expect(value.navigations[0]?.summarize).toBe(false);
	});

	it.each([
		["--top", false],
		["--auto --apply --min-tokens 1 --older-than 0", false],
		["--auto --apply --dry-run --min-tokens 1 --older-than 0", true],
	] as const)("preserves headless mode %s", async (args, dryRun) => {
		const { value } = cropWorld();
		await cropHandler(value.pi, value.ctx, args);
		const sequence = durableSequence(value.session.manager);
		if (dryRun) expect(sequence).toEqual([]);
		else expect(sequence).toEqual([CTREE_CROP_TAIL, CTREE_CROP]);
	});

	it("requires a second mark before cropping the latest protected tool result", () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		const result = value.session.toolUse("read", { path: "latest.ts" }, "latest result");
		const notices: string[] = [];
		const actions: unknown[] = [];
		const panel = new ContextPanel({
			input: { ...buildPanelInput(value.ctx), initialView: "crop" },
			tui: { requestRender: () => {} } as never,
			theme: value.ui.theme as never,
			onAction: (action) => actions.push(action),
			onNotify: (message) => notices.push(message),
			maxBody: 12,
		});
		panel.handleInput(" ");
		expect(panel.controller.marks.has(result.result)).toBe(false);
		expect(notices.at(-1)).toContain("space again");
		panel.handleInput(" ");
		expect(panel.controller.marks.has(result.result)).toBe(true);
		panel.handleInput("\r");
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ type: "crop-apply" });
	});
});

describe("append-only undo", () => {
	it.each(["branch", "crop", "range", "batch"])("restores the %s source target without deletion", async (kind) => {
		const value = world();
		value.session.user("root");
		const target = value.session.assistant("target");
		if (kind === "branch") {
			value.session.manager.appendCustomEntry(CTREE_FORK, {
				v: 1,
				name: "branch",
				parentEntryId: target,
				createdAt: 1,
				status: "open",
			});
		} else if (kind === "crop") {
			value.session.manager.appendCustomEntry(CTREE_CROP, { v: 1, sourceLeafId: target, stubbed: [] });
		} else if (kind === "range") {
			value.session.manager.appendCustomEntry(CTREE_RANGE_COMPACT, {
				v: 1,
				sourceLeafId: target,
				anchorId: "root",
				startEntryId: "start",
				endEntryId: "end",
				selectedEntryIds: ["start"],
				selectedEstTokens: 10,
				summaryEstTokens: 2,
				reclaimedEstTokens: 8,
				summaryModel: "openai/test-model",
				sourceSha8: "12345678",
			});
		} else {
			value.session.manager.appendCustomEntry(COMPRESSION_ENTRY, {
				v: 2,
				runId: "run",
				planId: HASH,
				batchId: HASH,
				operationId: "operation",
				structuralRevision: HASH,
				fileRevision: HASH,
				preCompletionBitmap: [],
				sourceLeafId: target,
				preTaskAnchorId: "anchor",
				taskMessageEntryId: "task",
				startEntryId: "start",
				endEntryId: "end",
				selectedEntryIds: ["start"],
				sourceSha256: HASH,
			});
		}
		const count = value.session.manager.getEntries().length;
		await undoHandler(value.pi, value.ctx);
		expect(value.navigations.at(-1)?.entryId).toBe(target);
		expect(value.session.manager.getEntries()).toHaveLength(count);
	});
});

describe("decision text", () => {
	it("renders and exports confirmed records without changing durable content", () => {
		const record = renderDecisionRecord({
			branchName: "feature",
			dateIso: "2026-06-12",
			model: "openai/test-model",
			branchId: "fork",
			outcome: "ship it",
			why: ["safe", "small"],
		});
		expect(record).toContain("**Assumptions:** —");
		expect(exportDecisionsMarkdown([record], "project")).toContain("# Decision records — project");
	});
});

describe("ambient and panel behavior", () => {
	it("requires range-summary review and rejects /compress outside the TUI", async () => {
		const interactive = world();
		const seed = seedRange(interactive);
		const prepared = await prepareRangeCompression(interactive.ctx, {
			operationId: "manual-review",
			startEntryId: seed.startId,
			endEntryId: seed.endId,
		});
		const customResults: unknown[] = [seed.startId, seed.endId, { status: "prepared", prepared }];
		interactive.ui.custom = async <T>() => customResults.shift() as T;
		await rangeCompressHandler(interactive.pi, interactive.ctx, "");
		expect(durableSequence(interactive.session.manager)).toEqual([]);
		expect(interactive.ui.notifications.at(-1)?.message).toContain("cancelled during summary review");

		const headless = world();
		seedRange(headless);
		(headless.ctx as unknown as { mode: string }).mode = "print";
		await rangeCompressHandler(headless.pi, headless.ctx, "");
		expect(headless.ui.notifications.at(-1)?.message).toContain("interactive TUI");
		expect(durableSequence(headless.session.manager)).toEqual([]);
	});

	it("dispatches the actionable /panel command from Ctrl+Q without opening UI directly", async () => {
		const value = world();
		value.session.user("root");
		const optionsSeen: unknown[] = [];
		value.ui.custom = async <T>(_factory: unknown, options?: unknown): Promise<T> => {
			optionsSeen.push(options);
			return { type: "close" } as T;
		};
		registerPanel(value.pi, draft);
		await value.shortcuts.get("ctrl+q")?.(value.ctx);
		expect(value.sentUserMessages).toEqual([{ content: "/panel", options: { expandPromptTemplates: true } }]);
		expect(optionsSeen).toEqual([]);
		await value.commands.get("panel")?.("", value.ctx);
		expect(optionsSeen).toEqual([{ overlay: true, overlayOptions: { anchor: "center", width: "100%" } }]);
	});

	it("keeps status, title, gauge, trend, red warning, and compact warning", () => {
		const value = world();
		value.session.user("root");
		refreshAmbient(value.ctx);
		expect(value.ui.statuses.get("ctree")).toBe("⎇ trunk · ctx 15.0% filling");
		expect(value.ui.widgets.get("ctree-gauge")?.[0]).toContain("15.0% filling");
		(value.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({
			tokens: 82_000,
			contextWindow: 200_000,
			percent: 41,
		});
		refreshAmbient(value.ctx);
		expect(value.ui.statuses.get("ctree")).toContain("▲ +26%");
		expect(value.ui.notifications.some((item) => item.message.includes("/compress"))).toBe(true);
		const redWarnings = value.ui.notifications.filter((item) => item.message.includes("context crossed")).length;
		registerAmbient(value.pi);
		for (const handler of value.handlers.get("session_start") ?? []) handler({}, value.ctx);
		expect(value.ui.notifications.filter((item) => item.message.includes("context crossed"))).toHaveLength(
			redWarnings + 1,
		);
		for (const handler of value.handlers.get("session_before_compact") ?? []) handler({}, value.ctx);
		expect(value.ui.notifications.some((item) => item.message.includes("/compact"))).toBe(true);
	});

	it("stays safe in print mode without creating a themed widget", () => {
		const value = world();
		(value.ctx as unknown as { mode: string }).mode = "print";
		value.session.user("root");
		refreshAmbient(value.ctx);
		expect(value.ui.widgets.size).toBe(0);
	});

	it("uses native panel components for one width and input smoke", () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		value.session.toolUse("read", { path: "large" }, "x".repeat(20_000));
		value.session.assistant("done");
		const actions: unknown[] = [];
		value.session.manager.appendSessionInfo("panel session");
		const panel = new ContextPanel({
			input: buildPanelInput(value.ctx),
			tui: { requestRender: () => {} } as never,
			theme: value.ui.theme as never,
			onAction: (action) => actions.push(action),
			maxBody: 12,
		});
		for (const width of [60, 100]) {
			for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(panel.opts.input.sessionName).toBe("panel session");
		expect(panel.controller.view).toBe("tree");
		panel.handleInput("c");
		expect(panel.controller.view).toBe("crop");
		panel.handleInput("t");
		expect(panel.controller.cropMode).toBe("turn");
		panel.handleInput("\x1b");
		panel.handleInput("u");
		expect(panel.controller.view).toBe("consumers");
		panel.handleInput("\x1b");
		panel.handleInput("D");
		expect(panel.controller.view).toBe("decisions");
		panel.handleInput("\x1b");
		panel.handleInput("i");
		expect(panel.controller.view).toBe("inspect");
		panel.handleInput("\x1b");
		panel.controller.cropMode = "result";
		panel.handleInput("c");
		panel.handleInput(" ");
		panel.handleInput(" ");
		panel.handleInput("\r");
		expect(actions).toHaveLength(1);
	});

	it("keeps panel command, shortcut, and no-UI decisions", async () => {
		const value = world();
		value.session.user("root");
		registerPanel(value.pi, draft);
		(value.ctx as unknown as { mode: string }).mode = "print";
		await value.commands.get("decisions")?.("", value.ctx);
		expect(value.ui.notifications.at(-1)?.message).toContain("no decision records");
		expect(value.shortcuts.has("ctrl+q")).toBe(true);
	});
});

function piPath(): string | null {
	try {
		return execFileSync("which", ["pi"], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

const PI = piPath();
const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

describe.skipIf(!PI)("RPC integration", () => {
	it("loads the source extension and returns all fixed commands", { timeout: 30_000 }, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "context-compress-rpc-"));
		const agentDir = mkdtempSync(join(tmpdir(), "context-compress-agent-"));
		const child = spawn(PI as string, ["--mode", "rpc", "-e", EXTENSION], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += String(data);
		});
		child.stderr.on("data", (data) => {
			stderr += String(data);
		});
		const commands = await new Promise<string[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`RPC timeout: ${stderr.slice(0, 1000)} ${stdout.slice(0, 1000)}`));
			}, 25_000);
			child.stdout.on("data", () => {
				for (const line of stdout.split("\n")) {
					try {
						const message = JSON.parse(line);
						if (message.type !== "response" || message.command !== "get_commands") continue;
						clearTimeout(timer);
						resolve((message.data?.commands ?? []).map((command: { name: string }) => command.name));
						return;
					} catch {}
				}
			});
			setTimeout(() => child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`), 1_500);
		}).finally(() => child.kill());
		expect(commands).toEqual(
			expect.arrayContaining(["branch", "merge", "crop", "compress", "panel", "decisions", "undo"]),
		);
	});
});
