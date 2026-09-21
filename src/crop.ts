import { hash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { refreshAmbient } from "./ambient.ts";
import { estimateEntryTokens, fmtTokens, type SessionSnapshot, serializeEntry, snapshotEntry } from "./context.ts";
import { CTREE_CROP, CTREE_CROP_TAIL, type CtreeCropDrop, type CtreeCropStub } from "./protocol.ts";
import { applyRewrite, candidateByEntryId, prepareRewrite, type RewritePlan, rangeCandidates } from "./rewrite.ts";

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

const PRIMARY_ARG_KEYS = ["path", "file_path", "url", "command", "query", "name"];
const KEEP_MATCH_OPTIONS = { dot: true, matchBase: true } as const;

function firstLine(text: string, max = 80): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isAnswerEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	return role === "assistant" || role === "toolResult" || role === "bashExecution";
}

function primaryArg(snapshot: SessionSnapshot, entry: SessionMessageEntry): string | undefined {
	const message = entry.message;
	if (message.role === "bashExecution") return message.command.slice(0, 60);
	if (message.role !== "toolResult") return undefined;
	const parent = entry.parentId ? snapshotEntry(snapshot, entry.parentId) : undefined;
	if (!parent || parent.type !== "message" || parent.message.role !== "assistant") return undefined;
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
	if (entry.type !== "message") return undefined;
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
		if (entry?.type === "message" && entry.message.role === "assistant") count += 1;
	}

	const latestPerTool = new Map<string, string>();
	for (const entry of snapshot.contextEntries) {
		const tool = toolNameOf(entry);
		if (tool) latestPerTool.set(tool, entry.id);
	}

	const candidates: CropCandidate[] = [];
	snapshot.contextEntries.forEach((entry, index) => {
		if (entry.type !== "message") return;
		const tool = toolNameOf(entry);
		if (!tool) return;
		candidates.push({
			entryId: entry.id,
			tool,
			arg: primaryArg(snapshot, entry),
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

function prepareMarkedRange(
	snapshot: SessionSnapshot,
	firstEntryId: string | undefined,
	lastEntryId: string | undefined,
	invalidGroupMessage: string,
): RewritePlan {
	if (!firstEntryId || !lastEntryId) throw new Error("nothing marked");
	const groupsByEntryId = candidateByEntryId(rangeCandidates(snapshot));
	const firstGroup = groupsByEntryId.get(firstEntryId);
	const lastGroup = groupsByEntryId.get(lastEntryId);
	if (!firstGroup || !lastGroup) throw new Error(invalidGroupMessage);
	return prepareRewrite(snapshot, firstGroup.startEntryId, lastGroup.endEntryId);
}

export function planCrop(snapshot: SessionSnapshot, markedIds: string[]): CropPlan {
	const position = new Map(snapshot.contextEntries.map((entry, index) => [entry.id, index]));
	const croppable = new Set(cropCandidates(snapshot).map((candidate) => candidate.entryId));
	for (const id of markedIds) {
		if (!position.has(id)) throw new Error(`entry ${id} is not on the current path`);
		if (!croppable.has(id)) throw new Error(`entry ${id} is not croppable (only tool/MCP results are)`);
	}

	const ordered = [...markedIds].sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
	const rewrite = prepareMarkedRange(
		snapshot,
		ordered[0],
		ordered.at(-1),
		"marked crop entry is not in a safe rewrite group",
	);
	const stubs: CtreeCropStub[] = ordered.map((id) => {
		const entry = snapshotEntry(snapshot, id);
		if (!entry || entry.type !== "message") throw new Error(`entry ${id} is not a message`);
		let body: string;
		if (entry.message.role === "bashExecution") body = entry.message.output;
		else if (entry.message.role === "toolResult") body = contentText(entry.message.content, "\n");
		else throw new Error(`entry ${id} is not a tool result`);
		return {
			entryId: id,
			tool: toolNameOf(entry) ?? "tool",
			arg: primaryArg(snapshot, entry),
			estTokens: estimateEntryTokens(entry),
			sha8: hash("sha256", body, "hex").slice(0, 8),
		};
	});
	return {
		...rewrite,
		reclaimTokens: stubs.reduce((total, stub) => total + stub.estTokens, 0),
		stubs,
		dropped: [],
	};
}

export function contextTurns(snapshot: SessionSnapshot): ContextTurn[] {
	const turns: ContextTurn[] = [];
	let current: ContextTurn | null = null;
	for (const entry of snapshot.contextEntries) {
		if (entry.type === "message" && entry.message.role === "user") {
			current = {
				userId: entry.id,
				label: firstLine(contentText(entry.message.content, "\n")),
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
	const rewrite = prepareMarkedRange(
		snapshot,
		firstTurn?.entryIds[0],
		lastTurn?.entryIds.at(-1),
		"marked turn is not in a safe rewrite group",
	);
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
			sha8: hash("sha256", body, "hex").slice(0, 8),
		};
	});
	return {
		...rewrite,
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
			? `[pi-compress/crop: rebuilt context after cropping ${plan.stubs.length} entries, ~${fmtTokens(
					plan.reclaimTokens,
				)} tokens reclaimed. Originals preserved on the previous branch (leaf ${plan.sourceLeafId}).]`
			: `[pi-compress/crop: rebuilt context after ${[
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

export async function applyCropPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: CropPlan): Promise<void> {
	const details = {
		v: 1 as const,
		sourceLeafId: plan.sourceLeafId,
		stubbed: plan.stubs,
		...(plan.dropped.length ? { dropped: plan.dropped } : {}),
	};
	try {
		const applied = await applyRewrite(pi, ctx, plan, {
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
		if (!applied) {
			ctx.ui.notify("crop aborted — navigation cancelled, nothing written", "warning");
			return;
		}
	} catch (error) {
		ctx.ui.notify(`${(error as Error).message} re-run /crop (nothing written)`, "warning");
		return;
	}
	refreshAmbient(ctx);
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
