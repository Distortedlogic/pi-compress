import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { CTREE_DECISION } from "../src/protocol.ts";

export function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export class MemorySession {
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

export function assistantResponse(text: string): AssistantMessage {
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

export const models = [
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

export function extensionContext(
	manager: SessionManager,
	complete?: (...args: unknown[]) => Promise<AssistantMessage>,
): ExtensionCommandContext {
	const model = { ...models[0] };
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

export function mutationApi(manager: SessionManager): ExtensionAPI {
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
