import { createHash } from "node:crypto";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import parseArgs from "yargs-parser";
import { deriveState, modelKey } from "./branches.ts";
import { estimateEntryTokens, estimateTextTokens, fmtTokens } from "./core/estimate.ts";
import { serializeEntries, serializeEntry, textOfContent } from "./core/serialize.ts";
import type { AgentMessage, MessageEntry, SessionEntry } from "./core/types.ts";
import { isCustomMessageEntry, isMessageEntry } from "./core/types.ts";
import { type Deps, draftRangeSummary } from "./extension/draft.ts";
import { refreshAmbient } from "./panel.ts";
import {
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CtreeCropDrop,
	type CtreeCropStub,
	type CtreeRangeCompactData,
} from "./protocol.ts";
import { type SessionSnapshot, snapshotEntry, snapshotSession } from "./session.ts";

export interface RangeCandidate {
	id: string;
	startEntryId: string;
	endEntryId: string;
	entryIds: string[];
	pathIndex: number;
	endPathIndex: number;
	estTokens: number;
	selectable: boolean;
	protected: boolean;
	protectReason?: string;
}

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

export interface ApplyRewriteResult {
	applied: boolean;
	plan: RewritePlan;
}

export interface CropCandidate {
	entryId: string;
	tool: string;
	arg?: string;
	estTokens: number;
	ageTurns: number;
	protected: boolean;
}

export interface AutoRules {
	minTokens?: number;
	olderThanTurns?: number;
	keep?: string[];
}

export interface CropPlan extends RewritePlan {
	marked: string[];
	reclaimTokens: number;
	stubs: CtreeCropStub[];
	dropped: CtreeCropDrop[];
}

export interface ContextTurn {
	userId: string;
	label: string;
	entryIds: string[];
	estTokens: number;
}

interface CropFlags {
	auto: boolean;
	dryRun: boolean;
	apply: boolean;
	top: boolean;
	minTokens?: number;
	olderThan?: number;
	keep: string[];
}

export type RangeEndpointResult = { ok: true; entryId: string } | { ok: false; reason: string };

type RangePhase = "start" | "end";
type RangeCompressionStage = "Drafting summary" | "Checking selected range" | "Applying compression";
type RangeCompressionProgress = (stage: RangeCompressionStage) => void;
type NativeTree = ReturnType<ExtensionCommandContext["sessionManager"]["getTree"]>;
type NativeTreeNode = NativeTree[number];

const PRIMARY_ARG_KEYS = ["path", "file_path", "url", "command", "query", "name"];
const PARSER_CONFIGURATION = {
	"boolean-negation": false,
	"camel-case-expansion": false,
	"parse-numbers": false,
	"unknown-options-as-args": true,
} as const;
const KEEP_MATCH_OPTIONS = { dot: true, matchBase: true } as const;

