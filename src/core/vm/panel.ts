/**
 * Panel view-model (F4) — pure state + reducers, no terminal code. The TUI
 * component and the standalone pitree host render `rows()` and feed
 * `handleKey()`; mutations leave as PanelActions for the host to execute
 * (and re-validate) via pi. Read-only mode (pitree, F4.6) blocks them all.
 */

import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { type ForkInfo, type ForkPresentation, decisionsOnPath, nearestOpenFork } from "../../branches.ts";
import {
	type ContextTurn,
	type CropCandidate,
	type CropPlan,
	autoSelect,
	contextTurns,
	cropCandidates,
	planCrop,
	planRemoveTurns,
} from "../../compression.ts";
import {
	CTREE_CROP,
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	ctreeCloseData,
	ctreeCropData,
	ctreeDecisionDetails,
	ctreeRangeCompactData,
	ctreeRangeTailDetails,
} from "../../protocol.ts";
import type { SessionSnapshot } from "../../session.ts";
import { aggregateConsumers } from "../consumers.ts";
import { type Band, band, estimateContextTokens, estimateEntryTokens, fmtTokens } from "../estimate.ts";
import { serializeEntry, textOfContent } from "../serialize.ts";
import type { SessionEntry, UserContent } from "../types.ts";
import { isCustomMessageEntry, isMessageEntry } from "../types.ts";

export type PanelView = "tree" | "crop" | "consumers" | "decisions" | "inspect";

export interface PanelInput {
	sessionId: string;
	entries: SessionEntry[];
	branch: SessionEntry[];
	contextEntries: SessionEntry[];
	tree: SessionTreeNode[];
	forks: ForkInfo[];
	leafId: string | null;
	project: string;
	sessionName?: string;
	model?: string;
	contextWindow?: number;
	/** real token count from pi's getContextUsage(); null = unknown (post-compaction) */
	usageTokens?: number | null;
	readOnly?: boolean;
	dryRun?: boolean;
	initialView?: PanelView;
	premark?: string[];
}

export type PanelAction =
	| { type: "close" }
	| { type: "jump"; entryId: string }
	| { type: "branch"; entryId: string }
	| { type: "merge" }
	| { type: "crop-apply"; plan: CropPlan; dryRun: boolean };

export interface VmEffect {
	action?: PanelAction;
	notify?: string;
}

export interface PanelRow {
	kind: "entry" | "fork" | "crop" | "turn" | "consumer" | "decision" | "inspect-line";
	id?: string;
	depth: number;
	glyph: string;
	text: string;
	tokens?: number;
	warn?: boolean;
	current?: boolean;
	onPath?: boolean;
	dim?: boolean;
	// fork rows
	forkName?: string;
	presentation?: ForkPresentation;
	foldable?: boolean;
	folded?: boolean;
	// crop rows
	marked?: boolean;
	protected?: boolean;
	armed?: boolean;
	age?: number;
	// consumer rows
	share?: number;
	// turn rows
	entryCount?: number;
}

export interface PanelHeader {
	project: string;
	sessionName?: string;
	branchName: string;
	model?: string;
	view: PanelView;
	tokens: number;
	window?: number;
	pct?: number;
	band?: Band;
	estimated: boolean;
	readOnly: boolean;
}

