import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens, fmtTokens } from "./core/estimate.ts";
import { type RewritePlan, applyRewrite, prepareRewrite, revalidateRewrite, sourceSha8 } from "./core/range-rewrite.ts";
import { draftRangeSummary, realDraft } from "./extension/draft.ts";
import { CTREE_RANGE_COMPACT, CTREE_RANGE_TAIL, type CtreeRangeCompactData } from "./protocol.ts";
import { snapshotSession } from "./session.ts";

export interface RangeCompressionTarget {
	readonly operationId: string;
	readonly startEntryId: string;
	readonly endEntryId: string;
	readonly anchorEntryId?: string;
	readonly instructions?: string;
	readonly signal?: AbortSignal;
}

export interface RangeCompressionInput extends RangeCompressionTarget {
	readonly review: boolean;
}

export interface PreparedRangeCompression {
	readonly plan: RewritePlan;
	readonly summary: string;
	readonly summaryModel: string;
	readonly operationId: string;
}

export type RangeCompressionOutcome = { status: "applied"; details: CtreeRangeCompactData } | { status: "cancelled" };

function immutablePlan(plan: RewritePlan): RewritePlan {
	return Object.freeze({
		...plan,
		selectedEntryIds: Object.freeze([...plan.selectedEntryIds]),
		continuationEntryIds: Object.freeze([...plan.continuationEntryIds]),
		selectedEntries: Object.freeze([...plan.selectedEntries]),
		continuationEntries: Object.freeze([...plan.continuationEntries]),
	});
}

function assertStableSession(ctx: ExtensionCommandContext, sessionId: string, sourceLeafId: string | null): void {
	if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== sourceLeafId) {
		throw new Error("The session changed during range compression.");
	}
	if (ctx.hasPendingMessages()) {
		throw new Error("Range compression cannot run while messages are pending.");
	}
}

export function renderRangeTail(plan: RewritePlan, approvedSummary: string): string {
	const summary = approvedSummary.trim();
	if (!summary) throw new Error("approved range summary is empty");
	const header = `[ctree/range-compact: summarized ${plan.selectedEntryIds.length} entries, ~${fmtTokens(
		plan.selectedEstTokens,
	)} tokens, source ${sourceSha8(plan)}. Originals preserved at leaf ${plan.sourceLeafId}.]`;
	const parts = [header, summary];
	if (plan.continuationSerialized.trim()) {
		parts.push("[unchanged continuation after compressed range]", plan.continuationSerialized);
	}
	return `${parts.join("\n\n")}\n`;
}

function compressionDetails(
	plan: RewritePlan,
	summary: string,
	summaryModel: string,
	operationId: string,
): CtreeRangeCompactData {
	const summaryEstTokens = estimateTextTokens(summary);
	return {
		v: 1,
		operationId,
		sourceLeafId: plan.sourceLeafId,
		anchorId: plan.anchorId,
		startEntryId: plan.startEntryId,
		endEntryId: plan.endEntryId,
		selectedEntryIds: [...plan.selectedEntryIds],
		selectedEstTokens: plan.selectedEstTokens,
		summaryEstTokens,
		reclaimedEstTokens: plan.selectedEstTokens - summaryEstTokens,
		summaryModel,
		sourceSha8: sourceSha8(plan),
	};
}

export async function prepareRangeCompression(
	ctx: ExtensionCommandContext,
	target: RangeCompressionTarget,
): Promise<PreparedRangeCompression> {
	const sessionId = ctx.sessionManager.getSessionId();
	const sourceLeafId = ctx.sessionManager.getLeafId();
	target.signal?.throwIfAborted();
	await ctx.waitForIdle();
	target.signal?.throwIfAborted();
	assertStableSession(ctx, sessionId, sourceLeafId);

	const model = ctx.model;
	if (!model) throw new Error("No current model is available for range compression.");
	const snapshot = snapshotSession(ctx.sessionManager);
	const plan = prepareRewrite(snapshot, target.startEntryId, target.endEntryId, {
		anchorId: target.anchorEntryId,
	});
	const summary = (await draftRangeSummary(realDraft, ctx, plan.source, target.instructions, target.signal)).trim();
	if (!summary) throw new Error("The model returned an empty range summary.");
	target.signal?.throwIfAborted();
	assertStableSession(ctx, sessionId, sourceLeafId);
	const validatedPlan = immutablePlan(revalidateRewrite(ctx, plan));
	return Object.freeze({
		plan: validatedPlan,
		summary,
		summaryModel: `${model.provider}/${model.id}`,
		operationId: target.operationId,
	});
}

export async function reviewRangeCompression(
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<PreparedRangeCompression | undefined> {
	const summary = (await ctx.ui.editor("Review selected range summary", prepared.summary))?.trim();
	if (!summary) return undefined;
	return Object.freeze({ ...prepared, summary });
}

export async function applyPreparedRangeCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<CtreeRangeCompactData | undefined> {
	await ctx.waitForIdle();
	if (ctx.hasPendingMessages()) {
		throw new Error("Range compression cannot run while messages are pending.");
	}
	const plan = revalidateRewrite(ctx, prepared.plan);
	const details = compressionDetails(plan, prepared.summary, prepared.summaryModel, prepared.operationId);
	const result = await applyRewrite(pi, ctx, plan, {
		messages: [
			{
				customType: CTREE_RANGE_TAIL,
				content: renderRangeTail(plan, prepared.summary),
				display: true,
				details,
			},
		],
		marker: { customType: CTREE_RANGE_COMPACT, data: details },
	});
	return result.applied ? details : undefined;
}

export async function compressRange(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	input: RangeCompressionInput,
): Promise<RangeCompressionOutcome> {
	const prepared = await prepareRangeCompression(ctx, input);
	const approved = input.review ? await reviewRangeCompression(ctx, prepared) : prepared;
	if (!approved) return { status: "cancelled" };
	const details = await applyPreparedRangeCompression(pi, ctx, approved);
	return details ? { status: "applied", details } : { status: "cancelled" };
}
