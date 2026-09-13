import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type ModelLike = Model<any>;
export type UiLike = ExtensionUIContext;

export class FakeSession {
	readonly manager = SessionManager.inMemory("/test/project");

	get entries(): SessionEntry[] {
		return this.manager.getEntries();
	}

	get leaf(): string | null {
		return this.manager.getLeafId();
	}

	append(fields: Record<string, unknown>): string {
		if (fields.type === "message") return this.manager.appendMessage(fields.message as never);
		if (fields.type === "custom") {
			return this.manager.appendCustomEntry(fields.customType as string, fields.data);
		}
		if (fields.type === "custom_message") {
			return this.manager.appendCustomMessageEntry(
				fields.customType as string,
				fields.content as never,
				fields.display as boolean,
				fields.details,
			);
		}
		throw new Error(`Unsupported fake entry type: ${String(fields.type)}`);
	}

	message(message: Record<string, unknown>): string {
		return this.manager.appendMessage(message as never);
	}

	user(text: string): string {
		return this.manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	}

	assistant(text: string): string {
		return this.manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "anthropic",
			model: "opus-4.8",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	toolResult(toolName: string, text: string): string {
		const toolCallId = `c${this.entries.length + 1}`;
		this.manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
			api: "openai-completions",
			provider: "anthropic",
			model: "opus-4.8",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		return this.manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		});
	}

	at(id: string): void {
		this.manager.branch(id);
	}
}

export class FakeUi {
	notifications: { msg: string; type?: string }[] = [];
	selectQueue: (string | undefined)[] = [];
	editorQueue: (string | undefined)[] = [];
	inputQueue: (string | undefined)[] = [];
	confirmQueue: boolean[] = [];
	statuses = new Map<string, string | undefined>();
	titles: string[] = [];
	selectCalls: { title: string; options: string[] }[] = [];
	/** unset by default — tests opt in to a TUI-capable ui by assigning (UiLike.custom is optional) */
	custom?: <T>(factory: unknown, options?: unknown) => Promise<T> = undefined;
	widgets = new Map<string, { lines: string[] | undefined; placement?: string }>();
	setWidget(key: string, content: string[] | undefined, options?: { placement?: string }): void {
		this.widgets.set(key, { lines: content, placement: options?.placement });
	}

	notify(msg: string, type?: "info" | "warning" | "error"): void {
		this.notifications.push({ msg, type });
	}
	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		return this.selectQueue.shift();
	}
	async confirm(): Promise<boolean> {
		return this.confirmQueue.shift() ?? true;
	}
	async input(): Promise<string | undefined> {
		return this.inputQueue.shift();
	}
	async editor(_title: string, prefill?: string): Promise<string | undefined> {
		const next = this.editorQueue.shift();
		return next === "__ACCEPT_PREFILL__" ? prefill : next;
	}
	setStatus(key: string, text: string | undefined): void {
		this.statuses.set(key, text);
	}
	setTitle(title: string): void {
		this.titles.push(title);
	}
	notes(): string[] {
		return this.notifications.map((n) => n.msg);
	}
	notesOf(type: string): string[] {
		return this.notifications.filter((n) => n.type === type).map((n) => n.msg);
	}
}

export interface FakeWorld {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	ui: FakeUi;
	session: FakeSession;
	calls: {
		navigate: { target: string; options?: { summarize?: boolean } }[];
		setModel: ModelLike[];
		labels: [string, string | undefined][];
	};
	commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>;
	completions: Map<string, ((prefix: string) => { value: string; label?: string }[] | null) | undefined>;
	shortcuts: Map<string, (ctx: ExtensionContext) => Promise<void> | void>;
}

function fakeModel(provider: string, id: string, contextWindow: number): ModelLike {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	} as ModelLike;
}

const KNOWN_MODELS: ModelLike[] = [
	fakeModel("anthropic", "opus-4.8", 200_000),
	fakeModel("anthropic", "haiku-4.5", 200_000),
	fakeModel("openai", "gpt-5.2", 400_000),
];

export function makeFake(): FakeWorld {
	const ui = new FakeUi();
	const session = new FakeSession();
	const calls: FakeWorld["calls"] = { navigate: [], setModel: [], labels: [] };
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>();
	const completions: FakeWorld["completions"] = new Map();
	let currentModel: ModelLike = KNOWN_MODELS[0] as ModelLike;

	const pi = {
		registerCommand: (name, opts) => {
			commands.set(name, (args, ctx) => opts.handler(args, ctx as never));
			completions.set(
				name,
				opts.getArgumentCompletions as ((prefix: string) => { value: string; label?: string }[] | null) | undefined,
			);
		},
		registerShortcut: (keyId, opts) => shortcuts.set(keyId, (ctx) => opts.handler(ctx as never)),
		on: () => {},
		sendMessage: (m) =>
			session.append({
				type: "custom_message",
				customType: m.customType,
				content: m.content,
				display: m.display,
				details: m.details,
			}),
		appendEntry: (customType, data) => session.append({ type: "custom", customType, data }),
		setLabel: (entryId, label) => calls.labels.push([entryId, label]),
		setModel: async (model) => {
			calls.setModel.push(model);
			currentModel = model;
			return true;
		},
		getSessionName: () => undefined,
	} satisfies Partial<ExtensionAPI>;

	const ctx = {
		ui: ui as unknown as UiLike,
		sessionManager: session.manager,
		get model() {
			return currentModel;
		},
		modelRegistry: {
			find: (provider: string, id: string) => KNOWN_MODELS.find((m) => m.provider === provider && m.id === id),
			getAll: () => KNOWN_MODELS,
			complete: async () => ({ content: [] }) as never,
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
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => {},
		navigateTree: async (target: string, options?: { summarize?: boolean }) => {
			calls.navigate.push({ target, options });
			session.at(target);
			return { cancelled: false };
		},
		getContextUsage: () => ({ tokens: 1200, contextWindow: 200_000, percent: 0.6 }),
	} as unknown as ExtensionCommandContext;

	return { pi: pi as unknown as ExtensionAPI, ctx, ui, session, calls, commands, completions, shortcuts };
}

export function entriesByType(session: FakeSession, type: string, customType?: string): SessionEntry[] {
	return session.entries.filter(
		(e) => e.type === type && (customType === undefined || (e as { customType?: string }).customType === customType),
	);
}
