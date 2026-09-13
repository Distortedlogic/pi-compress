import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type RewritePlan, prepareRewrite } from "../core/index.ts";
import { snapshotSession } from "../session.ts";

export interface RewriteMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

export interface RewriteOutput {
	messages: readonly RewriteMessage[];
	marker: {
		customType: string;
		data: unknown;
	};
}

export interface ApplyRewriteResult {
	applied: boolean;
	plan: RewritePlan;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

export function revalidateRewrite(ctx: ExtensionCommandContext, initial: RewritePlan): RewritePlan {
	if (ctx.sessionManager.getSessionId() !== initial.sessionId) {
		throw new Error("The session changed during rewrite review.");
	}
	if (ctx.sessionManager.getLeafId() !== initial.sourceLeafId) {
		throw new Error("The session leaf changed during rewrite review.");
	}
	if (!ctx.sessionManager.getEntry(initial.anchorId)) {
		throw new Error("The rewrite anchor is no longer available.");
	}

	const fresh = prepareRewrite(snapshotSession(ctx.sessionManager), initial.startEntryId, initial.endEntryId, {
		anchorId: initial.anchorId,
	});
	if (
		!sameIds(fresh.selectedEntryIds, initial.selectedEntryIds) ||
		!sameIds(fresh.continuationEntryIds, initial.continuationEntryIds) ||
		fresh.sourceSha256 !== initial.sourceSha256
	) {
		throw new Error("The rewrite source changed during review.");
	}
	return fresh;
}

export async function applyRewrite(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	initial: RewritePlan,
	output: RewriteOutput,
): Promise<ApplyRewriteResult> {
	await ctx.waitForIdle();
	const plan = revalidateRewrite(ctx, initial);
	const navigation = await ctx.navigateTree(plan.anchorId, { summarize: false });
	if (navigation.cancelled) return { applied: false, plan };

	for (const message of output.messages) {
		pi.sendMessage(message, { triggerTurn: false });
	}
	pi.appendEntry(output.marker.customType, output.marker.data);
	return { applied: true, plan };
}
