import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	COMPRESSION_REQUEST,
	COMPRESSION_RESULT,
	type CompressionRequest,
	CompressionRequestSchema,
	type CompressionResult,
	CompressionResultSchema,
} from "../protocol.ts";
import {
	type CompressionPlan,
	applyCompression,
	compressionOnBranch,
	prepareCompression,
	revalidateCompression,
} from "./batch-range.ts";
import { draftRangeSummary } from "./draft.ts";
import { realDraft } from "./draft.ts";

interface Prepared {
	request: CompressionRequest;
	plan: CompressionPlan;
	summary: string;
}

type Outcome = Pick<CompressionResult, "status" | "details" | "code">;

/** The context is a public Pi capability. It is not part of durable protocol data. */
export function registerBatchCompression(pi: ExtensionAPI): void {
	const prepared = new Map<string, Prepared>();
	const pending = new Map<string, { request: CompressionRequest; promise: Promise<Outcome> }>();
	const cancelled = new Set<string>();
	const mutating = new Set<string>();

	pi.on("session_shutdown", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		for (const [key, job] of prepared) {
			if (job.request.sessionId === id) prepared.delete(key);
		}
		for (const [key, job] of pending) {
			if (job.request.sessionId === id) cancelled.add(key);
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
				)
					return { status: "failed", code: "operation_conflict" };
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
			revalidateCompression(ctx, plan);
			prepared.set(key, { request: structuredClone(request), plan, summary });
			return { status: "prepared" };
		}

		if (!saved) return { status: "failed", code: "not_prepared" };
		if (mutating.has(request.sessionId)) return { status: "failed", code: "busy" };
		if (typeof ctx.navigateTree !== "function" || !ctx.isIdle() || ctx.hasPendingMessages()) {
			return { status: "failed", code: "session_changed" };
		}
		mutating.add(request.sessionId);
		try {
			const plan = revalidateCompression(ctx, saved.plan);
			const details = await applyCompression(pi, ctx, request.runId, request.batch, plan, saved.summary);
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
