import type { CustomEntry, CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const exact = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1 });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const CTREE_FORK = "ctree/fork";
export const CTREE_CLOSE = "ctree/close";
export const CTREE_DECISION = "ctree/decision";
export const CTREE_CROP = "ctree/crop";
export const CTREE_CROP_TAIL = "ctree/crop-tail";
export const CTREE_RANGE_COMPACT = "ctree/range-compact";
export const CTREE_RANGE_TAIL = "ctree/range-tail";

export const CtreeCloseStatusSchema = Type.Union([
	Type.Literal("squashed"),
	Type.Literal("rejected"),
	Type.Literal("discarded"),
]);
export type CtreeCloseStatus = Static<typeof CtreeCloseStatusSchema>;

export const CtreeForkDataSchema = Type.Object({
	v: Type.Literal(1),
	name: Type.String(),
	parentEntryId: Type.Union([Type.String(), Type.Null()]),
	trunkModel: Type.Optional(Type.String()),
	branchModel: Type.Optional(Type.String()),
	createdAt: Type.Number(),
	status: Type.Literal("open"),
});
export type CtreeForkData = Static<typeof CtreeForkDataSchema>;

export const CtreeCloseDataSchema = Type.Object({
	v: Type.Literal(1),
	forkEntryId: Type.String(),
	status: CtreeCloseStatusSchema,
	decisionEntryId: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	prevLeafId: Type.Optional(Type.String()),
});
export type CtreeCloseData = Static<typeof CtreeCloseDataSchema>;

export const CtreeCropStubSchema = Type.Object({
	entryId: Type.String(),
	tool: Type.String(),
	arg: Type.Optional(Type.String()),
	estTokens: Type.Number(),
	sha8: Type.String(),
});
export type CtreeCropStub = Static<typeof CtreeCropStubSchema>;

export const CtreeCropDropSchema = Type.Object({
	userId: Type.String(),
	entryIds: Type.Array(Type.String()),
	label: Type.String(),
	estTokens: Type.Number(),
	sha8: Type.String(),
});
export type CtreeCropDrop = Static<typeof CtreeCropDropSchema>;

export const CtreeCropDataSchema = Type.Object({
	v: Type.Literal(1),
	sourceLeafId: Type.String(),
	stubbed: Type.Array(CtreeCropStubSchema),
	dropped: Type.Optional(Type.Array(CtreeCropDropSchema)),
});
export type CtreeCropData = Static<typeof CtreeCropDataSchema>;

export const CtreeDecisionSiblingSchema = Type.Object({
	name: Type.String(),
	reason: Type.String(),
});

export const CtreeDecisionDetailsSchema = Type.Object({
	v: Type.Literal(1),
	forkEntryId: Type.String(),
	branchName: Type.String(),
	siblings: Type.Optional(Type.Array(CtreeDecisionSiblingSchema)),
});
export type CtreeDecisionDetails = Static<typeof CtreeDecisionDetailsSchema>;

export const CtreeRangeCompactDataSchema = Type.Object({
	v: Type.Literal(1),
	operationId: Type.Optional(Type.String()),
	sourceLeafId: Type.String(),
	anchorId: Type.String(),
	startEntryId: Type.String(),
	endEntryId: Type.String(),
	selectedEntryIds: Type.Array(Type.String()),
	selectedEstTokens: Type.Number(),
	summaryEstTokens: Type.Number(),
	reclaimedEstTokens: Type.Number(),
	summaryModel: Type.String(),
	sourceSha8: Type.String(),
});
export type CtreeRangeCompactData = Static<typeof CtreeRangeCompactDataSchema>;
export type CtreeRangeTailDetails = CtreeRangeCompactData;

export const COMPRESSION_ENTRY = "pi-compress/compression";
export const QUEUED_TASK_TAIL = "pi-compress/queued-task";
export const COMPRESSION_TAIL = "pi-compress/summary";
export const LEGACY_COMPRESSION_ENTRY = "pi-workstream/compression";

export const BatchSnapshotSchema = Type.Object(
	{
		planId: Hash,
		batchId: Hash,
		structuralRevision: Hash,
		fileRevision: Hash,
		bitmap: Type.Array(Type.Boolean()),
	},
	exact,
);
export type BatchSnapshot = Static<typeof BatchSnapshotSchema>;

