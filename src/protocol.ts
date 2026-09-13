import type {
	CustomEntry,
	CustomMessageEntry,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const exact = { additionalProperties: false } as const;
const stored = { additionalProperties: true } as const;
const Id = Type.String({ minLength: 1 });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const CTREE_FORK = "ctree/fork";
export const CTREE_CLOSE = "ctree/close";
export const CTREE_DECISION = "ctree/decision";
export const CTREE_CROP = "ctree/crop";
export const CTREE_CROP_TAIL = "ctree/crop-tail";
export const CTREE_RANGE_COMPACT = "ctree/range-compact";
export const CTREE_RANGE_TAIL = "ctree/range-tail";
export const RANGE_COMPRESSION_REQUEST = "pi-context-compress/v1/range/request";
export const RANGE_COMPRESSION_RESULT = "pi-context-compress/v1/range/result";

export const CtreeCloseStatusSchema = Type.Union([
	Type.Literal("squashed"),
	Type.Literal("rejected"),
	Type.Literal("discarded"),
]);
export type CtreeCloseStatus = Static<typeof CtreeCloseStatusSchema>;

export const CtreeForkDataSchema = Type.Object(
	{
		v: Type.Literal(1),
		name: Type.String(),
		parentEntryId: Type.Union([Type.String(), Type.Null()]),
		trunkModel: Type.Optional(Type.String()),
		branchModel: Type.Optional(Type.String()),
		createdAt: Type.Number(),
		status: Type.Literal("open"),
	},
	stored,
);
export type CtreeForkData = Static<typeof CtreeForkDataSchema>;

export const CtreeCloseDataSchema = Type.Object(
	{
		v: Type.Literal(1),
		forkEntryId: Type.String(),
		status: CtreeCloseStatusSchema,
		decisionEntryId: Type.Optional(Type.String()),
		note: Type.Optional(Type.String()),
		prevLeafId: Type.Optional(Type.String()),
	},
	stored,
);
export type CtreeCloseData = Static<typeof CtreeCloseDataSchema>;

export const CtreeCropStubSchema = Type.Object(
	{
		entryId: Type.String(),
		tool: Type.String(),
		arg: Type.Optional(Type.String()),
		estTokens: Type.Number(),
		sha8: Type.String(),
	},
	stored,
);
export type CtreeCropStub = Static<typeof CtreeCropStubSchema>;

export const CtreeCropDropSchema = Type.Object(
	{
		userId: Type.String(),
		entryIds: Type.Array(Type.String()),
		label: Type.String(),
		estTokens: Type.Number(),
		sha8: Type.String(),
	},
	stored,
);
export type CtreeCropDrop = Static<typeof CtreeCropDropSchema>;

export const CtreeCropDataSchema = Type.Object(
	{
		v: Type.Literal(1),
		sourceLeafId: Type.String(),
		stubbed: Type.Array(CtreeCropStubSchema),
		dropped: Type.Optional(Type.Array(CtreeCropDropSchema)),
	},
	stored,
);
export type CtreeCropData = Static<typeof CtreeCropDataSchema>;

export const CtreeDecisionSiblingSchema = Type.Object(
	{
		name: Type.String(),
		reason: Type.String(),
	},
	stored,
);

export const CtreeDecisionDetailsSchema = Type.Object(
	{
		v: Type.Literal(1),
		forkEntryId: Type.String(),
		branchName: Type.String(),
		siblings: Type.Optional(Type.Array(CtreeDecisionSiblingSchema)),
	},
	stored,
);
export type CtreeDecisionDetails = Static<typeof CtreeDecisionDetailsSchema>;

export const CtreeRangeCompactDataSchema = Type.Object(
	{
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
	},
	stored,
);
export type CtreeRangeCompactData = Static<typeof CtreeRangeCompactDataSchema>;
export type CtreeRangeTailDetails = CtreeRangeCompactData;

export const RangeCompressionStatusSchema = Type.Union([
	Type.Literal("prepared"),
	Type.Literal("applied"),
	Type.Literal("cancelled"),
	Type.Literal("missing"),
	Type.Literal("failed"),
]);
export type RangeCompressionStatus = Static<typeof RangeCompressionStatusSchema>;

export const RangeCompressionFailureCodeSchema = Type.Union([
	Type.Literal("invalid_request"),
	Type.Literal("operation_conflict"),
	Type.Literal("session_changed"),
	Type.Literal("compression_failed"),
	Type.Literal("not_prepared"),
	Type.Literal("busy"),
]);
export type RangeCompressionFailureCode = Static<typeof RangeCompressionFailureCodeSchema>;

export const RangeCompressionRequestSchema = Type.Union([
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			action: Type.Literal("prepare"),
			startEntryId: Id,
			endEntryId: Id,
			review: Type.Boolean(),
			anchorEntryId: Type.Optional(Id),
			instructions: Type.Optional(Type.String()),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			action: Type.Literal("apply"),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			action: Type.Literal("cancel"),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			action: Type.Literal("status"),
		},
		exact,
	),
]);
export type RangeCompressionRequest = Static<typeof RangeCompressionRequestSchema>;
export type RangeCompressionPrepareRequest = Extract<RangeCompressionRequest, { action: "prepare" }>;
export type RangeCompressionApplyRequest = Extract<RangeCompressionRequest, { action: "apply" }>;
export type RangeCompressionCancelRequest = Extract<RangeCompressionRequest, { action: "cancel" }>;
export type RangeCompressionStatusRequest = Extract<RangeCompressionRequest, { action: "status" }>;

