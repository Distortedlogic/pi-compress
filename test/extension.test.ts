import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerAmbient, resetAmbient } from "../src/ambient.ts";
import { branchHandler, mergeHandler, undoHandler } from "../src/branches.ts";
import type { DraftFn } from "../src/draft.ts";
import { cropHandler } from "../src/panel.ts";
import { CTREE_CLOSE, CTREE_CROP, CTREE_CROP_TAIL, CTREE_DECISION, CTREE_FORK } from "../src/protocol.ts";
import { assistantResponse, MemorySession, models } from "./helpers.ts";

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
		return undefined;
	}
	async confirm(): Promise<boolean> {
		return true;
	}
	async select(): Promise<string | undefined> {
		return undefined;
	}
}

interface World {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	session: MemorySession;
	ui: TestUi;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	navigations: Array<{ entryId: string; summarize?: boolean }>;
	modelsSet: string[];
}

function world(): World {
	const session = new MemorySession();
	const ui = new TestUi();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const navigations: World["navigations"] = [];
	const modelsSet: string[] = [];
	let currentModel = models[0] as Model<any>;
	const pi = {
		on: (name, handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler as never);
			handlers.set(name, list);
			return () => {};
		},
		sendMessage: (message) => {
			session.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
		sendUserMessage: () => {},
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
		handlers,
		navigations,
		modelsSet,
	};
}

function durableSequence(session: SessionManager): string[] {
	return session
		.getEntries()
		.filter((entry) => entry.type === "custom" || entry.type === "custom_message")
		.map((entry) => entry.customType);
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
});

describe("branch and merge contracts", () => {
	it("creates a named fork, native label, and optional model switch", async () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("plan");
		await branchHandler(value.pi, value.ctx, "feature cheap-model");
		assert.deepEqual(durableSequence(value.session.manager), [CTREE_FORK]);
		assert.deepEqual(value.modelsSet, ["openai/cheap-model"]);
		const fork = value.session.manager.getEntries().find((entry) => entry.type === "custom");
		assert.equal(fork && value.session.manager.getLabel(fork.id), "feature");
	});

	it("squashes a branch into a reviewed decision before closing it", async () => {
		const value = world();
		const forkId = await seedBranch(value);
		value.ui.editorQueue.push("__PREFILL__");
		await mergeHandler(value.pi, value.ctx, "--squash", draft);
		assert.deepEqual(durableSequence(value.session.manager), [CTREE_FORK, CTREE_DECISION, CTREE_CLOSE]);
		assert.ok(value.navigations.some((navigation) => navigation.entryId === forkId && !navigation.summarize));
		assert.equal(value.modelsSet.at(-1), "openai/test-model");
	});

	it("writes nothing when the mandatory decision editor is cancelled", async () => {
		const value = world();
		await seedBranch(value);
		value.ui.editorQueue.push(undefined);
		await mergeHandler(value.pi, value.ctx, "--squash", draft);
		assert.deepEqual(durableSequence(value.session.manager), [CTREE_FORK]);
		assert.equal(value.navigations.length, 0);
	});

	it("keeps the inline discard sequence", async () => {
		const value = world();
		const forkId = await seedBranch(value);
		await mergeHandler(value.pi, value.ctx, "--discard rejected", draft);
		assert.deepEqual(durableSequence(value.session.manager), [CTREE_FORK, CTREE_CLOSE]);
		assert.ok(value.navigations.some((navigation) => navigation.entryId === forkId && !navigation.summarize));
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
		assert.deepEqual(durableSequence(value.session.manager), [
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
		value.session.toolUse("snapshot", { path: "old" }, "x".repeat(80_000));
		value.session.assistant("analysis one");
		value.session.assistant("analysis two");
		value.session.toolUse("snapshot", { path: "latest" }, "small");
		value.session.assistant("done");
		return { value };
	}

	it("preserves headless automatic apply and dry-run modes", async () => {
		for (const [args, expected] of [
			["--auto --apply --min-tokens 1 --older-than 0", [CTREE_CROP_TAIL, CTREE_CROP]],
			["--auto --apply --dry-run --min-tokens 1 --older-than 0", []],
		] as const) {
			const { value } = cropWorld();
			await cropHandler(value.pi, value.ctx, args);
			assert.deepEqual(durableSequence(value.session.manager), expected);
		}
	});
});

describe("append-only undo", () => {
	it("restores a crop source without deleting history", async () => {
		const value = world();
		value.session.user("root");
		const target = value.session.assistant("target");
		value.session.manager.appendCustomEntry(CTREE_CROP, { v: 1, sourceLeafId: target, stubbed: [] });
		const count = value.session.manager.getEntries().length;
		await undoHandler(value.pi, value.ctx);
		assert.equal(value.navigations.at(-1)?.entryId, target);
		assert.equal(value.session.manager.getEntries().length, count);
	});
});

describe("ambient and panel behavior", () => {
	it("warns once at red context usage and before native compaction", () => {
		const value = world();
		value.session.user("root");
		(value.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({
			tokens: 82_000,
			contextWindow: 200_000,
			percent: 41,
		});
		registerAmbient(value.pi);
		for (const handler of value.handlers.get("session_start") ?? []) handler({}, value.ctx);
		for (const handler of value.handlers.get("turn_end") ?? []) handler({}, value.ctx);
		assert.equal(value.ui.notifications.filter((item) => item.type === "warning").length, 1);
		for (const handler of value.handlers.get("session_before_compact") ?? []) handler({}, value.ctx);
		assert.equal(value.ui.notifications.filter((item) => item.type === "warning").length, 2);
	});
});
