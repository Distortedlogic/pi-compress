import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	BatchSnapshotSchema,
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
	CTREE_CLOSE,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_FORK,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	CompressionDetailsSchema,
	LEGACY_COMPRESSION_ENTRY,
	QUEUED_TASK_TAIL,
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	RangeCompressionRequestSchema,
	RangeCompressionResultSchema,
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
		["range request", RANGE_COMPRESSION_REQUEST, "pi-compress/v1/range/request"],
		["range result", RANGE_COMPRESSION_RESULT, "pi-compress/v1/range/result"],
		["batch marker", COMPRESSION_ENTRY, "pi-compress/compression"],
		["queued task", QUEUED_TASK_TAIL, "pi-compress/queued-task"],
		["batch summary", COMPRESSION_TAIL, "pi-compress/summary"],
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

describe("batch persistence schemas", () => {
	it("keeps snapshots and compression details exact", () => {
		expect(Value.Check(BatchSnapshotSchema, batch)).toBe(true);
		expect(Value.Check(CompressionDetailsSchema, compression)).toBe(true);
		expect(Value.Check(BatchSnapshotSchema, { ...batch, extra: true })).toBe(false);
		expect(Value.Check(CompressionDetailsSchema, { ...compression, extra: true })).toBe(false);
	});
});

describe("generic range event schemas", () => {
	const prepare = {
		v: 1 as const,
		requestId: "request",
		sessionId: "session",
		operationId: "operation",
		action: "prepare" as const,
		startEntryId: "start",
		endEntryId: "end",
		review: false,
	};
	const resultBase = {
		v: 1 as const,
		requestId: "request",
		sessionId: "session",
		operationId: "operation",
	};

	it("requires an exact prepare request with an explicit review choice", () => {
		expect(Value.Check(RangeCompressionRequestSchema, prepare)).toBe(true);
		expect(
			Value.Check(RangeCompressionRequestSchema, {
				...prepare,
				anchorEntryId: "anchor",
				instructions: "keep errors",
			}),
		).toBe(true);
		expect(Value.Check(RangeCompressionRequestSchema, { ...prepare, review: undefined })).toBe(false);
		expect(Value.Check(RangeCompressionRequestSchema, { ...prepare, extra: true })).toBe(false);
	});

	it.each(["apply", "cancel", "status"] as const)("requires an exact %s request", (action) => {
		const request = { ...resultBase, action };
		expect(Value.Check(RangeCompressionRequestSchema, request)).toBe(true);
		expect(Value.Check(RangeCompressionRequestSchema, { ...request, startEntryId: "start" })).toBe(false);
	});

	it("accepts only status-specific exact results", () => {
		for (const status of ["prepared", "cancelled", "missing"] as const) {
			expect(Value.Check(RangeCompressionResultSchema, { ...resultBase, status })).toBe(true);
		}
		expect(
			Value.Check(RangeCompressionResultSchema, {
				...resultBase,
				status: "applied",
				details: { ...range, operationId: "operation" },
			}),
		).toBe(true);
		for (const code of [
			"invalid_request",
			"operation_conflict",
			"session_changed",
			"compression_failed",
			"not_prepared",
			"busy",
		] as const) {
			expect(Value.Check(RangeCompressionResultSchema, { ...resultBase, status: "failed", code })).toBe(true);
		}
	});

	it.each([
		{ status: "applied" },
		{ status: "prepared", details: range },
		{ status: "failed" },
		{ status: "missing", code: "busy" },
		{ status: "prepared", extra: true },
	])("rejects an invalid generic result %#", (value) => {
		expect(Value.Check(RangeCompressionResultSchema, { ...resultBase, ...value })).toBe(false);
	});
});
