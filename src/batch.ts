import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contentText } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { snapshotSession } from "./context.ts";
import { draftRangeSummary, realDraft } from "./extension/draft.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_REQUEST,
	COMPRESSION_RESULT,
	COMPRESSION_TAIL,
	type CompressionDetails,
	type CompressionRequest,
	CompressionRequestSchema,
	type CompressionResult,
	CompressionResultSchema,
	QUEUED_TASK_TAIL,
	compressionDetails,
} from "./protocol.ts";
import { type RewritePlan, applyRewrite, prepareRewrite, rangeCandidates, revalidateRewrite } from "./rewrite.ts";

export interface CompressionPlan extends RewritePlan {
	operationId: string;
	preTaskAnchorId: string;
	taskMessageEntryId: string;
	taskMessage: string;
}

interface Prepared {
	request: CompressionRequest;
	plan: CompressionPlan;
	summary: string;
}

type Outcome = Pick<CompressionResult, "status" | "details" | "code">;

function isQueuedTaskMessage(entry: SessionEntry): entry is SessionMessageEntry {
	return (
		entry.type === "message" &&
		entry.message.role === "user" &&
		contentText(entry.message.content, "\n").startsWith("[Queued task]\n\n")
	);
}

export function prepareCompression(
	ctx: ExtensionContext,
	batchStartEntryId: string,
	lastSettledEntryId: string,
	operationId: string = randomUUID(),
): CompressionPlan {
	const entries = ctx.sessionManager.getBranch();
	const markerIndex = entries.findIndex((entry) => entry.id === batchStartEntryId);
	const endIndex = entries.findIndex((entry) => entry.id === lastSettledEntryId);
	const sourceLeafId = ctx.sessionManager.getLeafId();
	if (markerIndex === -1 || endIndex <= markerIndex || !sourceLeafId) {
		throw new Error("The completed batch session range is not available.");
	}
	const taskMessageIndex = entries.findIndex(
		(entry, index) => index > markerIndex && index <= endIndex && isQueuedTaskMessage(entry),
	);
	if (taskMessageIndex === -1) throw new Error("The queued batch message is not available.");
	const startIndex = entries.findIndex(
		(entry, index) =>
			index > taskMessageIndex && index <= endIndex && entry.type === "message" && entry.message.role === "assistant",
	);
	if (startIndex === -1) throw new Error("The completed batch has no assistant execution range.");
	const selectedIds = new Set(entries.slice(startIndex, endIndex + 1).map((entry) => entry.id));
	const snapshot = snapshotSession(ctx.sessionManager);
	const endpoint = rangeCandidates(snapshot).findLast((candidate) => selectedIds.has(candidate.endEntryId));
	const startEntry = entries[startIndex];
	if (!endpoint || !startEntry) throw new Error("The execution range is not available.");
	const rewrite = prepareRewrite(snapshot, startEntry.id, endpoint.endEntryId, { anchorId: batchStartEntryId });
	const taskMessageEntry = entries[taskMessageIndex];
	if (!taskMessageEntry || !isQueuedTaskMessage(taskMessageEntry) || taskMessageEntry.message.role !== "user") {
		throw new Error("The queued batch message is invalid.");
	}
	return {
		...rewrite,
		operationId,
		preTaskAnchorId: batchStartEntryId,
		taskMessageEntryId: taskMessageEntry.id,
		taskMessage: contentText(taskMessageEntry.message.content, "\n"),
	};
}

export async function applyCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runId: string,
	batch: BatchSnapshot,
	compression: CompressionPlan,
	summary: string,
): Promise<CompressionDetails> {
	const details: CompressionDetails = {
		v: 2,
		runId,
		planId: batch.planId,
		batchId: batch.batchId,
		operationId: compression.operationId,
		structuralRevision: batch.structuralRevision,
		fileRevision: batch.fileRevision,
		preCompletionBitmap: [...batch.bitmap],
		sourceLeafId: compression.sourceLeafId,
		preTaskAnchorId: compression.preTaskAnchorId,
		taskMessageEntryId: compression.taskMessageEntryId,
		startEntryId: compression.startEntryId,
		endEntryId: compression.endEntryId,
		selectedEntryIds: [...compression.selectedEntryIds],
		sourceSha256: compression.sourceSha256,
	};
	const applied = await applyRewrite(pi, ctx, compression, {
		messages: [
			{
				customType: QUEUED_TASK_TAIL,
				content: compression.taskMessage,
				display: true,
				details,
			},
			{
				customType: COMPRESSION_TAIL,
				content: summary.trim(),
				display: true,
				details,
			},
		],
		marker: { customType: COMPRESSION_ENTRY, data: details },
	});
	if (!applied) throw new Error("Compression navigation was cancelled.");
	return details;
}

function compressionOnBranch(
	ctx: ExtensionContext,
	runId: string,
	planId: string,
	batchId: string,
): CompressionDetails | undefined {
	for (const entry of ctx.sessionManager.getBranch().reverse()) {
		const details = compressionDetails(entry);
		if (details?.runId === runId && details.planId === planId && details.batchId === batchId) {
			return structuredClone(details);
		}
	}
	return undefined;
}