export const CompressionDetailsSchema = Type.Object(
	{
		v: Type.Literal(2),
		runId: Id,
		planId: Hash,
		batchId: Hash,
		operationId: Id,
		structuralRevision: Hash,
		fileRevision: Hash,
		preCompletionBitmap: Type.Array(Type.Boolean()),
		sourceLeafId: Id,
		preTaskAnchorId: Id,
		taskMessageEntryId: Id,
		startEntryId: Id,
		endEntryId: Id,
		selectedEntryIds: Type.Array(Id),
		sourceSha256: Hash,
	},
	exact,
);
export type CompressionDetails = Static<typeof CompressionDetailsSchema>;

function isCustomEntry(entry: SessionEntry, customType: string): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === customType;
}

function isCustomMessageEntry(entry: SessionEntry, customType: string): entry is CustomMessageEntry {
	return entry.type === "custom_message" && entry.customType === customType;
}

export function ctreeForkData(entry: SessionEntry): CtreeForkData | undefined {
	return isCustomEntry(entry, CTREE_FORK) && Value.Check(CtreeForkDataSchema, entry.data) ? entry.data : undefined;
}

export function ctreeCloseData(entry: SessionEntry): CtreeCloseData | undefined {
	return isCustomEntry(entry, CTREE_CLOSE) && Value.Check(CtreeCloseDataSchema, entry.data) ? entry.data : undefined;
}

export function ctreeCropData(entry: SessionEntry): CtreeCropData | undefined {
	return isCustomEntry(entry, CTREE_CROP) && Value.Check(CtreeCropDataSchema, entry.data) ? entry.data : undefined;
}

export function ctreeCropTailDetails(entry: SessionEntry): CtreeCropData | undefined {
	return isCustomMessageEntry(entry, CTREE_CROP_TAIL) && Value.Check(CtreeCropDataSchema, entry.details)
		? entry.details
		: undefined;
}

export function parseCtreeDecisionDetails(value: unknown): CtreeDecisionDetails | undefined {
	return Value.Check(CtreeDecisionDetailsSchema, value) ? value : undefined;
}

export function ctreeDecisionDetails(entry: SessionEntry): CtreeDecisionDetails | undefined {
	return isCustomMessageEntry(entry, CTREE_DECISION) ? parseCtreeDecisionDetails(entry.details) : undefined;
}

export function isCtreeRangeCompactEntry(entry: SessionEntry): entry is CustomEntry {
	return isCustomEntry(entry, CTREE_RANGE_COMPACT);
}

export function isCtreeRangeTailEntry(entry: SessionEntry): entry is CustomMessageEntry {
	return isCustomMessageEntry(entry, CTREE_RANGE_TAIL);
}

export function ctreeRangeCompactData(entry: SessionEntry): CtreeRangeCompactData | undefined {
	return isCtreeRangeCompactEntry(entry) && Value.Check(CtreeRangeCompactDataSchema, entry.data)
		? entry.data
		: undefined;
}

export function ctreeRangeTailDetails(entry: SessionEntry): CtreeRangeTailDetails | undefined {
	return isCtreeRangeTailEntry(entry) && Value.Check(CtreeRangeCompactDataSchema, entry.details)
		? entry.details
		: undefined;
}

export function compressionDetails(entry: SessionEntry): CompressionDetails | undefined {
	if (!isCustomEntry(entry, COMPRESSION_ENTRY) && !isCustomEntry(entry, LEGACY_COMPRESSION_ENTRY)) {
		return undefined;
	}
	return Value.Check(CompressionDetailsSchema, entry.data) ? entry.data : undefined;
}

export function compressionTailDetails(entry: SessionEntry): CompressionDetails | undefined {
	if (!isCustomMessageEntry(entry, QUEUED_TASK_TAIL) && !isCustomMessageEntry(entry, COMPRESSION_TAIL)) {
		return undefined;
	}
	return Value.Check(CompressionDetailsSchema, entry.details) ? entry.details : undefined;
}
