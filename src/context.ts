import { type UserMessage, contentText } from "@earendil-works/pi-ai";
import type {
	CustomMessageEntry,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import {
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_RANGE_TAIL,
	type CtreeCloseStatus,
	type CtreeForkData,
	ctreeCloseData,
	ctreeForkData,
} from "./protocol.ts";

export type SessionManagerView = ExtensionContext["sessionManager"];

export interface SessionSnapshot {
	sessionId: string;
	entries: SessionEntry[];
	branch: SessionEntry[];
	contextEntries: SessionEntry[];
	tree: SessionTreeNode[];
	leafId: string | null;
}

export function snapshotSession(session: SessionManagerView): SessionSnapshot {
	return {
		sessionId: session.getSessionId(),
		entries: session.getEntries(),
		branch: session.getBranch(),
		contextEntries: session.buildContextEntries(),
		tree: session.getTree(),
		leafId: session.getLeafId(),
	};
}

export function snapshotEntry(snapshot: SessionSnapshot, entryId: string): SessionEntry | undefined {
	return snapshot.entries.find((entry) => entry.id === entryId);
}

type ForkStatus = "open" | CtreeCloseStatus;

export interface ForkInfo {
	entryId: string;
	data: CtreeForkData;
	status: ForkStatus;
}

export interface SessionState extends SessionSnapshot {
	forks: ForkInfo[];
	currentFork: ForkInfo | undefined;
}

function extractForks(session: SessionManagerView): ForkInfo[] {
	const entries = session.getEntries();
	const closes = new Map<string, CtreeCloseStatus>();
	for (const entry of entries) {
		const close = ctreeCloseData(entry);
		if (close) closes.set(close.forkEntryId, close.status);
	}

	const forks: ForkInfo[] = [];
	for (const entry of entries) {
		const data = ctreeForkData(entry);
		if (!data) continue;
		forks.push({
			entryId: entry.id,
			data,
			status: closes.get(entry.id) ?? "open",
		});
	}
	return forks;
}

export function nearestOpenFork(branch: readonly SessionEntry[], forks: ForkInfo[]): ForkInfo | undefined {
	const byId = new Map(forks.map((fork) => [fork.entryId, fork]));
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;
		const fork = byId.get(entry.id);
		if (fork?.status === "open") return fork;
	}
	return undefined;
}

export function decisionsOnPath(branch: readonly SessionEntry[]): CustomMessageEntry[] {
	return branch.filter(
		(entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === CTREE_DECISION,
	);
}

export function deriveState(ctx: ExtensionContext): SessionState {
	const snapshot = snapshotSession(ctx.sessionManager);
	const forks = extractForks(ctx.sessionManager);
	return { ...snapshot, forks, currentFork: nearestOpenFork(snapshot.branch, forks) };
}

const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function contentChars(content: UserMessage["content"]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += IMAGE_CHARS;
	}
	return chars;
}

function messageChars(message: SessionMessageEntry["message"]): number {
	switch (message.role) {
		case "user":
			return contentChars(message.content);
		case "assistant": {
			let chars = 0;
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
			}
			return chars;
		}
		case "toolResult":
			return contentChars(message.content);
		case "bashExecution":
			return message.excludeFromContext ? 0 : message.command.length + message.output.length;
		case "custom":
			return contentChars(message.content);
		case "branchSummary":
			return message.summary.length;
		case "compactionSummary":
			return message.summary.length;
		default:
			return 0;
	}
}

function entryChars(entry: SessionEntry): number {
	if (entry.type === "message") return messageChars(entry.message);
	switch (entry.type) {
		case "custom_message":
			return contentChars(entry.content);
		case "branch_summary":
			return entry.summary.length;
		case "compaction":
			return entry.summary.length;
		default:
			return 0;
	}
}

export function estimateEntryTokens(entry: SessionEntry): number {
	return Math.ceil(entryChars(entry) / CHARS_PER_TOKEN);
}

