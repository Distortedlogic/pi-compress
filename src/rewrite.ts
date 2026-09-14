import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type SessionSnapshot,
	estimateEntryTokens,
	serializeEntries,
	snapshotEntry,
	snapshotSession,
} from "./context.ts";
import { CTREE_DECISION } from "./protocol.ts";

export interface RangeCandidate {
	startEntryId: string;
	endEntryId: string;
	entryIds: string[];
	pathIndex: number;
	endPathIndex: number;
	protected: boolean;
	protectReason?: string;
}

export interface RewritePlan {
	readonly sessionId: string;
	readonly sourceLeafId: string;
	readonly anchorId: string;
	readonly startEntryId: string;
	readonly endEntryId: string;
	readonly selectedEntryIds: readonly string[];
	readonly continuationEntryIds: readonly string[];
	readonly selectedEntries: readonly SessionEntry[];
	readonly source: string;
	readonly continuationSerialized: string;
	readonly selectedEstTokens: number;
	readonly sourceSha256: string;
}

export interface PrepareRewriteOptions {
	anchorId?: string;
}

interface RewriteMessage {
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

function makeCandidate(
	slice: readonly SessionEntry[],
	startIndex: number,
	endPathIndex: number,
	protectReason?: string,
): RangeCandidate {
	const entries = slice.slice(startIndex, endPathIndex + 1);
	const first = entries[0] as SessionEntry;
	const last = entries.at(-1) as SessionEntry;
	return {
		startEntryId: first.id,
		endEntryId: last.id,
		entryIds: entries.map((entry) => entry.id),
		pathIndex: startIndex,
		endPathIndex,
		protected: protectReason !== undefined,
		protectReason,
	};
}

function metadataProtectReason(entry: SessionEntry): string | undefined {
	switch (entry.type) {
		case "custom":
		case "model_change":
		case "thinking_level_change":
		case "label":
		case "session_info":
			return "context-inert session metadata";
		default:
			return undefined;
	}
}

export function candidateByEntryId(candidates: readonly RangeCandidate[]): Map<string, RangeCandidate> {
	const byEntryId = new Map<string, RangeCandidate>();
	for (const candidate of candidates) {
		for (const entryId of candidate.entryIds) byEntryId.set(entryId, candidate);
	}
	return byEntryId;
}

export function rangeCandidates(snapshot: SessionSnapshot): RangeCandidate[] {
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !snapshotEntry(snapshot, sourceLeafId)) {
		throw new Error(`source leaf ${sourceLeafId ?? ""} was not found`);
	}
	const slice = snapshot.contextEntries;

	let incompleteUserId: string | undefined;
	for (let index = slice.length - 1; index >= 0; index--) {
		const entry = slice[index];
		if (!entry || entry.type !== "message" || entry.message.role !== "user") continue;
		const hasAssistantAfter = slice
			.slice(index + 1)
			.some((later) => later.type === "message" && later.message.role === "assistant");
		if (!hasAssistantAfter) incompleteUserId = entry.id;
		break;
	}

	const candidates: RangeCandidate[] = [];
	for (let index = 0; index < slice.length; index++) {
		const entry = slice[index];
		if (!entry) continue;

		if (entry.type === "message" && entry.message.role === "assistant") {
			const callIds = entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
			if (callIds.length > 0) {
				let endPathIndex = index;
				const resultIds: string[] = [];
				while (endPathIndex + 1 < slice.length) {
					const next = slice[endPathIndex + 1];
					if (!next || next.type !== "message" || next.message.role !== "toolResult") break;
					resultIds.push(next.message.toolCallId);
					endPathIndex += 1;
				}
				const callSet = new Set(callIds);
				const resultSet = new Set(resultIds);
				const complete =
					callSet.size === callIds.length &&
					resultSet.size === resultIds.length &&
					resultIds.length === callIds.length &&
					callIds.every((id) => resultSet.has(id)) &&
					resultIds.every((id) => callSet.has(id));
				const protectReason = !complete
					? "incomplete assistant tool-call group"
					: entry.parentId
						? undefined
						: "no anchor before this message group";
				candidates.push(makeCandidate(slice, index, endPathIndex, protectReason));
				index = endPathIndex;
				continue;
			}
		}

		const metadataReason = metadataProtectReason(entry);
		let protectReason: string | undefined;
		if (!entry.parentId) protectReason = "no anchor before this message group";
		else if (metadataReason) protectReason = metadataReason;
		else if (entry.id === incompleteUserId) protectReason = "incomplete current user turn";
		else if (entry.type === "custom_message" && entry.customType === CTREE_DECISION) protectReason = "decision record";
		else if (
			entry.type === "message" &&
			entry.message.role === "custom" &&
			entry.message.customType === CTREE_DECISION
		) {
			protectReason = "decision record";
		} else if (
			entry.type === "branch_summary" ||
			entry.type === "compaction" ||
			(entry.type === "message" &&
				(entry.message.role === "branchSummary" || entry.message.role === "compactionSummary"))
		) {
			protectReason = "structural context entry";
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			protectReason = "tool result without its assistant tool call";
		}
		candidates.push(makeCandidate(slice, index, index, protectReason));
	}
	return candidates;
}