export const RangeCompressionResultSchema = Type.Union([
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			status: Type.Literal("prepared"),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			status: Type.Literal("applied"),
			details: CtreeRangeCompactDataSchema,
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			status: Type.Literal("cancelled"),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			status: Type.Literal("missing"),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(1),
			requestId: Id,
			sessionId: Id,
			operationId: Id,
			status: Type.Literal("failed"),
			code: RangeCompressionFailureCodeSchema,
		},
		exact,
	),
]);
export type RangeCompressionResult = Static<typeof RangeCompressionResultSchema>;
export type RangeCompressionPreparedResult = Extract<RangeCompressionResult, { status: "prepared" }>;
export type RangeCompressionAppliedResult = Extract<RangeCompressionResult, { status: "applied" }>;
export type RangeCompressionCancelledResult = Extract<RangeCompressionResult, { status: "cancelled" }>;
export type RangeCompressionMissingResult = Extract<RangeCompressionResult, { status: "missing" }>;
export type RangeCompressionFailedResult = Extract<RangeCompressionResult, { status: "failed" }>;

export interface RangeCompressionTransport {
	request: RangeCompressionRequest;
	context: ExtensionCommandContext;
}

export const COMPRESSION_REQUEST = "pi-context-compress/v1/request";
export const COMPRESSION_RESULT = "pi-context-compress/v1/result";
export const COMPRESSION_ENTRY = "pi-context-compress/compression";
export const QUEUED_TASK_TAIL = "pi-context-compress/queued-task";
export const COMPRESSION_TAIL = "pi-context-compress/summary";
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

export const CompressionRequestSchema = Type.Object(
	{
		v: Type.Literal(1),
		requestId: Id,
		sessionId: Id,
		operationId: Id,
		runId: Id,
		action: Type.Union([
			Type.Literal("prepare"),
			Type.Literal("apply"),
			Type.Literal("cancel"),
			Type.Literal("status"),
		]),
		batch: BatchSnapshotSchema,
		anchorEntryId: Type.Optional(Id),
		lastSettledEntryId: Type.Optional(Id),
		review: Type.Optional(Type.Boolean()),
	},
	exact,
);
export type CompressionRequest = Static<typeof CompressionRequestSchema>;

export const CompressionResultSchema = Type.Object(
	{
		v: Type.Literal(1),
		requestId: Id,
		sessionId: Id,
		operationId: Id,
		status: Type.Union([
			Type.Literal("prepared"),
			Type.Literal("applied"),
			Type.Literal("cancelled"),
			Type.Literal("missing"),
			Type.Literal("failed"),
		]),
		details: Type.Optional(CompressionDetailsSchema),
		code: Type.Optional(
			Type.Union([
				Type.Literal("invalid_request"),
				Type.Literal("operation_conflict"),
				Type.Literal("session_changed"),
				Type.Literal("compression_failed"),
				Type.Literal("not_prepared"),
				Type.Literal("busy"),
			]),
		),
	},
	exact,
);
export type CompressionResult = Static<typeof CompressionResultSchema>;

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
