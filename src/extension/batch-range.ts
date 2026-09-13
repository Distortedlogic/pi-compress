import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type RewritePlan,
	type SessionEntry,
	isMessageEntry,
	prepareRewrite,
	rangeCandidates,
	textOfContent,
} from "../core/index.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
	type CompressionDetails,
	QUEUED_TASK_TAIL,
	compressionDetails,
} from "../protocol.ts";
import { snapshotSession } from "../session.ts";
import { applyRewrite } from "./rewrite.ts";

export interface CompressionPlan extends RewritePlan {
	operationId: string;
	preTaskAnchorId: string;
	taskMessageEntryId: string;
	taskMessage: string;
}

function branch(ctx: ExtensionContext): SessionEntry[] {
	return [...ctx.sessionManager.getBranch()] as SessionEntry[];
}

function isQueuedTaskMessage(entry: SessionEntry): boolean {
	return (
		isMessageEntry(entry) &&
		entry.message.role === "user" &&
		textOfContent(entry.message.content).startsWith("[Queued task]\n\n")
	);
}

function isAssistantMessage(entry: SessionEntry): boolean {
	return isMessageEntry(entry) && entry.message.role === "assistant";
}

export function prepareCompression(
	ctx: ExtensionContext,
	batchStartEntryId: string,
	lastSettledEntryId: string,
	operationId: string = randomUUID(),
): CompressionPlan {
	const entries = branch(ctx);
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
		(entry, index) => index > taskMessageIndex && index <= endIndex && isAssistantMessage(entry),
	);
	if (startIndex === -1) throw new Error("The completed batch has no assistant execution range.");
	const selected = entries.slice(startIndex, endIndex + 1);
	const selectedIds = new Set(selected.map((entry) => entry.id));
	const snapshot = snapshotSession(ctx.sessionManager);
	const endpoint = rangeCandidates(snapshot).findLast((candidate) => selectedIds.has(candidate.endEntryId));
	if (!endpoint || !entries[startIndex]) throw new Error("The execution range is not available.");
	const rewrite = prepareRewrite(snapshot, entries[startIndex].id, endpoint.endEntryId, {
		anchorId: batchStartEntryId,
	});
	const taskMessageEntry = entries[taskMessageIndex];
	if (
		!taskMessageEntry ||
		!isMessageEntry(taskMessageEntry) ||
		taskMessageEntry.message.role !== "user" ||
		!textOfContent(taskMessageEntry.message.content).startsWith("[Queued task]\n\n")
	) {
		throw new Error("The queued batch message is invalid.");
	}
	return {
		...rewrite,
		operationId,
		preTaskAnchorId: batchStartEntryId,
		taskMessageEntryId: taskMessageEntry.id,
		taskMessage: textOfContent(taskMessageEntry.message.content),
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
	const result = await applyRewrite(pi, ctx, compression, {
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
	if (!result.applied) throw new Error("Compression navigation was cancelled.");
	return details;
}

export function compressionOnBranch(
	ctx: ExtensionContext,
	runId: string,
	planId: string,
	batchId: string,
): CompressionDetails | undefined {
	for (const entry of branch(ctx).reverse()) {
		const details = compressionDetails(entry);
		if (details?.runId === runId && details.planId === planId && details.batchId === batchId) {
			return structuredClone(details);
		}
	}
	return undefined;
}