function makeCandidate(
	slice: readonly SessionEntry[],
	startIndex: number,
	endPathIndex: number,
	protectReason?: string,
): RangeCandidate {
	const entries = slice.slice(startIndex, endPathIndex + 1);
	const first = entries[0] as SessionEntry;
	const last = entries.at(-1) as SessionEntry;
	const selectable = protectReason === undefined;
	return {
		id: first.id,
		startEntryId: first.id,
		endEntryId: last.id,
		entryIds: entries.map((entry) => entry.id),
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

export function resolveRangeEndpoint(
	candidates: readonly RangeCandidate[],
	entryId: string,
	endpoint: "start" | "end",
): RangeEndpointResult {
	const candidate = candidateByEntryId(candidates).get(entryId);
	if (!candidate) return { ok: false, reason: "entry is not in the active context" };
	if (candidate.protected) return { ok: false, reason: candidate.protectReason ?? "entry is protected" };
	return {
		ok: true,
		entryId: endpoint === "start" ? candidate.startEntryId : candidate.endEntryId,
	};
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
		if (!entry || !isMessageEntry(entry) || entry.message.role !== "user") continue;
		const hasAssistantAfter = slice
			.slice(index + 1)
			.some((later) => isMessageEntry(later) && later.message.role === "assistant");
		if (!hasAssistantAfter) incompleteUserId = entry.id;
		break;
	}

	const candidates: RangeCandidate[] = [];
	for (let index = 0; index < slice.length; index++) {
		const entry = slice[index];
		if (!entry) continue;

		if (isMessageEntry(entry) && entry.message.role === "assistant") {
			const callIds = entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
			if (callIds.length > 0) {
				let endPathIndex = index;
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
				candidates.push(makeCandidate(slice, index, endPathIndex, protectReason));
				index = endPathIndex;
				continue;
			}
		}

		let protectReason: string | undefined;
		if (!entry.parentId) protectReason = "no anchor before this message group";
		else if (entry.id === incompleteUserId) protectReason = "incomplete current user turn";
		else if (isCustomMessageEntry(entry) && entry.customType === CTREE_DECISION) protectReason = "decision record";
		else if (isMessageEntry(entry) && entry.message.role === "custom" && entry.message.customType === CTREE_DECISION) {
			protectReason = "decision record";
		} else if (
			entry.type === "branch_summary" ||
			entry.type === "compaction" ||
			(isMessageEntry(entry) && (entry.message.role === "branchSummary" || entry.message.role === "compactionSummary"))
		) {
			protectReason = "structural context entry";
		} else if (isMessageEntry(entry) && entry.message.role === "toolResult") {
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
	if (blocked) throw new Error(`entry ${blocked.id} is protected: ${blocked.protectReason ?? "not selectable"}`);

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
		continuationEntries,
		source,
		continuationSerialized: serializeEntries(continuationEntries),
		selectedEstTokens: selectedEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		sourceSha256: createHash("sha256").update(source).digest("hex"),
	};
}

export function sourceSha8(plan: RewritePlan): string {
	return plan.sourceSha256.slice(0, 8);
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
	for (const message of output.messages) pi.sendMessage(message, { triggerTurn: false });
	pi.appendEntry(output.marker.customType, output.marker.data);
	return { applied: true, plan };
}

function firstLine(text: string, max = 80): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isUserMessage(entry: SessionEntry): boolean {
	return isMessageEntry(entry) && (entry as MessageEntry).message.role === "user";
}

function isAnswerEntry(entry: SessionEntry): boolean {
	if (!isMessageEntry(entry)) return false;
	const role = (entry as MessageEntry).message.role;
	return role === "assistant" || role === "toolResult" || role === "bashExecution";
}

function primaryArg(snapshot: SessionSnapshot, entry: MessageEntry): string | undefined {
	const message = entry.message;
	if (message.role === "bashExecution") return message.command.slice(0, 60);
	if (message.role !== "toolResult") return undefined;
	const parent = entry.parentId ? snapshotEntry(snapshot, entry.parentId) : undefined;
	if (!parent || !isMessageEntry(parent) || parent.message.role !== "assistant") return undefined;
	for (const block of parent.message.content) {
		if (block.type !== "toolCall" || block.id !== message.toolCallId) continue;
		const args = block.arguments ?? {};
		for (const key of PRIMARY_ARG_KEYS) {
			const value = args[key];
			if (typeof value === "string" && value.length > 0) return value.slice(0, 60);
		}
		const first = Object.values(args).find((value) => typeof value === "string" && value.length > 0);
		return typeof first === "string" ? first.slice(0, 60) : undefined;
	}
	return undefined;
}

function toolNameOf(entry: SessionEntry): string | undefined {
	if (!isMessageEntry(entry)) return undefined;
	if (entry.message.role === "toolResult") return entry.message.toolName;
	if (entry.message.role === "bashExecution") return entry.message.excludeFromContext ? undefined : "bash";
	return undefined;
}

export function cropCandidates(snapshot: SessionSnapshot): CropCandidate[] {
	const assistantsAfter: number[] = new Array(snapshot.contextEntries.length).fill(0);
	let count = 0;
	for (let index = snapshot.contextEntries.length - 1; index >= 0; index--) {
		assistantsAfter[index] = count;
		const entry = snapshot.contextEntries[index];
		if (entry && isMessageEntry(entry) && entry.message.role === "assistant") count += 1;
	}

	const latestPerTool = new Map<string, string>();
	for (const entry of snapshot.contextEntries) {
		const tool = toolNameOf(entry);
		if (tool) latestPerTool.set(tool, entry.id);
	}

	const candidates: CropCandidate[] = [];
	snapshot.contextEntries.forEach((entry, index) => {
		const tool = toolNameOf(entry);
		if (!tool) return;
		candidates.push({
			entryId: entry.id,
			tool,
			arg: primaryArg(snapshot, entry as MessageEntry),
			estTokens: estimateEntryTokens(entry),
			ageTurns: assistantsAfter[index] ?? 0,
			protected: latestPerTool.get(tool) === entry.id,
		});
	});
	return candidates;
}

export function autoSelect(candidates: CropCandidate[], rules: AutoRules): string[] {
	const minTokens = rules.minTokens ?? 10_000;
	const olderThan = rules.olderThanTurns ?? 2;
	const keep = rules.keep ?? [];
	return candidates
		.filter((candidate) => !candidate.protected)
		.filter((candidate) => candidate.estTokens >= minTokens)
		.filter((candidate) => candidate.ageTurns > olderThan)
		.filter(
			(candidate) =>
				!keep.some(
					(pattern) =>
						minimatch(candidate.tool, pattern, KEEP_MATCH_OPTIONS) ||
						(candidate.arg !== undefined && minimatch(candidate.arg, pattern, KEEP_MATCH_OPTIONS)),
				),
		)
		.map((candidate) => candidate.entryId);
}

export function planCrop(snapshot: SessionSnapshot, markedIds: string[]): CropPlan {
	const position = new Map(snapshot.contextEntries.map((entry, index) => [entry.id, index]));
	const croppable = new Set(cropCandidates(snapshot).map((candidate) => candidate.entryId));
	for (const id of markedIds) {
		if (!position.has(id)) throw new Error(`entry ${id} is not on the current path`);
		if (!croppable.has(id)) throw new Error(`entry ${id} is not croppable (only tool/MCP results are)`);
	}

	const ordered = [...markedIds].sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
	const earliest = ordered[0];
	const latest = ordered.at(-1);
	if (!earliest || !latest) throw new Error("nothing marked");
	const groupsByEntryId = candidateByEntryId(rangeCandidates(snapshot));
	const firstGroup = groupsByEntryId.get(earliest);
	const lastGroup = groupsByEntryId.get(latest);
	if (!firstGroup || !lastGroup) throw new Error("marked crop entry is not in a safe rewrite group");
	const rewrite = prepareRewrite(snapshot, firstGroup.startEntryId, lastGroup.endEntryId);
	const stubs: CtreeCropStub[] = ordered.map((id) => {
		const entry = snapshotEntry(snapshot, id) as MessageEntry;
		const body =
			entry.message.role === "bashExecution"
				? entry.message.output
				: textOfContent((entry.message as Extract<AgentMessage, { role: "toolResult" }>).content);
		return {
			entryId: id,
			tool: toolNameOf(entry) ?? "tool",
			arg: primaryArg(snapshot, entry),
			estTokens: estimateEntryTokens(entry),
			sha8: createHash("sha256").update(body).digest("hex").slice(0, 8),
		};
	});
	return {
		...rewrite,
		marked: ordered,
		reclaimTokens: stubs.reduce((total, stub) => total + stub.estTokens, 0),
		stubs,
		dropped: [],
	};
}

export function contextTurns(snapshot: SessionSnapshot): ContextTurn[] {
	const turns: ContextTurn[] = [];
	let current: ContextTurn | null = null;
	for (const entry of snapshot.contextEntries) {
		if (isUserMessage(entry)) {
			current = {
				userId: entry.id,
				label: firstLine(
					textOfContent(((entry as MessageEntry).message as Extract<AgentMessage, { role: "user" }>).content),
				),
				entryIds: [entry.id],
				estTokens: estimateEntryTokens(entry),
			};
			turns.push(current);
		} else if (current && isAnswerEntry(entry)) {
			current.entryIds.push(entry.id);
			current.estTokens += estimateEntryTokens(entry);
		} else {
			current = null;
		}
	}
	return turns;
}

export function planRemoveTurns(snapshot: SessionSnapshot, userIds: string[]): CropPlan {
	const position = new Map(snapshot.contextEntries.map((entry, index) => [entry.id, index]));
	const byUser = new Map(contextTurns(snapshot).map((turn) => [turn.userId, turn]));
	for (const id of userIds) {
		if (!byUser.has(id)) throw new Error(`entry ${id} is not a user question (only whole turns can be removed)`);
	}
	const ordered = [...userIds].sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
	const firstTurn = ordered[0] ? byUser.get(ordered[0]) : undefined;
	const lastTurn = ordered.at(-1) ? byUser.get(ordered.at(-1) as string) : undefined;
	const firstEntryId = firstTurn?.entryIds[0];
	const lastEntryId = lastTurn?.entryIds.at(-1);
	if (!firstEntryId || !lastEntryId) throw new Error("nothing marked");
	const groupsByEntryId = candidateByEntryId(rangeCandidates(snapshot));
	const firstGroup = groupsByEntryId.get(firstEntryId);
	const lastGroup = groupsByEntryId.get(lastEntryId);
	if (!firstGroup || !lastGroup) throw new Error("marked turn is not in a safe rewrite group");
	const rewrite = prepareRewrite(snapshot, firstGroup.startEntryId, lastGroup.endEntryId);
	const dropped: CtreeCropDrop[] = ordered.map((userId) => {
		const turn = byUser.get(userId) as ContextTurn;
		const body = turn.entryIds
			.map((id) => serializeEntry(snapshotEntry(snapshot, id) as SessionEntry) ?? "")
			.join("\n");
		return {
			userId,
			entryIds: turn.entryIds,
			label: turn.label,
			estTokens: turn.estTokens,
			sha8: createHash("sha256").update(body).digest("hex").slice(0, 8),
		};
	});
	return {
		...rewrite,
		marked: [],
		reclaimTokens: dropped.reduce((total, drop) => total + drop.estTokens, 0),
		stubs: [],
		dropped,
	};
}

function stubLine(stub: CtreeCropStub): string {
	return `[cropped: ${stub.tool}${stub.arg ? ` ${stub.arg}` : ""}, ~${fmtTokens(stub.estTokens)}, ${stub.sha8}]`;
}

function dropLine(drop: CtreeCropDrop): string {
	return `[dropped turn — ${drop.entryIds.length} entries, ~${fmtTokens(drop.estTokens)}, recoverable: ${drop.sha8}]`;
}

export function renderReconstruction(plan: CropPlan): string {
	const stubbed = new Map(plan.stubs.map((stub) => [stub.entryId, stub]));
	const dropFirst = new Map(plan.dropped.map((drop) => [drop.entryIds[0] as string, drop]));
	const droppedIds = new Set(plan.dropped.flatMap((drop) => drop.entryIds));
	const header =
		plan.dropped.length === 0
			? `[ctree/crop: rebuilt context after cropping ${plan.stubs.length} entries, ~${fmtTokens(
					plan.reclaimTokens,
				)} tokens reclaimed. Originals preserved on the previous branch (leaf ${plan.sourceLeafId}).]`
			: `[ctree/crop: rebuilt context after ${[
					`removing ${plan.dropped.length} turn${plan.dropped.length === 1 ? "" : "s"}`,
					plan.stubs.length ? `cropping ${plan.stubs.length} entr${plan.stubs.length === 1 ? "y" : "ies"}` : "",
				]
					.filter(Boolean)
					.join(" + ")}, ~${fmtTokens(
					plan.reclaimTokens,
				)} tokens reclaimed. Originals preserved on the previous branch (leaf ${plan.sourceLeafId}).]`;
	const parts: string[] = [];
	for (const entry of plan.selectedEntries) {
		const drop = dropFirst.get(entry.id);
		if (drop) {
			parts.push(dropLine(drop));
			continue;
		}
		if (droppedIds.has(entry.id)) continue;
		const stub = stubbed.get(entry.id);
		parts.push(stub ? stubLine(stub) : (serializeEntry(entry) ?? ""));
	}
	if (plan.continuationSerialized.trim()) parts.push(plan.continuationSerialized);
	return `${header}\n\n${parts.filter(Boolean).join("\n\n")}\n`;
}

function parseCropFlags(args: string): CropFlags {
	const parsed = parseArgs(args, {
		array: ["keep"],
		boolean: ["auto", "dry-run", "apply", "top"],
		number: ["min-tokens", "older-than"],
		string: ["keep"],
		configuration: PARSER_CONFIGURATION,
	});
	const keep = parsed.keep === undefined ? [] : (Array.isArray(parsed.keep) ? parsed.keep : [parsed.keep]).map(String);
	return {
		auto: parsed.auto === true,
		dryRun: parsed["dry-run"] === true,
		apply: parsed.apply === true,
		top: parsed.top === true,
		minTokens: typeof parsed["min-tokens"] === "number" ? parsed["min-tokens"] : undefined,
		olderThan: typeof parsed["older-than"] === "number" ? parsed["older-than"] : undefined,
		keep,
	};
}

function notifyDryRun(ctx: ExtensionCommandContext, plan: CropPlan): void {
	const lines = plan.stubs.map((stub) => `${stub.tool}${stub.arg ? ` ${stub.arg}` : ""} ~${fmtTokens(stub.estTokens)}`);
	ctx.ui.notify(
		`(dry-run) would crop ${plan.stubs.length}: ${lines.join(" · ")} — reclaim ~${fmtTokens(plan.reclaimTokens)}; nothing written`,
		"info",
	);
}

export async function applyCropPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: CropPlan): Promise<void> {
	const details = {
		v: 1 as const,
		sourceLeafId: plan.sourceLeafId,
		stubbed: plan.stubs,
		...(plan.dropped.length ? { dropped: plan.dropped } : {}),
	};
	try {
		const result = await applyRewrite(pi, ctx, plan, {
			messages: [
				{
					customType: CTREE_CROP_TAIL,
					content: renderReconstruction(plan),
					display: true,
					details,
				},
			],
			marker: { customType: CTREE_CROP, data: details },
		});
		if (!result.applied) {
			ctx.ui.notify("crop aborted — navigation cancelled, nothing written", "warning");
			return;
		}
	} catch (error) {
		ctx.ui.notify(`${(error as Error).message} re-run /crop (nothing written)`, "warning");
		return;
	}
	refreshAmbient(pi, ctx);
	ctx.ui.notify(cropAppliedMessage(plan), "info");
}

function cropAppliedMessage(plan: CropPlan): string {
	const parts: string[] = [];
	if (plan.dropped.length) parts.push(`removed ${plan.dropped.length} turn${plan.dropped.length === 1 ? "" : "s"}`);
	if (plan.stubs.length) {
		parts.push(`cropped ${plan.stubs.length} entr${plan.stubs.length === 1 ? "y" : "ies"} → stubs`);
	}
	return `✂ ${parts.join(" + ") || "nothing"} · ~${fmtTokens(plan.reclaimTokens)} reclaimed · originals on the previous branch`;
}

export async function cropHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	await ctx.waitForIdle();
	const flags = parseCropFlags(args);
	const state = deriveState(ctx);
	if (!state.leafId) {
		ctx.ui.notify("empty session — nothing to crop", "warning");
		return;
	}
	const candidates = cropCandidates(state);
	if (candidates.length === 0) {
		ctx.ui.notify("no tool/MCP results on this branch — nothing to crop", "info");
		return;
	}

	if (flags.top) {
		const unprotected = candidates.filter((candidate) => !candidate.protected);
		if (unprotected.length === 0) {
			ctx.ui.notify("every candidate is its tool's latest result (protected) — open /crop to double-mark", "info");
			return;
		}
		const top = unprotected.reduce((left, right) => (right.estTokens > left.estTokens ? right : left));
		const confirmed = await ctx.ui.confirm(
			"Crop the biggest result",
			`✂ ${top.tool}${top.arg ? ` ${top.arg}` : ""} ~${fmtTokens(top.estTokens)} → crop this result? (original stays recoverable)`,
		);
		if (!confirmed) {
			ctx.ui.notify("crop cancelled — nothing written", "info");
			return;
		}
		const plan = planCrop(state, [top.entryId]);
		if (flags.dryRun) return notifyDryRun(ctx, plan);
		await applyCropPlan(pi, ctx, plan);
		return;
	}

	if (flags.apply && !flags.auto) {
		ctx.ui.notify("--apply needs --auto rules (interactive review applies from the panel)", "error");
		return;
	}
	const premark = flags.auto
		? autoSelect(candidates, {
				minTokens: flags.minTokens,
				olderThanTurns: flags.olderThan,
				keep: flags.keep,
			})
		: [];
	if (flags.auto && flags.apply) {
		if (premark.length === 0) {
			ctx.ui.notify("--auto matched nothing (protected/latest results are skipped) — nothing to crop", "info");
			return;
		}
		const plan = planCrop(state, premark);
		if (flags.dryRun) return notifyDryRun(ctx, plan);
		await applyCropPlan(pi, ctx, plan);
		return;
	}
	if (flags.auto && premark.length === 0) {
		ctx.ui.notify("--auto matched nothing (protected/latest results are skipped) — opening review anyway", "info");
	}
	const { openPanel } = await import("./panel.ts");
	const action = await openPanel(pi, ctx, { initialView: "crop", premark, dryRun: flags.dryRun });
	if (!action || action.type !== "crop-apply") return;
	if (action.dryRun) return notifyDryRun(ctx, action.plan);
	await applyCropPlan(pi, ctx, action.plan);
}

