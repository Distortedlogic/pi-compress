import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	BatchSnapshotSchema,
	COMPRESSION_ENTRY,
	COMPRESSION_REQUEST,
	COMPRESSION_RESULT,
	COMPRESSION_TAIL,
	CTREE_CLOSE,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_FORK,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	CompressionDetailsSchema,
	CompressionRequestSchema,
	CompressionResultSchema,
	LEGACY_COMPRESSION_ENTRY,
	QUEUED_TASK_TAIL,
	compressionDetails,
	compressionTailDetails,
	ctreeCloseData,
	ctreeCropData,
	ctreeCropTailDetails,
	ctreeDecisionDetails,
	ctreeForkData,
	ctreeRangeCompactData,
	ctreeRangeTailDetails,
	parseCtreeDecisionDetails,
} from "../src/protocol.ts";

const HASH = "a".repeat(64);
const timestamp = "2026-06-12T00:00:00.000Z";
const base = { id: "entry", parentId: null, timestamp };

function custom(customType: string, data: unknown): SessionEntry {
	return { ...base, type: "custom", customType, data } as SessionEntry;
}

function customMessage(customType: string, details: unknown): SessionEntry {
	return { ...base, type: "custom_message", customType, content: "text", display: true, details } as SessionEntry;
}

const fork = {
	v: 1 as const,
	name: "branch",
	parentEntryId: "parent",
	trunkModel: "anthropic/opus",
	createdAt: 1,
	status: "open" as const,
};
const close = { v: 1 as const, forkEntryId: "fork", status: "squashed" as const, prevLeafId: "leaf" };
const crop = {
	v: 1 as const,
	sourceLeafId: "leaf",
	stubbed: [{ entryId: "result", tool: "read", estTokens: 10, sha8: "12345678" }],
};
const decision = { v: 1 as const, forkEntryId: "fork", branchName: "branch" };
const range = {
	v: 1 as const,
	sourceLeafId: "leaf",
	anchorId: "anchor",
	startEntryId: "start",
	endEntryId: "end",
	selectedEntryIds: ["start", "end"],
	selectedEstTokens: 100,
	summaryEstTokens: 20,
	reclaimedEstTokens: 80,
	summaryModel: "anthropic/opus",
	sourceSha8: "12345678",
};
const batch = {
	planId: HASH,
	batchId: HASH,
	structuralRevision: HASH,
	fileRevision: HASH,
	bitmap: [false, true],
};
const compression = {
	v: 2 as const,
	runId: "run",
	planId: HASH,
	batchId: HASH,
	operationId: "operation",
	structuralRevision: HASH,
	fileRevision: HASH,
	preCompletionBitmap: [false, true],
	sourceLeafId: "leaf",
	preTaskAnchorId: "anchor",
	taskMessageEntryId: "task",
	startEntryId: "start",
	endEntryId: "end",
	selectedEntryIds: ["start", "end"],
	sourceSha256: HASH,
};

describe("durable protocol names", () => {
	it.each([
		["fork", CTREE_FORK, "ctree/fork"],
		["close", CTREE_CLOSE, "ctree/close"],
		["decision", CTREE_DECISION, "ctree/decision"],
		["crop", CTREE_CROP, "ctree/crop"],
		["crop tail", CTREE_CROP_TAIL, "ctree/crop-tail"],
		["range", CTREE_RANGE_COMPACT, "ctree/range-compact"],
		["range tail", CTREE_RANGE_TAIL, "ctree/range-tail"],
		["request", COMPRESSION_REQUEST, "pi-context-compress/v1/request"],
		["result", COMPRESSION_RESULT, "pi-context-compress/v1/result"],
		["batch marker", COMPRESSION_ENTRY, "pi-context-compress/compression"],
		["queued task", QUEUED_TASK_TAIL, "pi-context-compress/queued-task"],
		["batch summary", COMPRESSION_TAIL, "pi-context-compress/summary"],
		["legacy batch marker", LEGACY_COMPRESSION_ENTRY, "pi-workstream/compression"],
	])("keeps %s stable", (_name, actual, expected) => {
		expect(actual).toBe(expected);
	});
});