const FIRST_LINE_MAX = 88;

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX)}…` : line;
}

export class PanelVm {
	readonly input: PanelInput;
	readonly tree: SessionTreeNode[];
	readonly leafId: string;
	readonly forks: ForkInfo[];
	private readonly snapshot: SessionSnapshot;
	private readonly branchIds: Set<string>;
	private readonly entryById: Map<string, SessionEntry>;
	private readonly forkById: Map<string, ForkInfo>;
	private readonly slice: SessionEntry[];
	private candidates: CropCandidate[] | null = null;
	private turnsCache: ContextTurn[] | null = null;

	view: PanelView;
	sel = 0;
	/** crop sub-mode: stub individual tool results, or remove whole Q&A turns */
	private cropMode: "result" | "turn" = "result";
	private readonly folds = new Map<string, boolean>();
	private readonly marks = new Set<string>();
	private readonly turnMarks = new Set<string>();
	private armedId: string | null = null;
	private inspectId: string | null = null;

	constructor(input: PanelInput) {
		this.input = input;
		this.tree = input.tree;
		this.leafId = input.leafId ?? "";
		this.forks = input.forks;
		this.snapshot = {
			sessionId: input.sessionId,
			entries: input.entries,
			branch: input.branch,
			contextEntries: input.contextEntries,
			tree: input.tree,
			leafId: input.leafId,
		};
		this.branchIds = new Set(input.branch.map((entry) => entry.id));
		this.entryById = new Map(input.entries.map((entry) => [entry.id, entry]));
		this.forkById = new Map(this.forks.map((fork) => [fork.entryId, fork]));
		this.slice = input.contextEntries;
		this.view = input.initialView ?? "tree";
		for (const id of input.premark ?? []) this.marks.add(id);
		for (const f of this.forks) if (f.status !== "open") this.folds.set(f.entryId, true);
	}

	header(): PanelHeader {
		const open = nearestOpenFork(this.snapshot.branch, this.forks);
		// pi reports usage 0 until a fresh assistant turn lands (right after load or
		// compaction) — for a non-empty slice that would draw a 0% gauge over a fat
		// context, so fall back to the chars/4 estimate instead (§11.5).
		const usable = typeof this.input.usageTokens === "number" && this.input.usageTokens > 0;
		const estimated = !usable;
		const tokens = usable ? (this.input.usageTokens as number) : estimateContextTokens(this.slice);
		const window = this.input.contextWindow;
		const pct = window && window > 0 ? (tokens / window) * 100 : undefined;
		return {
			project: this.input.project,
			sessionName: this.input.sessionName,
			branchName: open?.data.name ?? "trunk",
			model: this.input.model,
			view: this.view,
			tokens,
			window,
			pct,
			band: pct === undefined ? undefined : band(pct),
			estimated,
			readOnly: this.input.readOnly ?? false,
		};
	}

	// -- rows -----------------------------------------------------------------

	rows(): PanelRow[] {
		switch (this.view) {
			case "tree":
				return this.treeRows();
			case "crop":
				return this.cropMode === "turn" ? this.turnRows() : this.cropRows();
			case "consumers":
				return this.consumerRows();
			case "decisions":
				return this.decisionRows();
			case "inspect":
				return this.inspectRows();
		}
	}

	private effectiveFold(forkId: string): boolean {
		const f = this.forkById.get(forkId);
		const def = f ? f.status !== "open" : false;
		return this.folds.get(forkId) ?? def;
	}

	private treeRows(): PanelRow[] {
		const currentFork = nearestOpenFork(this.snapshot.branch, this.forks);
		const rows: PanelRow[] = [];
		const visit = (node: SessionTreeNode, depth: number): void => {
			const entry = node.entry;
			const fork = this.forkById.get(entry.id);
			if (fork) {
				const folded = this.effectiveFold(entry.id);
				rows.push({
					kind: "fork",
					id: entry.id,
					depth,
					glyph: "⎇",
					text: `${fork.data.name} · ${fork.status}${fork.data.branchModel ? ` · ${fork.data.branchModel}` : ""}`,
					forkName: fork.data.name,
					presentation: fork.presentation,
					foldable: true,
					folded,
					onPath: fork.onCurrentPath,
					current: fork.entryId === currentFork?.entryId,
				});
				for (const child of node.children) {
					if (folded && !this.branchIds.has(child.entry.id)) continue;
					visit(child, depth + 1);
				}
				return;
			}
			rows.push(this.entryRow(entry, depth));
			for (const child of node.children) visit(child, depth);
		};
		for (const root of this.tree) visit(root, 0);
		return rows;
	}

	private entryRow(e: SessionEntry, depth: number): PanelRow {
		const tokens = estimateEntryTokens(e);
		const row: PanelRow = {
			kind: "entry",
			id: e.id,
			depth,
			glyph: "·",
			text: e.type,
			tokens: tokens > 0 ? tokens : undefined,
			warn: tokens >= 10_000,
			current: e.id === this.leafId,
			onPath: this.branchIds.has(e.id),
		};
		if (isMessageEntry(e)) {
			const m = e.message;
			if (m.role === "user") {
				row.glyph = "●";
				row.text = `user: ${firstLine(textOfContent(m.content))}`;
			} else if (m.role === "assistant") {
				row.glyph = "○";
				const texts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
				const calls = m.content.filter((b) => b.type === "toolCall").map((b) => (b as { name: string }).name);
				row.text = texts.length ? `assistant: ${firstLine(texts.join(" "))}` : `assistant → ${calls.join(", ") || "…"}`;
			} else if (m.role === "toolResult") {
				row.glyph = "⚙";
				row.text = `[${m.toolName}]${m.isError ? " ✗" : ""}`;
			} else if (m.role === "bashExecution") {
				row.glyph = "⚙";
				row.text = `[bash $ ${firstLine(m.command)}]`;
			} else {
				row.glyph = "▪";
				row.text = `[${m.role}]`;
			}
			return row;
		}
		switch (e.type) {
			case "custom_message": {
				const t = e.customType;
				if (t === CTREE_DECISION) {
					const details = ctreeDecisionDetails(e);
					row.glyph = "◆";
					row.text = `Decision: ${details?.branchName ?? firstLine(textOfContent(e.content))}`;
				} else if (t === CTREE_CROP_TAIL) {
					row.glyph = "✂";
					row.text = "[crop tail — rebuilt context]";
				} else if (t === CTREE_RANGE_TAIL) {
					const details = ctreeRangeTailDetails(e);
					row.glyph = "≣";
					row.text = `[range compact — summary + continuation · ${details?.selectedEntryIds.length ?? 0} source entries]`;
				} else {
					row.glyph = "▪";
					row.text = `[${t}]`;
				}
				return row;
			}
			case "custom": {
				const ct = e.customType;
				const close = ctreeCloseData(e);
				if (close) {
					const fork = this.forkById.get(close.forkEntryId);
					row.text = `closed ⎇ ${fork?.data.name ?? close.forkEntryId} · ${close.status}${close.note ? ` · "${close.note}"` : ""}`;
				} else if (ct === CTREE_CROP) {
					const data = ctreeCropData(e);
					row.glyph = "✂";
					row.text = `crop marker · ${data?.stubbed.length ?? 0} stubbed`;
				} else if (ct === CTREE_RANGE_COMPACT) {
					const d = ctreeRangeCompactData(e);
					row.glyph = "≣";
					row.text = `range compact marker · ${d?.selectedEntryIds.length ?? 0} entries · ~${fmtTokens(d?.selectedEstTokens ?? 0)} source tokens`;
				} else {
					row.text = `[${ct}]`;
				}
				row.dim = true;
				return row;
			}
			case "branch_summary":
				row.glyph = "≣";
				row.text = `branch summary: ${firstLine((e as { summary: string }).summary)}`;
				return row;
			case "compaction":
				row.glyph = "≣";
				row.text = `compaction: ${firstLine((e as { summary: string }).summary)}`;
				return row;
			case "model_change":
				row.text = `model → ${(e as { modelId: string }).modelId}`;
				row.dim = true;
				return row;
			case "label":
				row.text = `label: ${(e as { label?: string }).label ?? "(cleared)"}`;
				row.dim = true;
				return row;
			case "session_info":
				row.text = `session: ${(e as { name?: string }).name ?? ""}`;
				row.dim = true;
				return row;
			default:
				row.dim = true;
				return row;
		}
	}

	private getCandidates(): CropCandidate[] {
		if (!this.candidates) this.candidates = this.leafId ? cropCandidates(this.snapshot) : [];
		return this.candidates;
	}

	private getTurns(): ContextTurn[] {
		if (!this.turnsCache) this.turnsCache = this.leafId ? contextTurns(this.snapshot) : [];
		return this.turnsCache;
	}

	/** the turn you're currently in (contains the leaf) — protected from removal */
	private currentTurnId(): string | undefined {
		return this.getTurns().find((t) => t.entryIds.includes(this.leafId))?.userId;
	}

	private turnRows(): PanelRow[] {
		const current = this.currentTurnId();
		return this.getTurns().map((t) => ({
			kind: "turn" as const,
			id: t.userId,
			depth: 0,
			glyph: "●",
			text: `user: ${t.label}`,
			tokens: t.estTokens,
			entryCount: t.entryIds.length,
			marked: this.turnMarks.has(t.userId),
			protected: t.userId === current,
		}));
	}

	private cropRows(): PanelRow[] {
		return this.getCandidates().map((c) => ({
			kind: "crop" as const,
			id: c.entryId,
			depth: 0,
			glyph: "⚙",
			text: `[${c.tool}${c.arg ? ` ${c.arg}` : ""}]`,
			tokens: c.estTokens,
			warn: c.estTokens >= 10_000,
			marked: this.marks.has(c.entryId),
			protected: c.protected,
			armed: this.armedId === c.entryId,
			age: c.ageTurns,
		}));
	}

	private consumerRows(): PanelRow[] {
		return aggregateConsumers(this.slice).map((r) => ({
			kind: "consumer" as const,
			depth: 0,
			glyph: " ",
			text: `${r.key} · ${r.entries} ${r.entries === 1 ? "entry" : "entries"} · ${(r.share * 100).toFixed(0)}%`,
			tokens: r.tokens,
			share: r.share,
		}));
	}

	/** mockup card: ◆ name / meta (date · model · branch · confirmed) / outcome / ✗ epitaphs */
	private decisionRows(): PanelRow[] {
		const decs = decisionsOnPath(this.snapshot.branch);
		if (decs.length === 0) {
			return [
				{
					kind: "decision",
					depth: 0,
					glyph: " ",
					text: "(no decision records on this trunk yet — /merge → squash creates them)",
					dim: true,
				},
			];
		}
		const rows: PanelRow[] = [];
		for (const d of [...decs].reverse()) {
			const det = ctreeDecisionDetails(d);
			const fork = det ? this.forkById.get(det.forkEntryId) : undefined;
			const model = fork?.data.branchModel ?? fork?.data.trunkModel ?? "—";
			const date = (d.timestamp ?? "").slice(0, 10);
			const text = textOfContent(d.content);
			const outcomeLine = text.split("\n").find((l) => l.startsWith("**Outcome:**"));
			const outcome = outcomeLine ? outcomeLine.replace("**Outcome:**", "").trim() : firstLine(text);
			rows.push({
				kind: "decision",
				id: d.id,
				depth: 0,
				glyph: "◆",
				text: det?.branchName ?? "decision",
				tokens: estimateEntryTokens(d),
			});
			rows.push({
				kind: "decision",
				id: d.id,
				depth: 1,
				glyph: " ",
				dim: true,
				text: `${date} · drafted by ${model} · branch ${det?.forkEntryId ?? "—"} · human-confirmed ✓`,
			});
			rows.push({ kind: "decision", id: d.id, depth: 1, glyph: " ", text: outcome });
			for (const s of det?.siblings ?? []) {
				rows.push({ kind: "decision", id: d.id, depth: 1, glyph: "✗", text: `${s.name} — ${s.reason}` });
			}
		}
		rows.push({
			kind: "decision",
			depth: 0,
			glyph: " ",
			dim: true,
			text: "(epitaphs keep the trunk model from re-proposing rejected approaches — G3)",
		});
		return rows;
	}

	private inspectRows(): PanelRow[] {
		const e = this.inspectId ? this.entryById.get(this.inspectId) : undefined;
		if (!e) return [{ kind: "inspect-line", depth: 0, glyph: " ", text: "(nothing selected)", dim: true }];
		const tokens = estimateEntryTokens(e);
		const tool =
			isMessageEntry(e) && e.message.role === "toolResult"
				? ` · tool ${(e.message as { toolName: string }).toolName}`
				: "";
		const meta = `id ${e.id} · type ${e.type}${tool} · ~${fmtTokens(tokens)} tokens (${(tokens * 4).toLocaleString("en-US")} chars) · parent ${e.parentId ?? "—"}`;
		const body = serializeEntry(e) ?? "(no content)";
		const lines = body.split("\n").slice(0, 400);
		return [
			{ kind: "inspect-line", depth: 0, glyph: " ", text: meta, dim: true },
			...lines.map((l) => ({ kind: "inspect-line" as const, depth: 0, glyph: " ", text: l })),
		];
	}

	// -- input ----------------------------------------------------------------

	private selectedRow(): PanelRow | undefined {
		return this.rows()[this.sel];
	}

	private setView(v: PanelView): void {
		this.view = v;
		this.sel = 0;
		this.armedId = null;
	}

	private deny(): VmEffect {
		return { notify: "read-only (standalone pitree) — open the panel inside pi to act" };
	}

	handleKey(key: string): VmEffect {
		const rows = this.rows();
		const max = Math.max(0, rows.length - 1);
		const readOnly = this.input.readOnly ?? false;

		switch (key) {
			case "j":
			case "down":
				this.sel = Math.min(max, this.sel + 1);
				return {};
			case "k":
			case "up":
				this.sel = Math.max(0, this.sel - 1);
				return {};
			case "g":
				this.sel = 0;
				return {};
			case "G":
				this.sel = max;
				return {};
			case "q":
				return { action: { type: "close" } };
			case "esc":
				if (this.view === "tree") return { action: { type: "close" } };
				this.setView("tree");
				return {};
		}

		if (this.view === "tree") {
			const row = this.selectedRow();
			switch (key) {
				case "enter":
				case "right":
				case "left": {
					if (row?.kind === "fork" && row.id) {
						if (key === "enter" || (key === "right") === Boolean(row.folded)) {
							this.folds.set(row.id, !this.effectiveFold(row.id));
						}
						return {};
					}
					if (key !== "enter") return {};
					if (!row?.id) return {};
					if (readOnly) return this.deny();
					return { action: { type: "jump", entryId: row.id } };
				}
				case "b":
					if (!row?.id) return {};
					if (readOnly) return this.deny();
					return { action: { type: "branch", entryId: row.id } };
				case "m":
					if (readOnly) return this.deny();
					return { action: { type: "merge" } };
				case "c":
					this.setView("crop");
					return {};
				case "i":
					if (row?.id) {
						this.inspectId = row.id;
						this.setView("inspect");
					}
					return {};
				case "D":
					this.setView("decisions");
					return {};
				case "u":
					this.setView("consumers");
					return {};
			}
			return {};
		}

		if (this.view === "crop") {
			if (key === "t") {
				this.cropMode = this.cropMode === "turn" ? "result" : "turn";
				this.sel = 0;
				this.armedId = null;
				return {};
			}
			return this.cropMode === "turn" ? this.handleTurnKey(key, readOnly) : this.handleCropKey(key, readOnly);
		}

		if (this.view === "decisions") {
			if (key === "enter") {
				return this.handleDecisionsEnter(readOnly);
			}
			return {};
		}

		if (this.view === "consumers") {
			if (key === "c") {
				this.setView("crop");
				return {};
			}
			return {};
		}

		if (this.view === "inspect") {
			if (key === "c") {
				if (readOnly) return this.deny();
				const id = this.inspectId;
				if (id && this.getCandidates().some((c) => c.entryId === id)) {
					this.marks.add(id);
					this.cropMode = "result";
					this.setView("crop");
					return { notify: "pre-marked from inspector — review, then ⏎ to apply" };
				}
				return { notify: "only tool/MCP results are croppable (F3.3)" };
			}
			return {};
		}

		return {};
	}

	private handleCropKey(key: string, readOnly: boolean): VmEffect {
		const cands = this.getCandidates();
		const cand = cands[this.sel];
		switch (key) {
			case "space": {
				if (readOnly) return this.deny();
				if (!cand) return {};
				if (this.marks.has(cand.entryId)) {
					this.marks.delete(cand.entryId);
					this.armedId = null;
					return {};
				}
				if (cand.protected && this.armedId !== cand.entryId) {
					this.armedId = cand.entryId;
					return { notify: `${cand.tool} is the latest result of its tool — space again to crop it anyway (F3.3)` };
				}
				this.marks.add(cand.entryId);
				this.armedId = null;
				return {};
			}
			case "a": {
				if (readOnly) return this.deny();
				const ids = autoSelect(cands, {});
				for (const id of ids) this.marks.add(id);
				return { notify: `--auto marked ${ids.length} (protected skipped) — review, then ⏎ to apply` };
			}
			case "enter": {
				if (readOnly) return this.deny();
				if (this.marks.size === 0) return { notify: "nothing marked — space to mark entries" };
				const plan = planCrop(this.snapshot, [...this.marks]);
				return { action: { type: "crop-apply", plan, dryRun: this.input.dryRun ?? false } };
			}
			case "c":
				this.setView("tree");
				return {};
		}
		return {};
	}

	private handleTurnKey(key: string, readOnly: boolean): VmEffect {
		const turns = this.getTurns();
		const turn = turns[this.sel];
		switch (key) {
			case "space": {
				if (readOnly) return this.deny();
				if (!turn) return {};
				if (turn.userId === this.currentTurnId()) {
					return { notify: "that's the current turn (you're in it) — can't remove it" };
				}
				if (this.turnMarks.has(turn.userId)) this.turnMarks.delete(turn.userId);
				else this.turnMarks.add(turn.userId);
				return {};
			}
			case "enter": {
				if (readOnly) return this.deny();
				if (this.turnMarks.size === 0) return { notify: "no turns marked — space to mark a whole Q&A turn" };
				const plan = planRemoveTurns(this.snapshot, [...this.turnMarks]);
				return { action: { type: "crop-apply", plan, dryRun: this.input.dryRun ?? false } };
			}
			case "c":
				this.setView("tree");
				return {};
		}
		return {};
	}

	private handleDecisionsEnter(readOnly: boolean): VmEffect {
		const row = this.selectedRow();
		if (!row?.id) return {};
		if (readOnly) return this.deny();
		return { action: { type: "jump", entryId: row.id } };
	}

	/** mockup secthead line under the divider; undefined = no section title (inspect) */
	sectionTitle(): string | undefined {
		switch (this.view) {
			case "tree": {
				const base = "TRUNK + BRANCHES · est tokens (~chars/4)";
				return this.input.sessionName ? `SESSION ${this.input.sessionName} · ${base}` : base;
			}
			case "crop": {
				if (this.cropMode === "turn") {
					const reclaim = this.getTurns()
						.filter((t) => this.turnMarks.has(t.userId))
						.reduce((sum, t) => sum + t.estTokens, 0);
					return `REMOVE WHOLE TURNS — question + its answers drop together · reclaim ~${fmtTokens(reclaim)} · originals kept on the previous branch`;
				}
				const cands = this.getCandidates();
				const reclaim = [...this.marks].reduce(
					(sum, id) => sum + (cands.find((c) => c.entryId === id)?.estTokens ?? 0),
					0,
				);
				return `CROP — TOOL/MCP RESULTS ON THIS BRANCH · reclaim ~${fmtTokens(reclaim)} · stubs land on a new branch point, originals untouched`;
			}
			case "consumers":
				return "TOKENS BY SOURCE — CURRENT BRANCH CONTEXT";
			case "decisions":
				return "DECISION RECORDS ON TRUNK (newest first)";
			case "inspect":
				return undefined;
		}
	}

	footerHelp(): string {
		switch (this.view) {
			case "tree":
				return "↑↓/jk move · ⏎ jump/fold · b branch · m merge · c crop · i inspect · D decisions · u consumers · q close";
			case "crop":
				return this.cropMode === "turn"
					? "space mark whole turn · ⏎ apply → new branch point · t results mode · esc back · q close"
					: "space mark · a auto · ⏎ apply → new branch point · t turn mode · esc back · q close";
			case "consumers":
				return "c crop the big ones · esc back · q close";
			case "decisions":
				return "⏎ jump to record · esc back · q close";
			case "inspect":
				return "c crop this entry · esc back · q close";
		}
	}
}
