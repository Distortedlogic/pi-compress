import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
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
	it("keeps public names stable", () => {
		assert.deepEqual(
			{
				fork: CTREE_FORK,
				close: CTREE_CLOSE,
				decision: CTREE_DECISION,
				crop: CTREE_CROP,
				cropTail: CTREE_CROP_TAIL,
				range: CTREE_RANGE_COMPACT,
				rangeTail: CTREE_RANGE_TAIL,
				batchMarker: COMPRESSION_ENTRY,
				queuedTask: QUEUED_TASK_TAIL,
				batchSummary: COMPRESSION_TAIL,
				legacyBatchMarker: LEGACY_COMPRESSION_ENTRY,
			},
			{
				fork: "ctree/fork",
				close: "ctree/close",
				decision: "ctree/decision",
				crop: "ctree/crop",
				cropTail: "ctree/crop-tail",
				range: "ctree/range-compact",
				rangeTail: "ctree/range-tail",
				batchMarker: "pi-compress/compression",
				queuedTask: "pi-compress/queued-task",
				batchSummary: "pi-compress/summary",
				legacyBatchMarker: "pi-workstream/compression",
			},
		);
	});
});

describe("stored entry readers", () => {
	it("accepts additive fields for known stored versions", () => {
		assert.equal(ctreeForkData(custom(CTREE_FORK, { ...fork, added: true }))?.name, "branch");
		assert.equal(ctreeCloseData(custom(CTREE_CLOSE, { ...close, added: true }))?.status, "squashed");
		assert.equal(ctreeCropData(custom(CTREE_CROP, { ...crop, added: true }))?.sourceLeafId, "leaf");
		assert.equal(ctreeCropTailDetails(customMessage(CTREE_CROP_TAIL, { ...crop, added: true }))?.v, 1);
		assert.equal(
			ctreeDecisionDetails(customMessage(CTREE_DECISION, { ...decision, added: true }))?.branchName,
			"branch",
		);
		assert.equal(ctreeRangeCompactData(custom(CTREE_RANGE_COMPACT, { ...range, added: true }))?.sourceSha8, "12345678");
		assert.equal(
			ctreeRangeTailDetails(customMessage(CTREE_RANGE_TAIL, { ...range, added: true }))?.summaryModel,
			"anthropic/opus",
		);
	});

	it("rejects unknown stored versions", () => {
		assert.equal(ctreeForkData(custom(CTREE_FORK, { ...fork, v: 2 })), undefined);
		assert.equal(ctreeCloseData(custom(CTREE_CLOSE, { ...close, v: 2 })), undefined);
		assert.equal(ctreeCropData(custom(CTREE_CROP, { ...crop, v: 2 })), undefined);
		assert.equal(ctreeRangeCompactData(custom(CTREE_RANGE_COMPACT, { ...range, v: 2 })), undefined);
		assert.equal(parseCtreeDecisionDetails({ ...decision, v: 2 }), undefined);
	});

	it("validates decision details outside a session entry", () => {
		assert.deepEqual(parseCtreeDecisionDetails(decision), decision);
	});
});

describe("batch compatibility readers", () => {
	it("reads current and legacy batch markers and tails", () => {
		assert.deepEqual(compressionDetails(custom(COMPRESSION_ENTRY, compression)), compression);
		assert.deepEqual(compressionDetails(custom(LEGACY_COMPRESSION_ENTRY, compression)), compression);
		assert.deepEqual(compressionTailDetails(customMessage(QUEUED_TASK_TAIL, compression)), compression);
		assert.deepEqual(compressionTailDetails(customMessage(COMPRESSION_TAIL, compression)), compression);
	});

	it("rejects malformed and unrelated compression data", () => {
		assert.equal(compressionDetails(custom(COMPRESSION_ENTRY, { ...compression, sourceSha256: "bad" })), undefined);
		assert.equal(compressionDetails(custom("other", compression)), undefined);
	});
});