export function registerBatchCompression(pi: ExtensionAPI): void {
	const prepared = new Map<string, Prepared>();
	const pending = new Map<string, { request: CompressionRequest; promise: Promise<Outcome> }>();
	const cancelled = new Set<string>();
	const mutating = new Set<string>();

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		for (const [key, job] of prepared) {
			if (job.request.sessionId === sessionId) prepared.delete(key);
		}
		for (const [key, job] of pending) {
			if (job.request.sessionId === sessionId) cancelled.add(key);
		}
	});

	async function execute(request: CompressionRequest, ctx: ExtensionCommandContext, key: string): Promise<Outcome> {
		if (ctx.sessionManager.getSessionId() !== request.sessionId) {
			return { status: "failed", code: "session_changed" };
		}
		const applied = compressionOnBranch(ctx, request.runId, request.batch.planId, request.batch.batchId);
		if (applied) return { status: "applied", details: applied };

		if (request.action === "cancel") {
			if (mutating.has(request.sessionId)) return { status: "failed", code: "busy" };
			cancelled.add(key);
			prepared.delete(key);
			return { status: "cancelled" };
		}
		if (cancelled.has(key)) return { status: "cancelled" };
		const saved = prepared.get(key);
		if (saved && (saved.request.runId !== request.runId || !isDeepStrictEqual(saved.request.batch, request.batch))) {
			return { status: "failed", code: "operation_conflict" };
		}
		if (request.action === "status") return { status: saved ? "prepared" : "missing" };

		if (request.action === "prepare") {
			if (saved) {
				if (
					saved.request.anchorEntryId !== request.anchorEntryId ||
					saved.request.lastSettledEntryId !== request.lastSettledEntryId ||
					(saved.request.review ?? true) !== (request.review ?? true)
				) {
					return { status: "failed", code: "operation_conflict" };
				}
				return { status: "prepared" };
			}
			if (!request.anchorEntryId || !request.lastSettledEntryId || !ctx.isIdle() || ctx.hasPendingMessages()) {
				return { status: "failed", code: "invalid_request" };
			}
			const plan = prepareCompression(ctx, request.anchorEntryId, request.lastSettledEntryId, request.operationId);
			let summary = (await draftRangeSummary(realDraft, ctx, plan.source)).trim();
			if (request.review !== false) {
				summary = (await ctx.ui.editor("Review completed batch summary", summary))?.trim() ?? "";
			}
			if (!summary || cancelled.has(key)) {
				cancelled.add(key);
				return { status: "cancelled" };
			}
			if (ctx.sessionManager.getSessionId() !== request.sessionId) {
				return { status: "failed", code: "session_changed" };
			}
			revalidateRewrite(ctx, plan);
			prepared.set(key, { request: structuredClone(request), plan, summary });
			return { status: "prepared" };
		}

		if (!saved) return { status: "failed", code: "not_prepared" };
		if (mutating.has(request.sessionId)) return { status: "failed", code: "busy" };
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return { status: "failed", code: "session_changed" };
		mutating.add(request.sessionId);
		try {
			const details = await applyCompression(pi, ctx, request.runId, request.batch, saved.plan, saved.summary);
			prepared.delete(key);
			return { status: "applied", details };
		} finally {
			mutating.delete(request.sessionId);
		}
	}

	pi.events.on(COMPRESSION_REQUEST, async (value: unknown) => {
		const transport = value as { request?: unknown; context?: ExtensionCommandContext } | undefined;
		if (!transport || !Value.Check(CompressionRequestSchema, transport.request)) return;
		const request = transport.request;
		const key = `${request.sessionId}:${request.operationId}`;
		let outcome: Outcome;
		try {
			const ctx = transport.context;
			if (!ctx || ctx.sessionManager.getSessionId() !== request.sessionId) {
				outcome = { status: "failed", code: "session_changed" };
			} else {
				const flight = pending.get(key);
				if (flight && request.action !== "cancel") {
					const { requestId: _oldId, ...oldRequest } = flight.request;
					const { requestId: _newId, ...newRequest } = request;
					outcome = isDeepStrictEqual(oldRequest, newRequest)
						? await flight.promise
						: { status: "failed", code: "busy" };
				} else {
					const job = { request, promise: execute(request, ctx, key) };
					if (request.action !== "cancel") pending.set(key, job);
					try {
						outcome = await job.promise;
					} finally {
						if (pending.get(key) === job) pending.delete(key);
					}
				}
			}
		} catch {
			outcome = { status: "failed", code: "compression_failed" };
		}
		const result: CompressionResult = {
			v: 1,
			requestId: request.requestId,
			sessionId: request.sessionId,
			operationId: request.operationId,
			...outcome,
		};
		if (Value.Check(CompressionResultSchema, result)) pi.events.emit(COMPRESSION_RESULT, result);
	});
}