export function registerCrop(pi: ExtensionAPI): void {
	pi.registerCommand("crop", {
		description:
			"pi-context-tree: surgically stub out huge tool/MCP results (--top for the biggest; interactive; --auto --apply --dry-run)",
		handler: (args, ctx) => cropHandler(pi, ctx, args),
		getArgumentCompletions: (prefix) => {
			const flags = ["--top", "--auto", "--apply", "--dry-run", "--min-tokens", "--older-than", "--keep"];
			const last = prefix.split(/\s+/).pop() ?? "";
			const matches = flags.filter((flag) => flag.startsWith(last));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
	});
}

function pruneNativeTree(tree: NativeTree, allowedEntryIds: ReadonlySet<string>): NativeTree {
	const pruneNode = (node: NativeTreeNode): NativeTreeNode[] => {
		const children = node.children.flatMap(pruneNode);
		return allowedEntryIds.has(node.entry.id) ? [{ ...node, children }] : children;
	};
	return tree.flatMap(pruneNode);
}

async function selectNativeEntry(
	ctx: ExtensionCommandContext,
	phase: RangePhase,
	initialSelectedId: string,
	allowedEntryIds: ReadonlySet<string>,
): Promise<string | undefined> {
	ctx.ui.notify(
		phase === "start" ? "Select the first entry of the range" : "Select the last entry of the range",
		"info",
	);
	if (!ctx.ui.custom) {
		ctx.ui.notify("The native tree selector is not available in this mode.", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>(
		(
			tui: { terminal: { rows: number } },
			_theme: unknown,
			_keybindings: unknown,
			done: (entryId: string | undefined) => void,
		) =>
			new TreeSelectorComponent(
				pruneNativeTree(ctx.sessionManager.getTree(), allowedEntryIds),
				ctx.sessionManager.getLeafId(),
				tui.terminal.rows,
				(entryId) => done(entryId),
				() => done(undefined),
				undefined,
				initialSelectedId,
				"default",
			),
	);
}

function buildRangeCompactData(
	plan: RewritePlan,
	approvedSummary: string,
	summaryModel: string,
): CtreeRangeCompactData {
	const summaryEstTokens = estimateTextTokens(approvedSummary);
	return {
		v: 1,
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

async function applyRangeCompressionPlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	initialPlan: RewritePlan,
	summaryModel: string,
	instructions: string | undefined,
	deps: Deps,
	progress?: RangeCompressionProgress,
	signal?: AbortSignal,
): Promise<boolean> {
	progress?.("Drafting summary");
	if (!progress) ctx.ui.notify(`drafting range summary with ${summaryModel}…`, "info");
	let generatedSummary: string;
	try {
		generatedSummary = (await draftRangeSummary(deps.draft, ctx, initialPlan.source, instructions, signal)).trim();
		if (!generatedSummary) throw new Error("model returned an empty range summary");
	} catch (error) {
		ctx.ui.notify(`range summary failed: ${(error as Error).message} (nothing written)`, "error");
		return false;
	}

	progress?.("Checking selected range");
	const details = buildRangeCompactData(initialPlan, generatedSummary, summaryModel);
	const rebuilt = renderRangeTail(initialPlan, generatedSummary);
	progress?.("Applying compression");
	try {
		const result = await applyRewrite(pi, ctx, initialPlan, {
			messages: [{ customType: CTREE_RANGE_TAIL, content: rebuilt, display: true, details }],
			marker: { customType: CTREE_RANGE_COMPACT, data: details },
		});
		if (!result.applied) {
			ctx.ui.notify("range compression cancelled during navigation — nothing written", "warning");
			return false;
		}
	} catch (error) {
		ctx.ui.notify(`selected range is no longer valid: ${(error as Error).message} (nothing written)`, "warning");
		return false;
	}
	refreshAmbient(pi, ctx);
	ctx.ui.notify(
		`compressed range: selected ~${fmtTokens(initialPlan.selectedEstTokens)} · summary ~${fmtTokens(details.summaryEstTokens)} · reclaimed ~${fmtTokens(details.reclaimedEstTokens)} tokens · originals kept at ${initialPlan.sourceLeafId}`,
		"info",
	);
	return true;
}

async function runBlockingRangeCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	plan: RewritePlan,
	instructions: string | undefined,
	deps: Deps,
): Promise<boolean> {
	if (ctx.sessionManager.getLeafId() !== plan.sourceLeafId) {
		ctx.ui.notify("session changed while the range selector was open — re-run /compress (nothing written)", "warning");
		return false;
	}
	const summaryModel = modelKey(ctx.model);
	if (!summaryModel) {
		ctx.ui.notify("no current model is available for the range summary — nothing written", "error");
		return false;
	}
	if (!ctx.ui.custom) return applyRangeCompressionPlan(pi, ctx, plan, summaryModel, instructions, deps);
	const result = await ctx.ui.custom<boolean>(
		(tui, theme, _keybindings, done) => {
			const rangeDetails = `summary model ${summaryModel} · ${plan.selectedEntryIds.length} selected entries · ~${fmtTokens(plan.selectedEstTokens)} source tokens`;
			const loader = new BorderedLoader(tui, theme, `Preparing compression · ${rangeDetails}`);
			let finished = false;
			const finish = (success: boolean): void => {
				if (finished) return;
				finished = true;
				done(success);
			};
			loader.onAbort = () => finish(false);
			void Promise.resolve()
				.then(() => applyRangeCompressionPlan(pi, ctx, plan, summaryModel, instructions, deps, () => {}, loader.signal))
				.then(finish, (error: unknown) => {
					if (!loader.signal.aborted) {
						ctx.ui.notify(`range compression failed: ${(error as Error).message} (nothing else written)`, "error");
					}
					finish(false);
				});
			return loader;
		},
		{ overlay: false },
	);
	return result ?? false;
}

export async function rangeCompressHandler(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	deps: Deps,
): Promise<void> {
	const instructions = args.trim() || undefined;
	await ctx.waitForIdle();
	const sourceLeafId = ctx.sessionManager.getLeafId();
	const state = deriveState(ctx);
	if (!sourceLeafId || !ctx.sessionManager.getEntry(sourceLeafId)) {
		ctx.ui.notify("empty session — nothing to compress", "warning");
		return;
	}
	const candidates = rangeCandidates(state);
	const allowedEntryIds = new Set(candidates.flatMap((candidate) => candidate.entryIds));
	const lastCandidate = candidates.at(-1);
	if (!lastCandidate) {
		ctx.ui.notify("no active context entries are available to compress", "warning");
		return;
	}

	let firstEntryId = "";
	let firstInitialId = allowedEntryIds.has(sourceLeafId) ? sourceLeafId : lastCandidate.endEntryId;
	while (!firstEntryId) {
		const selectedEntryId = await selectNativeEntry(ctx, "start", firstInitialId, allowedEntryIds);
		if (selectedEntryId === undefined) return;
		const endpoint = resolveRangeEndpoint(candidates, selectedEntryId, "start");
		if (!endpoint.ok) {
			ctx.ui.notify(`Invalid range start: ${endpoint.reason}. Select another entry.`, "warning");
			firstInitialId = selectedEntryId;
			continue;
		}
		firstEntryId = endpoint.entryId;
	}

	let secondInitialId = firstEntryId;
	while (true) {
		const selectedEntryId = await selectNativeEntry(ctx, "end", secondInitialId, allowedEntryIds);
		if (selectedEntryId === undefined) return;
		const endpoint = resolveRangeEndpoint(candidates, selectedEntryId, "end");
		if (!endpoint.ok) {
			ctx.ui.notify(`Invalid range end: ${endpoint.reason}. Select another entry.`, "warning");
			secondInitialId = selectedEntryId;
			continue;
		}
		let plan: RewritePlan;
		try {
			plan = prepareRewrite(state, firstEntryId, endpoint.entryId);
		} catch (error) {
			ctx.ui.notify(`Invalid range: ${(error as Error).message}. Select another last entry.`, "warning");
			secondInitialId = selectedEntryId;
			continue;
		}
		const startEntry = ctx.sessionManager.getEntry(plan.startEntryId);
		const endEntry = ctx.sessionManager.getEntry(plan.endEntryId);
		const startLabel = startEntry
			? (serializeEntry(startEntry)?.split("\n", 1)[0] ?? startEntry.type)
			: plan.startEntryId;
		const endLabel = endEntry ? (serializeEntry(endEntry)?.split("\n", 1)[0] ?? endEntry.type) : plan.endEntryId;
		const confirmed = await ctx.ui.confirm(
			"Compress selected range",
			[
				`Start: ${startLabel}`,
				`End: ${endLabel}`,
				`${plan.selectedEntryIds.length} entries · ~${fmtTokens(plan.selectedEstTokens)} tokens`,
				"The generated summary will be applied without review.",
				"Terminal input will pause until compression finishes.",
			].join("\n"),
		);
		if (!confirmed) return;
		await runBlockingRangeCompression(pi, ctx, plan, instructions, deps);
		return;
	}
}

export function registerRangeCompress(pi: ExtensionAPI, deps: Deps): void {
	pi.registerCommand("compress", {
		description: "pi-context-tree: select, summarize, and replace one active-context range",
		handler: (args, ctx) => rangeCompressHandler(pi, ctx, args, deps),
	});
}
