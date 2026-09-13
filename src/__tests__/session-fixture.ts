import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { type SessionEntry, type SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";
import { CTREE_CLOSE, CTREE_CROP, CTREE_DECISION, CTREE_FORK, type CtreeCloseStatus } from "../core/types.ts";

export interface BuiltSession {
	header: SessionHeader;
	entries: SessionEntry[];
	text: string;
	leafId: string;
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export class PiSessionFixture {
	readonly session: SessionManager;

	constructor(cwd = "/home/u/project") {
		this.session = SessionManager.inMemory(cwd);
	}

	get leafId(): string | null {
		return this.session.getLeafId();
	}

	at(id: string): this {
		this.session.branch(id);
		return this;
	}

	message(message: Record<string, unknown>): string {
		return this.session.appendMessage(message as never);
	}

	user(text: string): string {
		return this.message({ role: "user", content: text, timestamp: Date.now() });
	}

	assistant(
		text: string,
		opts: { model?: string; provider?: string; toolCalls?: ToolCall[]; id?: string } = {},
	): string {
		return this.message({
			role: "assistant",
			content: [{ type: "text", text }, ...(opts.toolCalls ?? [])],
			api: "openai-completions",
			provider: opts.provider ?? "anthropic",
			model: opts.model ?? "opus-4.8",
			usage: usage(),
			stopReason: opts.toolCalls?.length ? "toolUse" : "stop",
			timestamp: Date.now(),
		});
	}

	toolResult(
		toolName: string,
		text: string,
		opts: { toolCallId?: string; isError?: boolean; id?: string } = {},
	): string {
		return this.message({
			role: "toolResult",
			toolCallId: opts.toolCallId ?? `call_${this.session.getEntries().length + 1}`,
			toolName,
			content: [{ type: "text", text }],
			isError: opts.isError ?? false,
			timestamp: Date.now(),
		});
	}

	toolUse(toolName: string, args: Record<string, unknown>, resultText: string, opts: { id?: string } = {}): string {
		const callId = `call_${this.session.getEntries().length + 1}`;
		this.message({
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "openai-completions",
			provider: "anthropic",
			model: "opus-4.8",
			usage: usage(),
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		return this.toolResult(toolName, resultText, { toolCallId: callId, id: opts.id });
	}

	bash(command: string, output: string): string {
		return this.message({
			role: "bashExecution",
			command,
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
	}

	modelChange(provider: string, modelId: string): string {
		return this.session.appendModelChange(provider, modelId);
	}

	compaction(summary: string, firstKeptEntryId: string, tokensBefore: number): string {
		return this.session.appendCompaction(summary, firstKeptEntryId, tokensBefore);
	}

	branchSummary(_fromId: string, summary: string): string {
		return this.session.branchWithSummary(this.session.getLeafId(), summary);
	}

	label(targetId: string, label: string | undefined): string {
		return this.session.appendLabelChange(targetId, label);
	}

	custom(customType: string, data: unknown): string {
		return this.session.appendCustomEntry(customType, data);
	}

	customMessage(customType: string, content: string, display = true, details?: unknown, _id?: string): string {
		return this.session.appendCustomMessageEntry(customType, content, display, details);
	}

	fork(name: string, opts: { trunkModel?: string; branchModel?: string; id?: string } = {}): string {
		return this.custom(CTREE_FORK, {
			v: 1,
			name,
			parentEntryId: this.session.getLeafId(),
			trunkModel: opts.trunkModel ?? "opus-4.8",
			branchModel: opts.branchModel,
			createdAt: Date.now(),
			status: "open",
		});
	}

	close(
		forkEntryId: string,
		status: CtreeCloseStatus,
		opts: { decisionEntryId?: string; note?: string; id?: string } = {},
	): string {
		return this.custom(CTREE_CLOSE, {
			v: 1,
			forkEntryId,
			status,
			decisionEntryId: opts.decisionEntryId,
			note: opts.note,
		});
	}

	decision(forkEntryId: string, branchName: string, markdown: string): string {
		return this.customMessage(CTREE_DECISION, markdown, true, { v: 1, forkEntryId, branchName });
	}

	crop(
		sourceLeafId: string,
		stubbed: { entryId: string; tool: string; arg?: string; estTokens: number; sha8: string }[],
	): string {
		return this.custom(CTREE_CROP, { v: 1, sourceLeafId, stubbed });
	}

	build(): BuiltSession {
		const header = this.session.getHeader() as SessionHeader;
		const entries = this.session.getEntries();
		return {
			header,
			entries,
			text: `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			leafId: this.session.getLeafId() ?? "",
		};
	}
}

export function filler(chars: number, seed = "0123456789abcdef"): string {
	return seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);
}
