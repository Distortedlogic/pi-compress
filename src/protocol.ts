import { type Static, Type } from "typebox";

export const COMPRESSION_REQUEST = "pi-context-compress/v1/request";
export const COMPRESSION_RESULT = "pi-context-compress/v1/result";
export const COMPRESSION_ENTRY = "pi-context-compress/compression";
export const QUEUED_TASK_TAIL = "pi-context-compress/queued-task";
export const COMPRESSION_TAIL = "pi-context-compress/summary";
const exact = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1 });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });

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
