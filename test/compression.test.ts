import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { snapshotSession } from "../src/context.ts";
import { planCrop, planRemoveTurns, renderReconstruction } from "../src/crop.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	QUEUED_TASK_TAIL,
} from "../src/protocol.ts";
import {
	applyCompression,
	applyPreparedRangeCompression,
	type PreparedRangeCompression,
	prepareCompression,
	prepareRangeCompression,
	type RangeCompressionTarget,
	renderRangeTail,
	reviewRangeCompression,
} from "../src/range-compression.ts";
import { applyRewrite, candidateByEntryId, prepareRewrite, rangeCandidates, sourceSha8 } from "../src/rewrite.ts";
import { assistantResponse, extensionContext, MemorySession, mutationApi } from "./helpers.ts";

const HASH_A = "a".repeat(64);

function cropScenario() {
	const session = new MemorySession();
	session.user("audit tabs");
	session.assistant("anchor");
	const old = session.toolUse("chrome.snapshot", { url: "tab-audit" }, "A".repeat(80_000));
	session.assistant("analysis");
	session.toolUse("chrome.snapshot", { url: "after" }, "B".repeat(400));
	session.assistant("done");
	return { session, old, snapshot: snapshotSession(session.manager) };
}

describe("crop reconstruction", () => {
	it("stubs selected results, keeps continuation order, and preserves originals", () => {
		const { old, snapshot } = cropScenario();
		const plan = planCrop(snapshot, [old.result]);
		const rendered = renderReconstruction(plan);
		assert.equal(plan.startEntryId, old.call);
		assert.match(plan.stubs[0]?.sha8 ?? "", /^[a-f0-9]{8}$/);
		assert.ok(rendered.includes("[cropped: chrome.snapshot tab-audit"));
		assert.ok(rendered.includes("analysis"));
		assert.ok(!rendered.includes("A".repeat(200)));
		assert.ok(snapshot.entries.some((entry) => entry.id === old.result));
	});

	it("keeps scheduled prompt messages and the complete answer in one removable turn", () => {
		const session = new MemorySession();
		session.user("root");
		session.assistant("anchor");
		const user = session.user("inspect the file");
		const acknowledgement = session.manager.appendCustomMessageEntry("pi-prompts", "acknowledged", true);
		const assistantToolCall = session.assistant("", [
			{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "file.ts" } },
		]);
		const toolResult = session.toolResult("read", "contents", "call-read");
		const reminder = session.manager.appendCustomMessageEntry("pi-prompts", "review scope", false);
		const assistantResponse = session.assistant("done");

		const plan = planRemoveTurns(snapshotSession(session.manager), [user]);
		assert.deepEqual(plan.dropped[0]?.entryIds, [
			user,
			acknowledgement,
			assistantToolCall,
			toolResult,
			reminder,
			assistantResponse,
		]);
	});
});

