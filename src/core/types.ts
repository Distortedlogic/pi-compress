import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfoEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";

export type {
	AssistantMessage,
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	ImageContent,
	ModelChangeEntry,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfoEntry,
	TextContent,
	ThinkingLevelChangeEntry,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
};

export type MessageEntry = SessionMessageEntry;
export type AgentMessage = SessionMessageEntry["message"];
export type UserContent = UserMessage["content"];
export type BashExecutionMessage = Extract<AgentMessage, { role: "bashExecution" }>;
export type CustomRoleMessage = Extract<AgentMessage, { role: "custom" }>;
export type BranchSummaryMessage = Extract<AgentMessage, { role: "branchSummary" }>;
export type CompactionSummaryMessage = Extract<AgentMessage, { role: "compactionSummary" }>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isMessageEntry(e: SessionEntry): e is MessageEntry {
	return e.type === "message" && typeof (e as MessageEntry).message === "object";
}

export function isCustomEntry(e: SessionEntry): e is CustomEntry {
	return e.type === "custom";
}

export function isCustomMessageEntry(e: SessionEntry): e is CustomMessageEntry {
	return e.type === "custom_message";
}

export function isCompactionEntry(e: SessionEntry): e is CompactionEntry {
	return e.type === "compaction";
}

export function isBranchSummaryEntry(e: SessionEntry): e is BranchSummaryEntry {
	return e.type === "branch_summary";
}