function endpointPosition(snapshot: SessionSnapshot, id: string): number {
	if (!snapshotEntry(snapshot, id)) throw new Error(`entry ${id} was not found`);
	const position = snapshot.contextEntries.findIndex((entry) => entry.id === id);
	if (position === -1) throw new Error(`entry ${id} is not on the active context path`);
	return position;
}

export function prepareRewrite(
	snapshot: SessionSnapshot,
	startId: string,
	endId: string,
	options: PrepareRewriteOptions = {},
): RewritePlan {
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !snapshotEntry(snapshot, sourceLeafId)) {
		throw new Error(`source leaf ${sourceLeafId ?? ""} was not found`);
	}
	const candidates = rangeCandidates(snapshot);
	const startPosition = endpointPosition(snapshot, startId);
	const endPosition = endpointPosition(snapshot, endId);
	if (startPosition > endPosition) throw new Error("range endpoints are not normalized");
	const byEntryId = candidateByEntryId(candidates);
	const firstGroup = byEntryId.get(startId);
	const lastGroup = byEntryId.get(endId);
	if (!firstGroup || !lastGroup) throw new Error("range endpoint is structural-only or missing");
	if (startId !== firstGroup.startEntryId) {
		throw new Error(`range start ${startId} would split a required tool-call group`);
	}
	if (endId !== lastGroup.endEntryId) {
		throw new Error(`range end ${endId} would split a required tool-call group`);
	}

	const firstGroupIndex = candidates.indexOf(firstGroup);
	const lastGroupIndex = candidates.indexOf(lastGroup);
	const blocked = candidates.slice(firstGroupIndex, lastGroupIndex + 1).find((candidate) => candidate.protected);
	if (blocked) {
		throw new Error(`entry ${blocked.startEntryId} is protected: ${blocked.protectReason ?? "not selectable"}`);
	}

	const selectedEntries = snapshot.contextEntries.slice(firstGroup.pathIndex, lastGroup.endPathIndex + 1);
	const continuationEntries = snapshot.contextEntries.slice(lastGroup.endPathIndex + 1);
	const firstEntry = selectedEntries[0];
	if (!firstEntry) throw new Error("range is empty");
	const anchorId = options.anchorId ?? firstEntry.parentId;
	if (!anchorId) throw new Error("range has no entry before it to use as an anchor");
	if (!snapshotEntry(snapshot, anchorId)) throw new Error(`rewrite anchor ${anchorId} was not found`);
	const anchorPosition = snapshot.branch.findIndex((entry) => entry.id === anchorId);
	const startBranchPosition = snapshot.branch.findIndex((entry) => entry.id === firstEntry.id);
	if (anchorPosition === -1 || startBranchPosition <= anchorPosition) {
		throw new Error(`rewrite anchor ${anchorId} is not before the selected range`);
	}
	const source = serializeEntries(selectedEntries);
	if (!source.trim()) throw new Error("selected range has no serializable source");

	return {
		sessionId: snapshot.sessionId,
		sourceLeafId,
		anchorId,
		startEntryId: firstGroup.startEntryId,
		endEntryId: lastGroup.endEntryId,
		selectedEntryIds: selectedEntries.map((entry) => entry.id),
		continuationEntryIds: continuationEntries.map((entry) => entry.id),
		selectedEntries,
		source,
		continuationSerialized: serializeEntries(continuationEntries),
		selectedEstTokens: selectedEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		sourceSha256: createHash("sha256").update(source).digest("hex"),
	};
}

export function sourceSha8(plan: RewritePlan): string {
	return plan.sourceSha256.slice(0, 8);
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
): Promise<boolean> {
	await ctx.waitForIdle();
	const plan = revalidateRewrite(ctx, initial);
	const navigation = await ctx.navigateTree(plan.anchorId, { summarize: false });
	if (navigation.cancelled) return false;
	for (const message of output.messages) pi.sendMessage(message, { triggerTurn: false });
	pi.appendEntry(output.marker.customType, output.marker.data);
	return true;
}