export type Band = "low" | "healthy" | "filling" | "red";

export const BAND_THRESHOLDS = { healthy: 5, filling: 15, red: 40 } as const;

export function band(percent: number): Band {
	if (percent < BAND_THRESHOLDS.healthy) return "low";
	if (percent < BAND_THRESHOLDS.filling) return "healthy";
	if (percent <= BAND_THRESHOLDS.red) return "filling";
	return "red";
}

export function fmtTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function serializeEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		switch (message.role) {
			case "user":
				return `user: ${contentText(message.content, "\n")}`;
			case "assistant": {
				const parts: string[] = [];
				for (const block of message.content) {
					if (block.type === "text" && block.text.trim()) parts.push(block.text);
					else if (block.type === "toolCall") parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
				}
				return parts.length ? `assistant: ${parts.join("\n")}` : undefined;
			}
			case "toolResult":
				return `[${message.toolName}]: ${contentText(message.content, "\n")}`;
			case "bashExecution":
				return message.excludeFromContext ? undefined : `[bash $ ${message.command}]: ${message.output}`;
			case "custom":
				return `[${message.customType}]: ${contentText(message.content, "\n")}`;
			case "branchSummary":
				return `[branch summary]: ${message.summary}`;
			case "compactionSummary":
				return `[compaction summary]: ${message.summary}`;
			default:
				return undefined;
		}
	}
	switch (entry.type) {
		case "custom_message":
			return `[${entry.customType}]: ${contentText(entry.content, "\n")}`;
		case "branch_summary":
			return `[branch summary]: ${entry.summary}`;
		case "compaction":
			return `[compaction summary]: ${entry.summary}`;
		default:
			return undefined;
	}
}

export interface SerializeOptions {
	perEntryCap?: number;
}

export function serializeEntries(entries: readonly SessionEntry[], options: SerializeOptions = {}): string {
	const parts: string[] = [];
	for (const entry of entries) {
		let text = serializeEntry(entry);
		if (text === undefined) continue;
		if (options.perEntryCap !== undefined && text.length > options.perEntryCap) {
			text = `${text.slice(0, options.perEntryCap)}…(truncated)`;
		}
		parts.push(text);
	}
	return parts.join("\n\n");
}

export interface ConsumerRow {
	key: string;
	tokens: number;
	entries: number;
	share: number;
}

function consumerBucket(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message;
		switch (message.role) {
			case "user":
				return "user messages";
			case "assistant":
				return "assistant messages";
			case "toolResult":
				return message.toolName;
			case "bashExecution":
				return "bash";
			case "custom":
				return "extension messages";
			case "branchSummary":
				return "branch summaries";
			case "compactionSummary":
				return "compaction summary";
			default:
				return "other";
		}
	}
	switch (entry.type) {
		case "custom_message":
			if (entry.customType === CTREE_DECISION) return "decision records";
			if (entry.customType === CTREE_CROP_TAIL) return "crop stubs";
			if (entry.customType === CTREE_RANGE_TAIL) return "range summaries";
			return "extension messages";
		case "branch_summary":
			return "branch summaries";
		case "compaction":
			return "compaction summary";
		default:
			return "other";
	}
}

export function aggregateConsumers(entries: readonly SessionEntry[]): ConsumerRow[] {
	const buckets = new Map<string, { tokens: number; entries: number }>();
	let total = 0;
	for (const entry of entries) {
		const tokens = estimateEntryTokens(entry);
		if (tokens === 0) continue;
		total += tokens;
		const key = consumerBucket(entry);
		const aggregate = buckets.get(key) ?? { tokens: 0, entries: 0 };
		aggregate.tokens += tokens;
		aggregate.entries += 1;
		buckets.set(key, aggregate);
	}
	return [...buckets.entries()]
		.map(([key, value]) => ({
			key,
			tokens: value.tokens,
			entries: value.entries,
			share: total === 0 ? 0 : value.tokens / total,
		}))
		.sort((left, right) => right.tokens - left.tokens);
}