describe("stored entry readers", () => {
	it.each([
		["fork", () => ctreeForkData(custom(CTREE_FORK, { ...fork, added: true }))?.name, "branch"],
		["close", () => ctreeCloseData(custom(CTREE_CLOSE, { ...close, added: true }))?.status, "squashed"],
		["crop", () => ctreeCropData(custom(CTREE_CROP, { ...crop, added: true }))?.sourceLeafId, "leaf"],
		["crop tail", () => ctreeCropTailDetails(customMessage(CTREE_CROP_TAIL, { ...crop, added: true }))?.v, 1],
		[
			"decision",
			() => ctreeDecisionDetails(customMessage(CTREE_DECISION, { ...decision, added: true }))?.branchName,
			"branch",
		],
		[
			"range",
			() => ctreeRangeCompactData(custom(CTREE_RANGE_COMPACT, { ...range, added: true }))?.sourceSha8,
			"12345678",
		],
		[
			"range tail",
			() => ctreeRangeTailDetails(customMessage(CTREE_RANGE_TAIL, { ...range, added: true }))?.summaryModel,
			"anthropic/opus",
		],
	])("validates %s and permits additive stored fields", (_name, read, expected) => {
		expect(read()).toBe(expected);
	});

	it.each([
		[ctreeForkData, custom(CTREE_FORK, { ...fork, v: 2 })],
		[ctreeCloseData, custom(CTREE_CLOSE, { ...close, v: 2 })],
		[ctreeCropData, custom(CTREE_CROP, { ...crop, v: 2 })],
		[ctreeRangeCompactData, custom(CTREE_RANGE_COMPACT, { ...range, v: 2 })],
	])("rejects unknown stored versions", (read, entry) => {
		expect(read(entry)).toBeUndefined();
	});

	it("validates decision details supplied outside a session entry", () => {
		expect(parseCtreeDecisionDetails(decision)).toEqual(decision);
		expect(parseCtreeDecisionDetails({ ...decision, v: 2 })).toBeUndefined();
	});
});

describe("batch compatibility readers", () => {
	it.each([COMPRESSION_ENTRY, LEGACY_COMPRESSION_ENTRY])("reads marker %s", (customType) => {
		expect(compressionDetails(custom(customType, compression))).toEqual(compression);
	});

	it.each([QUEUED_TASK_TAIL, COMPRESSION_TAIL])("reads tail %s", (customType) => {
		expect(compressionTailDetails(customMessage(customType, compression))).toEqual(compression);
	});

	it("rejects malformed and unrelated compression data", () => {
		expect(compressionDetails(custom(COMPRESSION_ENTRY, { ...compression, sourceSha256: "bad" }))).toBeUndefined();
		expect(compressionDetails(custom("other", compression))).toBeUndefined();
	});
});

describe("external event schemas", () => {
	const request = {
		v: 1 as const,
		requestId: "request",
		sessionId: "session",
		operationId: "operation",
		runId: "run",
		action: "prepare" as const,
		batch,
		anchorEntryId: "anchor",
		lastSettledEntryId: "leaf",
	};

	it("keeps batch, request, details, and result messages exact", () => {
		expect(Value.Check(BatchSnapshotSchema, batch)).toBe(true);
		expect(Value.Check(CompressionDetailsSchema, compression)).toBe(true);
		expect(Value.Check(CompressionRequestSchema, request)).toBe(true);
		expect(
			Value.Check(CompressionResultSchema, {
				v: 1,
				requestId: "request",
				sessionId: "session",
				operationId: "operation",
				status: "applied",
				details: compression,
			}),
		).toBe(true);
		for (const [schema, value] of [
			[BatchSnapshotSchema, { ...batch, extra: true }],
			[CompressionDetailsSchema, { ...compression, extra: true }],
			[CompressionRequestSchema, { ...request, extra: true }],
			[
				CompressionResultSchema,
				{ v: 1, requestId: "r", sessionId: "s", operationId: "o", status: "missing", extra: true },
			],
		] as const) {
			expect(Value.Check(schema, value)).toBe(false);
		}
	});

	it.each(["prepare", "apply", "cancel", "status"])("accepts request action %s", (action) => {
		expect(Value.Check(CompressionRequestSchema, { ...request, action })).toBe(true);
	});

	it.each(["prepared", "applied", "cancelled", "missing", "failed"])("accepts result status %s", (status) => {
		expect(
			Value.Check(CompressionResultSchema, {
				v: 1,
				requestId: "request",
				sessionId: "session",
				operationId: "operation",
				status,
			}),
		).toBe(true);
	});
});
