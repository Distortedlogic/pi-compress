import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	SessionManager,
	createEventBus,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
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
import { applyCropPlan, cropHandler, planCrop } from "../src/compression.ts";
import type { Deps } from "../src/extension/draft.ts";
import piContextCompress from "../src/index.ts";
import {
	ContextPanel,
	buildPanelInput,
	refreshAmbient,
	registerAmbient,
	registerPanel,
	resetAmbient,
} from "../src/panel.ts";
import {
	COMPRESSION_ENTRY,
	CTREE_CLOSE,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_FORK,
	CTREE_RANGE_COMPACT,
} from "../src/protocol.ts";
import { snapshotSession } from "../src/session.ts";

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

const deps: Deps = {
	draft: async (_ctx, _model, system) =>
		system.includes("epitaph") ? "too complex" : "## Decision: feature\n**Outcome:** selected the safe option.\n",
};

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

	it("keeps package entry points on the root source files", () => {
		const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
		expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./protocol": "./src/protocol.ts" });
		expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
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
		await mergeHandler(value.pi, value.ctx, mode, deps);
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK, CTREE_DECISION, CTREE_CLOSE]);
		expect(value.navigations).toContainEqual({ entryId: forkId, summarize: false });
		expect(value.modelsSet.at(-1)).toBe("openai/test-model");
	});

	it("writes nothing when the mandatory decision editor is cancelled", async () => {
		const value = world();
		await seedBranch(value);
		value.ui.editorQueue.push(undefined);
		await mergeHandler(value.pi, value.ctx, "--squash", deps);
		expect(durableSequence(value.session.manager)).toEqual([CTREE_FORK]);
		expect(value.navigations).toHaveLength(0);
	});

	it("keeps the inline discard sequence", async () => {
		const value = world();
		const forkId = await seedBranch(value);
		await mergeHandler(value.pi, value.ctx, "--discard rejected", deps);
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
		await mergeHandler(value.pi, value.ctx, "--tournament", deps);
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
	it("keeps status, title, gauge, trend, red warning, and compact warning", () => {
		const value = world();
		value.session.user("root");
		refreshAmbient(value.pi, value.ctx);
		expect(value.ui.statuses.get("ctree")).toBe("⎇ trunk · ctx 15.0% filling");
		expect(value.ui.widgets.get("ctree-gauge")?.[0]).toContain("15.0% filling");
		(value.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({
			tokens: 82_000,
			contextWindow: 200_000,
			percent: 41,
		});
		refreshAmbient(value.pi, value.ctx);
		expect(value.ui.statuses.get("ctree")).toContain("▲ +26%");
		expect(value.ui.notifications.some((item) => item.message.includes("/compress"))).toBe(true);
		registerAmbient(value.pi);
		for (const handler of value.handlers.get("session_before_compact") ?? []) handler({}, value.ctx);
		expect(value.ui.notifications.some((item) => item.message.includes("/compact"))).toBe(true);
	});

	it("stays safe in print mode without creating a themed widget", () => {
		const value = world();
		(value.ctx as unknown as { mode: string }).mode = "print";
		value.session.user("root");
		refreshAmbient(value.pi, value.ctx);
		expect(value.ui.widgets.size).toBe(0);
	});

	it("uses native panel components for one width and input smoke", () => {
		const value = world();
		value.session.user("root");
		value.session.assistant("anchor");
		value.session.toolUse("read", { path: "large" }, "x".repeat(20_000));
		value.session.assistant("done");
		const actions: unknown[] = [];
		const panel = new ContextPanel({
			input: buildPanelInput(value.pi, value.ctx),
			tui: { requestRender: () => {} } as never,
			theme: value.ui.theme as never,
			onAction: (action) => actions.push(action),
			maxBody: 12,
		});
		for (const width of [60, 100]) {
			for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
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

	it("keeps panel command, shortcut, no-UI decisions, and read-only paths", async () => {
		const value = world();
		value.session.user("root");
		registerPanel(value.pi, deps);
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
