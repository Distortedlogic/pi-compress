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
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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
// ctree custom-entry payloads (schema-versioned, append-only)
// ---------------------------------------------------------------------------

export const CTREE_FORK = "ctree/fork";
export const CTREE_CLOSE = "ctree/close";
export const CTREE_DECISION = "ctree/decision";
export const CTREE_CROP = "ctree/crop";
export const CTREE_CROP_TAIL = "ctree/crop-tail";
export const CTREE_RANGE_COMPACT = "ctree/range-compact";
export const CTREE_RANGE_TAIL = "ctree/range-tail";

export type CtreeCloseStatus = "squashed" | "rejected" | "discarded";

export interface CtreeForkData {
	v: 1;
	name: string;
	parentEntryId: string | null;
	trunkModel?: string;
	branchModel?: string;
	createdAt: number;
	status: "open";
}

export interface CtreeCloseData {
	v: 1;
	forkEntryId: string;
	status: CtreeCloseStatus;
	decisionEntryId?: string;
	note?: string;
	/** the leaf at the moment of merge (the branch tip) — /undo navigates back here to re-open the branch */
	prevLeafId?: string;
}

export interface CtreeCropStub {
	entryId: string;
	tool: string;
	arg?: string;
	estTokens: number;
	sha8: string;
}

/** A whole Q&A turn removed from context (question + its answers, dropped together). */
export interface CtreeCropDrop {
	/** the opening user message id */
	userId: string;
	/** every entry id removed with the turn */
	entryIds: string[];
	/** first line of the question (display) */
	label: string;
	estTokens: number;
	/** hash of the removed bodies — recoverability proof */
	sha8: string;
}

export interface CtreeCropData {
	v: 1;
	sourceLeafId: string;
	stubbed: CtreeCropStub[];
	/** present only when whole turns were removed (not just tool results stubbed) */
	dropped?: CtreeCropDrop[];
}

export interface CtreeDecisionDetails {
	v: 1;
	forkEntryId: string;
	branchName: string;
	siblings?: { name: string; reason: string }[];
}

/**
 * Append-only metadata shared by the ctree/range-compact marker and the
 * ctree/range-tail custom message. Unknown fields are allowed so a v1 reader
 * does not reject additive schema changes.
 */
export const CtreeRangeCompactDataSchema = Type.Object(
	{
		v: Type.Literal(1),
		sourceLeafId: Type.String(),
		anchorId: Type.String(),
		startEntryId: Type.String(),
		endEntryId: Type.String(),
		selectedEntryIds: Type.Array(Type.String()),
		selectedEstTokens: Type.Number(),
		summaryEstTokens: Type.Number(),
		reclaimedEstTokens: Type.Number(),
		summaryModel: Type.String(),
		/** First eight hexadecimal characters of SHA-256(serialized selected source). */
		sourceSha8: Type.String(),
	},
	{ additionalProperties: true },
);

export type CtreeRangeCompactData = Static<typeof CtreeRangeCompactDataSchema>;

/** The visible range-tail message repeats the marker metadata in details. */
export type CtreeRangeTailDetails = CtreeRangeCompactData;

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

/** Recognize the operation marker without rejecting unknown schema versions. */
export function isCtreeRangeCompactEntry(e: SessionEntry): e is CustomEntry {
	return isCustomEntry(e) && e.customType === CTREE_RANGE_COMPACT;
}

/** Recognize the visible range-tail message without rejecting unknown schema versions. */
export function isCtreeRangeTailEntry(e: SessionEntry): e is CustomMessageEntry {
	return isCustomMessageEntry(e) && e.customType === CTREE_RANGE_TAIL;
}

/** Known v1 data for a marker; later versions remain preserved on the entry. */
export function ctreeRangeCompactData(e: SessionEntry): CtreeRangeCompactData | undefined {
	if (!isCtreeRangeCompactEntry(e)) return undefined;
	return Value.Check(CtreeRangeCompactDataSchema, e.data) ? e.data : undefined;
}

/** Known v1 details for a visible tail; later versions remain preserved on the entry. */
export function ctreeRangeTailDetails(e: SessionEntry): CtreeRangeTailDetails | undefined {
	if (!isCtreeRangeTailEntry(e)) return undefined;
	return Value.Check(CtreeRangeCompactDataSchema, e.details) ? e.details : undefined;
}

export function ctreeForkData(e: SessionEntry): CtreeForkData | undefined {
	if (!isCustomEntry(e) || e.customType !== CTREE_FORK) return undefined;
	const d = e.data as CtreeForkData | undefined;
	return d && d.v === 1 && typeof d.name === "string" ? d : undefined;
}

export function ctreeCloseData(e: SessionEntry): CtreeCloseData | undefined {
	if (!isCustomEntry(e) || e.customType !== CTREE_CLOSE) return undefined;
	const d = e.data as CtreeCloseData | undefined;
	return d && d.v === 1 && typeof d.forkEntryId === "string" ? d : undefined;
}