describe("shared range safety", () => {
	it("keeps an assistant tool-call batch and all contiguous results atomic", () => {
		const session = new MemorySession();
		session.user("root");
		session.assistant("anchor");
		const call = session.assistant("", [
			{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
		]);
		const firstResult = session.toolResult("read", "a", "call-a");
		const secondResult = session.toolResult("read", "b", "call-b");
		const snapshot = snapshotSession(session.manager);
		const groups = candidateByEntryId(rangeCandidates(snapshot));
		assert.deepEqual(groups.get(call)?.entryIds, [call, firstResult, secondResult]);
		assert.equal(groups.get(secondResult)?.startEntryId, call);
		assert.throws(() => prepareRewrite(snapshot, firstResult, secondResult), /split a required tool-call group/);
	});

	it("protects session metadata, structural records, and incomplete message groups", () => {
		const session = new MemorySession();
		const root = session.user("root");
		const anchor = session.assistant("anchor");
		const metadata = session.manager.appendCustomEntry("metadata");
		const decision = session.decision();
		const orphan = session.toolResult("read", "orphan", "missing");
		const incompleteToolGroup = session.assistant("", [
			{ type: "toolCall", id: "unanswered", name: "read", arguments: { path: "x" } },
		]);
		const pending = session.user("pending");
		const groups = candidateByEntryId(rangeCandidates(snapshotSession(session.manager)));

		assert.equal(groups.get(root)?.protectReason, "no anchor before this message group");
		assert.equal(groups.get(metadata)?.protectReason, "context-inert session metadata");
		assert.equal(groups.get(decision)?.protectReason, "decision record");
		assert.equal(groups.get(orphan)?.protectReason, "tool result without its assistant tool call");
		assert.equal(groups.get(incompleteToolGroup)?.protectReason, "incomplete assistant tool-call group");
		assert.equal(groups.get(pending)?.protectReason, "incomplete current user turn");

		const structural = new MemorySession();
		structural.user("root");
		const structuralAnchor = structural.assistant("anchor");
		const summary = structural.manager.branchWithSummary(structuralAnchor, "summary");
		const structuralGroups = candidateByEntryId(rangeCandidates(snapshotSession(structural.manager)));
		assert.equal(structuralGroups.get(summary)?.protectReason, "structural context entry");
		assert.throws(() => prepareRewrite(snapshotSession(session.manager), anchor, pending), /protected/);
	});

	it("keeps complete selected source, a stable hash, and unchanged continuation", () => {
		const { old, snapshot } = cropScenario();
		const plan = prepareRewrite(snapshot, old.call, old.result);
		assert.ok(plan.source.includes("A".repeat(20_000)));
		assert.ok(!plan.source.includes("(truncated)"));
		assert.match(plan.sourceSha256, /^[a-f0-9]{64}$/);
		assert.equal(sourceSha8(plan), plan.sourceSha256.slice(0, 8));
		assert.equal(prepareRewrite(snapshot, old.call, old.result).sourceSha256, plan.sourceSha256);
		const rendered = renderRangeTail(plan, "approved summary");
		assert.ok(rendered.includes("approved summary"));
		assert.ok(rendered.includes("unchanged continuation"));
		assert.ok(!rendered.includes("A".repeat(200)));
	});
});

describe("shared rewrite apply", () => {
	function validWorld() {
		const scenario = cropScenario();
		const plan = prepareRewrite(scenario.snapshot, scenario.old.call, scenario.old.result);
		const entriesBefore = scenario.session.manager.getEntries().length;
		return {
			...scenario,
			plan,
			entriesBefore,
			ctx: extensionContext(scenario.session.manager),
			pi: mutationApi(scenario.session.manager),
		};
	}

	it("rejects stale source before navigation or writes", async () => {
		const world = validWorld();
		const selected = world.session.manager.getEntry(world.plan.endEntryId);
		if (!selected || selected.type !== "message" || selected.message.role !== "toolResult") {
			throw new Error("invalid rewrite fixture");
		}
		selected.message.content = [{ type: "text", text: "changed source" }];
		await assert.rejects(
			applyRewrite(world.pi, world.ctx, world.plan, {
				messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
				marker: { customType: CTREE_CROP, data: {} },
			}),
			/source changed/,
		);
		assert.equal(world.session.manager.getEntries().length, world.entriesBefore);
	});

	it("navigates without a summary, then appends replacements before the marker", async () => {
		const world = validWorld();
		const result = await applyRewrite(world.pi, world.ctx, world.plan, {
			messages: [{ customType: CTREE_CROP_TAIL, content: "replacement", display: true }],
			marker: { customType: CTREE_CROP, data: { sourceLeafId: world.plan.sourceLeafId } },
		});
		assert.equal(result, true);
		const branch = world.session.manager.getBranch();
		assert.deepEqual(
			branch.slice(-2).map((entry) => ("customType" in entry ? entry.customType : entry.type)),
			[CTREE_CROP_TAIL, CTREE_CROP],
		);
	});
});

describe("direct range compression API", () => {
	function directWorld(complete?: (...args: unknown[]) => Promise<AssistantMessage>) {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("anchor");
		const selected = session.assistant("selected");
		return {
			session,
			anchor,
			selected,
			ctx: extensionContext(session.manager, complete),
			pi: mutationApi(session.manager),
		};
	}

	it("prepares, reviews, and applies one readonly range value with the current model", async () => {
		let draftedWith: unknown;
		const world = directWorld(async (...args: unknown[]) => {
			draftedWith = args[0];
			return assistantResponse("summary");
		});
		const target: RangeCompressionTarget = {
			operationId: "direct-operation",
			startEntryId: world.selected,
			endEntryId: world.selected,
		};
		const prepared: PreparedRangeCompression = await prepareRangeCompression(world.ctx, target);
		assert.equal(draftedWith, world.ctx.model);
		assert.deepEqual(prepared.plan.selectedEntryIds, [world.selected]);
		const reviewed = await reviewRangeCompression(world.ctx, prepared);
		assert.ok(reviewed);
		const details = await applyPreparedRangeCompression(world.pi, world.ctx, reviewed);
		assert.partialDeepStrictEqual(details, { operationId: "direct-operation", anchorId: world.anchor });
		const types = world.session.manager
			.getBranch()
			.filter((entry) => "customType" in entry)
			.map((entry) => (entry as { customType: string }).customType);
		assert.deepEqual(types.slice(-2), [CTREE_RANGE_TAIL, CTREE_RANGE_COMPACT]);
	});

	it("rejects an oversized range before drafting or writing", async () => {
		let draftCalls = 0;
		const world = directWorld(async () => {
			draftCalls += 1;
			return assistantResponse("summary");
		});
		const model = world.ctx.model;
		if (!model) throw new Error("missing test model");
		Object.assign(model, { contextWindow: 16, maxTokens: 4 });
		const entriesBefore = world.session.manager.getEntries().length;
		await assert.rejects(
			prepareRangeCompression(world.ctx, {
				operationId: "oversized-range",
				startEntryId: world.selected,
				endEntryId: world.selected,
			}),
			/selected range is too large/,
		);
		assert.equal(draftCalls, 0);
		assert.equal(world.session.manager.getEntries().length, entriesBefore);
	});
});

describe("batch compression", () => {
	function batchSession() {
		const session = new MemorySession();
		session.user("root");
		const anchor = session.assistant("batch anchor");
		const task = session.user("Run the batch");
		const settled = session.assistant("batch completed");
		return { session, anchor, task, settled };
	}

	const batch: BatchSnapshot = {
		planId: HASH_A,
		batchId: HASH_A,
		structuralRevision: HASH_A,
		fileRevision: HASH_A,
		bitmap: [false, true],
	};

	it("reuses range safety and appends the task, summary, then marker", async () => {
		const world = batchSession();
		const ctx = extensionContext(world.session.manager);
		const plan = prepareCompression(ctx, world.anchor, world.settled, "operation");
		assert.equal(plan.taskMessageEntryId, world.task);
		assert.ok(plan.source.includes("batch completed"));
		await applyCompression(mutationApi(world.session.manager), ctx, "run", batch, plan, "summary");
		const types = world.session.manager
			.getBranch()
			.filter((entry) => "customType" in entry)
			.map((entry) => (entry as { customType: string }).customType);
		assert.deepEqual(types.slice(-3), [QUEUED_TASK_TAIL, COMPRESSION_TAIL, COMPRESSION_ENTRY]);
	});
});
