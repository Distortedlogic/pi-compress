import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	type SessionEntry,
	SessionTree,
	isMessageEntry,
	planRange,
	rangeCandidates,
	serializeEntries,
	textOfContent,
} from "../core/index.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_TAIL,
	type CompressionDetails,
	CompressionDetailsSchema,
	QUEUED_TASK_TAIL,
} from "../protocol.ts";

export interface CompressionPlan {
	operationId: string;
	sourceLeafId: string;
	preTaskAnchorId: string;
	taskMessageEntryId: string;
	taskMessage: string;
	startEntryId: string;
	endEntryId: string;
	selectedEntryIds: string[];
	sourceSha256: string;
	source: string;
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
	const tree = SessionTree.fromEntries(entries);
	const endpoint = rangeCandidates(tree, sourceLeafId).findLast((candidate) => selectedIds.has(candidate.endEntryId));
	if (!endpoint || !entries[startIndex]) throw new Error("The execution range is not available.");
	planRange(tree, sourceLeafId, entries[startIndex].id, endpoint.endEntryId);
	const source = serializeEntries(selected);
	if (!source.trim()) throw new Error("The completed batch has no serializable execution range.");
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
		operationId,
		sourceLeafId,
		preTaskAnchorId: batchStartEntryId,
		taskMessageEntryId: taskMessageEntry.id,
		taskMessage: textOfContent(taskMessageEntry.message.content),
		startEntryId: entries[startIndex].id,
		endEntryId: lastSettledEntryId,
		selectedEntryIds: selected.map((entry) => entry.id),
		sourceSha256: createHash("sha256").update(source, "utf8").digest("hex"),
		source,
	};
}

export function revalidateCompression(ctx: ExtensionContext, initial: CompressionPlan): CompressionPlan {
	if (ctx.sessionManager.getLeafId() !== initial.sourceLeafId) {
		throw new Error("The session changed during summary review.");
	}
	const fresh = branch(ctx);
	const startIndex = fresh.findIndex((entry) => entry.id === initial.startEntryId);
	const endIndex = fresh.findIndex((entry) => entry.id === initial.endEntryId);
	if (startIndex === -1 || endIndex < startIndex) throw new Error("The compression source is no longer available.");
	const selected = fresh.slice(startIndex, endIndex + 1);
	const selectedEntryIds = selected.map((entry) => entry.id);
	if (
		selectedEntryIds.length !== initial.selectedEntryIds.length ||
		selectedEntryIds.some((id, index) => id !== initial.selectedEntryIds[index])
	) {
		throw new Error("The compression source changed during summary review.");
	}
	const source = serializeEntries(selected);
	if (createHash("sha256").update(source, "utf8").digest("hex") !== initial.sourceSha256) {
		throw new Error("The compression source changed during summary review.");
	}
	return { ...initial, selectedEntryIds, source };
}

export async function applyCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runId: string,
	batch: BatchSnapshot,
	compression: CompressionPlan,
	summary: string,
): Promise<CompressionDetails> {
	if (ctx.sessionManager.getLeafId() !== compression.sourceLeafId) {
		throw new Error("The session changed before compression could be applied.");
	}
	const navigation = await ctx.navigateTree(compression.preTaskAnchorId, { summarize: false });
	if (navigation.cancelled) throw new Error("Compression navigation was cancelled.");
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
	pi.sendMessage(
		{
			customType: QUEUED_TASK_TAIL,
			content: compression.taskMessage,
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
	pi.sendMessage(
		{
			customType: COMPRESSION_TAIL,
			content: summary.trim(),
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
	pi.appendEntry(COMPRESSION_ENTRY, details);
	return details;
}

export function compressionOnBranch(
	ctx: ExtensionContext,
	runId: string,
	planId: string,
	batchId: string,
): CompressionDetails | undefined {
	for (const entry of branch(ctx).reverse()) {
		if (
			entry.type !== "custom" ||
			(entry.customType !== COMPRESSION_ENTRY && entry.customType !== "pi-workstream/compression")
		)
			continue;
		if (Value.Check(CompressionDetailsSchema, entry.data)) {
			const details = entry.data;
			if (details.runId === runId && details.planId === planId && details.batchId === batchId)
				return structuredClone(details);
		}
	}
	return undefined;
}
