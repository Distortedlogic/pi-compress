import { createHash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type SessionMessageEntry,
	type SessionTreeNode,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import parseArgs from "yargs-parser";
import { deriveState, modelKey } from "./branches.ts";
import { estimateEntryTokens, estimateTextTokens, fmtTokens } from "./core/estimate.ts";
import {
	type RangeCandidate,
	type RewritePlan,
	applyRewrite,
	candidateByEntryId,
	prepareRewrite,
	rangeCandidates,
	resolveRangeEndpoint,
	sourceSha8,
} from "./core/range-rewrite.ts";
import { serializeEntry } from "./core/serialize.ts";
import { type Deps, draftRangeSummary } from "./extension/draft.ts";
import { refreshAmbient } from "./panel.ts";
import {
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CtreeCropDrop,
	type CtreeCropStub,
	type CtreeRangeCompactData,
} from "./protocol.ts";
import { type SessionSnapshot, snapshotEntry, snapshotSession } from "./session.ts";

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

type RangePhase = "start" | "end";
type RangeCompressionStage = "Drafting summary" | "Checking selected range" | "Applying compression";
type RangeCompressionProgress = (stage: RangeCompressionStage) => void;

interface RangeSelectorProjection {
	tree: SessionTreeNode[];
	entryIds: string[];
}

const PRIMARY_ARG_KEYS = ["path", "file_path", "url", "command", "query", "name"];
const PARSER_CONFIGURATION = {
	"boolean-negation": false,
	"camel-case-expansion": false,
	"parse-numbers": false,
	"unknown-options-as-args": true,
} as const;
const KEEP_MATCH_OPTIONS = { dot: true, matchBase: true } as const;

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

function indexTreeNodes(tree: readonly SessionTreeNode[]): Map<string, SessionTreeNode> {
	const byId = new Map<string, SessionTreeNode>();
	const pending = [...tree];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!node) continue;
		byId.set(node.entry.id, node);
		pending.push(...node.children);
	}
	return byId;
}

function buildLinearSelectorProjection(
	ctx: ExtensionCommandContext,
	entryIds: readonly string[],
): RangeSelectorProjection {
	const activeEntryIds = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
	const treeNodes = indexTreeNodes(ctx.sessionManager.getTree());
	const sourceNodes = entryIds.flatMap((entryId) => {
		if (!activeEntryIds.has(entryId)) return [];
		const node = treeNodes.get(entryId);
		return node ? [node] : [];
	});
	let child: SessionTreeNode | undefined;
	for (let index = sourceNodes.length - 1; index >= 0; index--) {
		const source = sourceNodes[index];
		if (!source) continue;
		child = {
			entry: source.entry,
			children: child ? [child] : [],
			label: source.label,
			labelTimestamp: source.labelTimestamp,
		};
	}
	return {
		tree: child ? [child] : [],
		entryIds: sourceNodes.map((node) => node.entry.id),
	};
}

function buildStartSelectorProjection(
	ctx: ExtensionCommandContext,
	candidates: readonly RangeCandidate[],
): RangeSelectorProjection {
	const entryIds = candidates.flatMap((candidate) => {
		if (candidate.protected) return [];
		const endpoint = resolveRangeEndpoint(candidates, candidate.startEntryId, "start");
		return endpoint.ok ? [endpoint.entryId] : [];
	});
	return buildLinearSelectorProjection(ctx, entryIds);
}

function buildEndSelectorProjection(
	ctx: ExtensionCommandContext,
	candidates: readonly RangeCandidate[],
	startCandidateIndex: number,
): RangeSelectorProjection {
	const entryIds: string[] = [];
	for (let index = startCandidateIndex; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (!candidate || candidate.protected) break;
		const endpoint = resolveRangeEndpoint(candidates, candidate.endEntryId, "end");
		if (!endpoint.ok) break;
		entryIds.push(endpoint.entryId);
	}
	return buildLinearSelectorProjection(ctx, entryIds);
}

async function selectNativeEntry(
	ctx: ExtensionCommandContext,
	phase: RangePhase,
	projection: RangeSelectorProjection,
	initialSelectedId: string,
): Promise<string | undefined> {
	ctx.ui.notify(
		phase === "start" ? "Select the first entry of the range" : "Select the last entry of the range",
		"info",
	);
	if (ctx.mode !== "tui") {
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
				projection.tree,
				projection.entryIds.at(-1) ?? null,
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
	if (ctx.mode !== "tui") return applyRangeCompressionPlan(pi, ctx, plan, summaryModel, instructions, deps);
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
	const startProjection = buildStartSelectorProjection(ctx, candidates);
	const firstInitialId = startProjection.entryIds.at(-1);
	if (!firstInitialId) {
		ctx.ui.notify("no legal active-context range starts are available", "warning");
		return;
	}

	const firstEntryId = await selectNativeEntry(ctx, "start", startProjection, firstInitialId);
	if (firstEntryId === undefined) return;
	if (!startProjection.entryIds.includes(firstEntryId)) {
		ctx.ui.notify("the selected range start is not available; run /compress again", "warning");
		return;
	}
	if (ctx.sessionManager.getSessionId() !== state.sessionId || ctx.sessionManager.getLeafId() !== sourceLeafId) {
		ctx.ui.notify("the session changed while the range selector was open; run /compress again", "warning");
		return;
	}

	const startCandidateIndex = candidates.findIndex(
		(candidate) => !candidate.protected && candidate.startEntryId === firstEntryId,
	);
	if (startCandidateIndex === -1) {
		ctx.ui.notify("the selected range start is no longer valid; run /compress again", "warning");
		return;
	}
	const endProjection = buildEndSelectorProjection(ctx, candidates, startCandidateIndex);
	const secondInitialId = endProjection.entryIds[0];
	if (!secondInitialId) {
		ctx.ui.notify("no legal range ends are available after the selected start", "warning");
		return;
	}

	const endEntryId = await selectNativeEntry(ctx, "end", endProjection, secondInitialId);
	if (endEntryId === undefined) return;
	if (!endProjection.entryIds.includes(endEntryId)) {
		ctx.ui.notify("the selected range end is not available; run /compress again", "warning");
		return;
	}

	let plan: RewritePlan;
	try {
		const fresh = snapshotSession(ctx.sessionManager);
		if (fresh.sessionId !== state.sessionId || fresh.leafId !== sourceLeafId) {
			throw new Error("the session changed while the range selector was open");
		}
		plan = prepareRewrite(fresh, firstEntryId, endEntryId);
	} catch (error) {
		ctx.ui.notify(`Invalid range: ${(error as Error).message}. Run /compress again.`, "warning");
		return;
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
}

export function registerRangeCompress(pi: ExtensionAPI, deps: Deps): void {
	pi.registerCommand("compress", {
		description: "pi-context-tree: select, summarize, and replace one active-context range",
		handler: (args, ctx) => rangeCompressHandler(pi, ctx, args, deps),
	});
}
