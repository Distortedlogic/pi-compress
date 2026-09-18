import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	BatchSnapshotSchema,
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
	CompressionDetailsSchema,
	CTREE_CLOSE,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_FORK,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	compressionDetails,
	compressionTailDetails,
	ctreeCloseData,
	ctreeCropData,
	ctreeCropTailDetails,
	ctreeDecisionDetails,
	ctreeForkData,
	ctreeRangeCompactData,
	ctreeRangeTailDetails,
	LEGACY_COMPRESSION_ENTRY,
	parseCtreeDecisionDetails,
	QUEUED_TASK_TAIL,
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	RangeCompressionRequestSchema,
	RangeCompressionResultSchema,
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
	for (const [name, actual, expected] of [
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
	] as const) {
		it(`keeps ${name} stable`, () => {
			assert.equal(actual, expected);
		});
	}
});

describe("stored entry readers", () => {
	for (const [name, read, expected] of [
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
	] as const) {
		it(`validates ${name} and permits additive stored fields`, () => {
			assert.equal(read(), expected);
		});
	}

	for (const [read, entry] of [
		[ctreeForkData, custom(CTREE_FORK, { ...fork, v: 2 })],
		[ctreeCloseData, custom(CTREE_CLOSE, { ...close, v: 2 })],
		[ctreeCropData, custom(CTREE_CROP, { ...crop, v: 2 })],
		[ctreeRangeCompactData, custom(CTREE_RANGE_COMPACT, { ...range, v: 2 })],
	] as const) {
		it("rejects unknown stored versions", () => {
			assert.equal(read(entry), undefined);
		});
	}

	it("validates decision details supplied outside a session entry", () => {
		assert.deepEqual(parseCtreeDecisionDetails(decision), decision);
		assert.equal(parseCtreeDecisionDetails({ ...decision, v: 2 }), undefined);
	});
});

describe("batch compatibility readers", () => {
	for (const customType of [COMPRESSION_ENTRY, LEGACY_COMPRESSION_ENTRY]) {
		it(`reads marker ${customType}`, () => {
			assert.deepEqual(compressionDetails(custom(customType, compression)), compression);
		});
	}

	for (const customType of [QUEUED_TASK_TAIL, COMPRESSION_TAIL]) {
		it(`reads tail ${customType}`, () => {
			assert.deepEqual(compressionTailDetails(customMessage(customType, compression)), compression);
		});
	}

	it("rejects malformed and unrelated compression data", () => {
		assert.equal(compressionDetails(custom(COMPRESSION_ENTRY, { ...compression, sourceSha256: "bad" })), undefined);
		assert.equal(compressionDetails(custom("other", compression)), undefined);
	});
});

describe("batch persistence schemas", () => {
	it("keeps snapshots and compression details exact", () => {
		assert.equal(Value.Check(BatchSnapshotSchema, batch), true);
		assert.equal(Value.Check(CompressionDetailsSchema, compression), true);
		assert.equal(Value.Check(BatchSnapshotSchema, { ...batch, extra: true }), false);
		assert.equal(Value.Check(CompressionDetailsSchema, { ...compression, extra: true }), false);
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
		assert.equal(Value.Check(RangeCompressionRequestSchema, prepare), true);
		assert.equal(
			Value.Check(RangeCompressionRequestSchema, {
				...prepare,
				anchorEntryId: "anchor",
				instructions: "keep errors",
			}),
			true,
		);
		assert.equal(Value.Check(RangeCompressionRequestSchema, { ...prepare, review: undefined }), false);
		assert.equal(Value.Check(RangeCompressionRequestSchema, { ...prepare, extra: true }), false);
	});

	for (const action of ["apply", "cancel", "status"] as const) {
		it(`requires an exact ${action} request`, () => {
			const request = { ...resultBase, action };
			assert.equal(Value.Check(RangeCompressionRequestSchema, request), true);
			assert.equal(Value.Check(RangeCompressionRequestSchema, { ...request, startEntryId: "start" }), false);
		});
	}

	it("accepts only status-specific exact results", () => {
		for (const status of ["prepared", "cancelled", "missing"] as const) {
			assert.equal(Value.Check(RangeCompressionResultSchema, { ...resultBase, status }), true);
		}
		assert.equal(
			Value.Check(RangeCompressionResultSchema, {
				...resultBase,
				status: "applied",
				details: { ...range, operationId: "operation" },
			}),
			true,
		);
		for (const code of [
			"invalid_request",
			"operation_conflict",
			"session_changed",
			"compression_failed",
			"not_prepared",
			"busy",
		] as const) {
			assert.equal(Value.Check(RangeCompressionResultSchema, { ...resultBase, status: "failed", code }), true);
		}
	});

	for (const [index, value] of [
		{ status: "applied" },
		{ status: "prepared", details: range },
		{ status: "failed" },
		{ status: "missing", code: "busy" },
		{ status: "prepared", extra: true },
	].entries()) {
		it(`rejects invalid generic result ${index + 1}`, () => {
			assert.equal(Value.Check(RangeCompressionResultSchema, { ...resultBase, ...value }), false);
		});
	}
});
