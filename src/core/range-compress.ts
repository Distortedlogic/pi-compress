import { createHash } from "node:crypto";
import { CTREE_DECISION } from "../protocol.ts";
import type { SessionSnapshot } from "../session.ts";
import { snapshotEntry } from "../session.ts";
import { estimateEntryTokens, fmtTokens } from "./estimate.ts";
import { serializeEntries } from "./serialize.ts";
import type { SessionEntry } from "./types.ts";
import { isCustomMessageEntry, isMessageEntry } from "./types.ts";

/** One atomic, ordered selection unit on the active context path. */
export interface RangeCandidate {
	/** Stable row/group ID. It is the first entry ID in the group. */
	id: string;
	startEntryId: string;
	endEntryId: string;
	/** Entries that must be selected together, in source order. */
	entryIds: string[];
	/** Zero-based positions in Pi's active context entries. */
	pathIndex: number;
	endPathIndex: number;
	estTokens: number;
	selectable: boolean;
	protected: boolean;
	protectReason?: string;
}

/** Complete, immutable input for one append-only session rewrite. */
export interface RewritePlan {
	sessionId: string;
	sourceLeafId: string;
	anchorId: string;
	startEntryId: string;
	endEntryId: string;
	selectedEntryIds: string[];
	continuationEntryIds: string[];
	selectedEntries: SessionEntry[];
	continuationEntries: SessionEntry[];
	source: string;
	continuationSerialized: string;
	selectedEstTokens: number;
	sourceSha256: string;
}

export interface PrepareRewriteOptions {
	/** Use an earlier ancestor when replacement messages also reconstruct entries before the selected source. */
	anchorId?: string;
}

export function sourceSha8(plan: RewritePlan): string {
	return plan.sourceSha256.slice(0, 8);
}

function makeCandidate(
	slice: readonly SessionEntry[],
	startIndex: number,
	endPathIndex: number,
	protectReason?: string,
): RangeCandidate {
	const entries = slice.slice(startIndex, endPathIndex + 1);
	const first = entries[0] as SessionEntry;
	const last = entries[entries.length - 1] as SessionEntry;
	const entryIds = entries.map((entry) => entry.id);
	const selectable = protectReason === undefined;
	return {
		id: first.id,
		startEntryId: first.id,
		endEntryId: last.id,
		entryIds,
		pathIndex: startIndex,
		endPathIndex,
		estTokens: entries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		selectable,
		protected: !selectable,
		protectReason,
	};
}

export function candidateByEntryId(candidates: readonly RangeCandidate[]): Map<string, RangeCandidate> {
	const byEntryId = new Map<string, RangeCandidate>();
	for (const candidate of candidates) {
		for (const entryId of candidate.entryIds) byEntryId.set(entryId, candidate);
	}
	return byEntryId;
}

export type RangeEndpointResult = { ok: true; entryId: string } | { ok: false; reason: string };

export function resolveRangeEndpoint(
	candidates: readonly RangeCandidate[],
	entryId: string,
	endpoint: "start" | "end",
): RangeEndpointResult {
	const candidate = candidateByEntryId(candidates).get(entryId);
	if (!candidate) return { ok: false, reason: "entry is not in the active context" };
	if (candidate.protected) {
		return { ok: false, reason: candidate.protectReason ?? "entry is protected" };
	}
	return {
		ok: true,
		entryId: endpoint === "start" ? candidate.startEntryId : candidate.endEntryId,
	};
}

/** Build safe groups only from the context that the active leaf sends to the model. */
export function rangeCandidates(snapshot: SessionSnapshot): RangeCandidate[] {
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !snapshotEntry(snapshot, sourceLeafId)) {
		throw new Error(`source leaf ${sourceLeafId ?? ""} was not found`);
	}
	const slice = snapshot.contextEntries;

	let incompleteUserId: string | undefined;
	for (let i = slice.length - 1; i >= 0; i--) {
		const entry = slice[i];
		if (!entry || !isMessageEntry(entry) || entry.message.role !== "user") continue;
		const hasAssistantAfter = slice
			.slice(i + 1)
			.some((later) => isMessageEntry(later) && later.message.role === "assistant");
		if (!hasAssistantAfter) incompleteUserId = entry.id;
		break;
	}

	const candidates: RangeCandidate[] = [];
	for (let i = 0; i < slice.length; i++) {
		const entry = slice[i];
		if (!entry) continue;

		if (isMessageEntry(entry) && entry.message.role === "assistant") {
			const callIds = entry.message.content
				.filter((block) => block.type === "toolCall")
				.map((block) => (block as { id: string }).id);
			if (callIds.length > 0) {
				let endPathIndex = i;
				const resultIds: string[] = [];
				while (endPathIndex + 1 < slice.length) {
					const next = slice[endPathIndex + 1];
					if (!next || !isMessageEntry(next) || next.message.role !== "toolResult") break;
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
				candidates.push(makeCandidate(slice, i, endPathIndex, protectReason));
				i = endPathIndex;
				continue;
			}
		}

		let protectReason: string | undefined;
		if (!entry.parentId) protectReason = "no anchor before this message group";
		else if (entry.id === incompleteUserId) protectReason = "incomplete current user turn";
		else if (isCustomMessageEntry(entry) && entry.customType === CTREE_DECISION) protectReason = "decision record";
		else if (isMessageEntry(entry) && entry.message.role === "custom" && entry.message.customType === CTREE_DECISION)
			protectReason = "decision record";
		else if (
			entry.type === "branch_summary" ||
			entry.type === "compaction" ||
			(isMessageEntry(entry) && (entry.message.role === "branchSummary" || entry.message.role === "compactionSummary"))
		)
			protectReason = "structural context entry";
		else if (isMessageEntry(entry) && entry.message.role === "toolResult")
			protectReason = "tool result without its assistant tool call";

		candidates.push(makeCandidate(slice, i, i, protectReason));
	}
	return candidates;
}

function endpointPosition(snapshot: SessionSnapshot, id: string): number {
	if (!snapshotEntry(snapshot, id)) throw new Error(`entry ${id} was not found`);
	const position = snapshot.contextEntries.findIndex((entry) => entry.id === id);
	if (position === -1) throw new Error(`entry ${id} is not on the active context path`);
	return position;
}

/** Prepare one normalized, continuous rewrite without changing the session. */
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
	const slice = snapshot.contextEntries;
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
	const selectedGroups = candidates.slice(firstGroupIndex, lastGroupIndex + 1);
	const blocked = selectedGroups.find((candidate) => candidate.protected);
	if (blocked) {
		throw new Error(`entry ${blocked.id} is protected: ${blocked.protectReason ?? "not selectable"}`);
	}

	const selectedEntries = slice.slice(firstGroup.pathIndex, lastGroup.endPathIndex + 1);
	const continuationEntries = slice.slice(lastGroup.endPathIndex + 1);
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
	const continuationSerialized = serializeEntries(continuationEntries);

	return {
		sessionId: snapshot.sessionId,
		sourceLeafId,
		anchorId,
		startEntryId: firstGroup.startEntryId,
		endEntryId: lastGroup.endEntryId,
		selectedEntryIds: selectedEntries.map((entry) => entry.id),
		continuationEntryIds: continuationEntries.map((entry) => entry.id),
		selectedEntries,
		continuationEntries,
		source,
		continuationSerialized,
		selectedEstTokens: selectedEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		sourceSha256: createHash("sha256").update(source).digest("hex"),
	};
}

/** Render only the approved summary and the unchanged post-range continuation. */
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
