import { basename } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	TreeSelectorComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type TUI,
	Text,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type ForkInfo,
	branchHandler,
	decisionsOnPath,
	deriveState,
	exportDecisions,
	mergeHandler,
	nearestOpenFork,
	notifyDecisions,
	parseDecisionArgs,
} from "./branches.ts";
import {
	type ContextTurn,
	type CropCandidate,
	type CropPlan,
	applyCropPlan,
	autoSelect,
	contextTurns,
	cropCandidates,
	planCrop,
	planRemoveTurns,
} from "./compression.ts";
import { aggregateConsumers } from "./core/consumers.ts";
import { BAND_THRESHOLDS, type Band, band, estimateEntryTokens, fmtTokens } from "./core/estimate.ts";
import { serializeEntry } from "./core/serialize.ts";
import type { DraftFn } from "./extension/draft.ts";
import {
	CTREE_DECISION,
	type CtreeDecisionDetails,
	ctreeDecisionDetails,
	parseCtreeDecisionDetails,
} from "./protocol.ts";
import type { SessionSnapshot } from "./session.ts";

type PiTheme = ExtensionContext["ui"]["theme"];
type NativeTree = ReturnType<ExtensionContext["sessionManager"]["getTree"]>;

export type PanelView = "tree" | "crop" | "consumers" | "decisions" | "inspect";

export interface PanelInput extends SessionSnapshot {
	forks: ForkInfo[];
	project: string;
	sessionName?: string;
	model?: string;
	contextWindow?: number;
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

interface PanelHeader {
	project: string;
	sessionName?: string;
	branchName: string;
	model?: string;
	view: PanelView;
	tokens: number | null;
	window?: number;
	pct?: number;
	band?: Band;
	estimated: boolean;
	readOnly: boolean;
}

interface GaugeInput {
	tokens: number | null;
	window?: number;
	estimated?: boolean;
	barWidth?: number;
}

export interface PanelOpenOptions {
	initialView?: PanelView;
	premark?: string[];
	dryRun?: boolean;
	readOnly?: boolean;
}

export interface ContextPanelOptions {
	input: PanelInput;
	tui: TUI;
	theme: PiTheme;
	onAction: (action: PanelAction) => void;
	onNotify?: (message: string) => void;
	maxBody?: number;
}

function bandText(theme: PiTheme, value: Band, text: string): string {
	if (value === "red") return theme.fg("error", text);
	if (value === "filling") return theme.fg("warning", text);
	return theme.fg("success", text);
}

function renderGauge(input: GaugeInput, theme: PiTheme): string {
	const barWidth = input.barWidth ?? 30;
	if (input.tokens === null || !input.window || input.window <= 0) {
		return `${theme.fg("dim", "CONTEXT")} ${theme.fg("dim", "░".repeat(barWidth))} ${theme.fg(
			"dim",
			"estimating… (awaiting next turn)",
		)}`;
	}
	const pct = (input.tokens / input.window) * 100;
	const value = band(pct);
	const fill = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const ticks = new Set(
		[BAND_THRESHOLDS.healthy, BAND_THRESHOLDS.filling, BAND_THRESHOLDS.red].map((threshold) =>
			Math.min(barWidth - 1, Math.round((threshold / 100) * barWidth)),
		),
	);
	let barText = "";
	for (let index = 0; index < barWidth; index++) {
		const character = index < fill ? "█" : ticks.has(index) ? "┊" : "░";
		barText += index < fill ? bandText(theme, value, character) : theme.fg("dim", character);
	}
	const label =
		input.estimated === false
			? `${fmtTokens(input.tokens)} / ${fmtTokens(input.window)} · ${bandText(theme, value, `${pct.toFixed(1)}% ${value}`)}`
			: `~${fmtTokens(input.tokens)} est · ${bandText(theme, value, value)}`;
	return `${theme.fg("dim", "CONTEXT")} ${barText} ${label}`;
}

function panelHeader(input: PanelInput, view: PanelView): PanelHeader {
	const currentFork = nearestOpenFork(input.branch, input.forks);
	const tokens = input.usageTokens ?? null;
	const window = input.contextWindow;
	const pct = tokens !== null && window && window > 0 ? (tokens / window) * 100 : undefined;
	return {
		project: input.project,
		sessionName: input.sessionName,
		branchName: currentFork?.data.name ?? "trunk",
		model: input.model,
		view,
		tokens,
		window,
		pct,
		band: pct === undefined ? undefined : band(pct),
		estimated: false,
		readOnly: input.readOnly ?? false,
	};
}

export class PanelController {
	view: PanelView;
	cropMode: "result" | "turn" = "result";
	readonly marks = new Set<string>();
	readonly turnMarks = new Set<string>();
	armedId: string | undefined;
	inspectId: string | undefined;
	inspectOffset = 0;

	constructor(readonly input: PanelInput) {
		this.view = input.initialView ?? "tree";
		for (const id of input.premark ?? []) this.marks.add(id);
	}

	setView(view: PanelView): void {
		this.view = view;
		this.armedId = undefined;
		this.inspectOffset = 0;
	}

	sectionTitle(): string | undefined {
		switch (this.view) {
			case "tree": {
				const title = "TRUNK + BRANCHES · est tokens (~chars/4)";
				return this.input.sessionName ? `SESSION ${this.input.sessionName} · ${title}` : title;
			}
			case "crop": {
				if (this.cropMode === "turn") {
					const reclaim = contextTurns(this.input)
						.filter((turn) => this.turnMarks.has(turn.userId))
						.reduce((total, turn) => total + turn.estTokens, 0);
					return `REMOVE WHOLE TURNS — question + its answers drop together · reclaim ~${fmtTokens(reclaim)} · originals kept on the previous branch`;
				}
				const candidates = cropCandidates(this.input);
				const reclaim = candidates
					.filter((candidate) => this.marks.has(candidate.entryId))
					.reduce((total, candidate) => total + candidate.estTokens, 0);
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
				return "↑↓/jk move · ⏎ jump · ←→ fold · b branch · m merge · c crop · i inspect · D decisions · u consumers · q close";
			case "crop":
				return this.cropMode === "turn"
					? "space mark whole turn · ⏎ apply → new branch point · t results mode · esc back · q close"
					: "space mark · a auto · ⏎ apply → new branch point · t turn mode · esc back · q close";
			case "consumers":
				return "↑↓/jk move · c crop the big ones · esc back · q close";
			case "decisions":
				return "↑↓/jk move · ⏎ jump to record · esc back · q close";
			case "inspect":
				return "↑↓/jk scroll · c crop this entry · esc back · q close";
		}
	}
}

function settingsTheme(theme: PiTheme) {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("text", text)),
		value: (text: string, selected: boolean) =>
			selected ? theme.fg("accent", text) : text === "crop" ? theme.fg("error", text) : theme.fg("muted", text),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}

function selectTheme(theme: PiTheme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function currentTurnId(input: PanelInput, turns: readonly ContextTurn[]): string | undefined {
	return turns.find((turn) => turn.entryIds.includes(input.leafId ?? ""))?.userId;
}

function decorateTree(nodes: NativeTree, forks: readonly ForkInfo[]): NativeTree {
	const byId = new Map(forks.map((fork) => [fork.entryId, fork]));
	return nodes.map((node) => {
		const fork = byId.get(node.entry.id);
		return {
			...node,
			label: fork ? `${fork.data.name} · ${fork.status}` : node.label,
			children: decorateTree(node.children, forks),
		};
	});
}

export class ContextPanel {
	focused = false;
	readonly opts: ContextPanelOptions;
	readonly controller: PanelController;
	private body: Component & { dispose?(): void };
	private treeSelector: TreeSelectorComponent | undefined;
	private cropList: SettingsList | undefined;
	private lastNotify: string | undefined;

	constructor(opts: ContextPanelOptions) {
		this.opts = opts;
		this.controller = new PanelController(opts.input);
		this.body = new Text("", 0, 0);
		this.body = this.createBody();
	}

	private notify(message: string): void {
		this.lastNotify = message;
		this.opts.onNotify?.(message);
		this.opts.tui.requestRender();
	}

	private deny(): void {
		this.notify("read-only (standalone pitree) — open the panel inside pi to act");
	}

	private act(action: PanelAction): void {
		if (this.opts.input.readOnly && action.type !== "close") {
			this.deny();
			return;
		}
		this.opts.onAction(action);
	}

	private selectedTreeEntryId(): string | undefined {
		return this.treeSelector?.getTreeList().getSelectedNode()?.entry.id ?? this.opts.input.leafId ?? undefined;
	}

	private createTree(): TreeSelectorComponent {
		const selector = new TreeSelectorComponent(
			decorateTree(this.opts.input.tree, this.opts.input.forks),
			this.opts.input.leafId,
			Math.max(10, (this.opts.maxBody ?? 26) * 2),
			(entryId) => this.act({ type: "jump", entryId }),
			() => this.act({ type: "close" }),
			undefined,
			this.controller.inspectId ?? this.opts.input.leafId ?? undefined,
			"all",
		);
		this.treeSelector = selector;
		return selector;
	}

	private resultSettings(): SettingsList {
		const candidates = cropCandidates(this.opts.input);
		const items: SettingItem[] = candidates.map((candidate) => {
			const marked = this.controller.marks.has(candidate.entryId);
			const currentValue = marked ? "crop" : candidate.protected ? "protected" : "keep";
			return {
				id: candidate.entryId,
				label: `⚙ [${candidate.tool}${candidate.arg ? ` ${candidate.arg}` : ""}] · ~${fmtTokens(candidate.estTokens)} · ${candidate.ageTurns}t`,
				description: candidate.protected
					? "Latest result for this tool. Select crop twice to override protection."
					: undefined,
				currentValue: this.opts.input.readOnly ? "read-only" : currentValue,
				values: this.opts.input.readOnly
					? ["read-only"]
					: candidate.protected
						? ["protected", "crop"]
						: ["keep", "crop"],
			};
		});
		const list = new SettingsList(
			items,
			this.opts.maxBody ?? 26,
			settingsTheme(this.opts.theme),
			(id, value) => {
				if (this.opts.input.readOnly) return this.deny();
				const candidate = candidates.find((item) => item.entryId === id);
				if (!candidate) return;
				if (candidate.protected && value === "crop" && this.controller.armedId !== id) {
					this.controller.armedId = id;
					list.updateValue(id, "protected");
					this.notify(`${candidate.tool} is the latest result of its tool — space again to crop it anyway (F3.3)`);
					return;
				}
				if (value === "crop") this.controller.marks.add(id);
				else this.controller.marks.delete(id);
				this.controller.armedId = undefined;
				list.updateValue(id, this.controller.marks.has(id) ? "crop" : candidate.protected ? "protected" : "keep");
				this.opts.tui.requestRender();
			},
			() => this.switchView("tree"),
		);
		this.cropList = list;
		return list;
	}

	private turnSettings(): SettingsList {
		const turns = contextTurns(this.opts.input);
		const protectedId = currentTurnId(this.opts.input, turns);
		const items: SettingItem[] = turns.map((turn) => {
			const isProtected = turn.userId === protectedId;
			return {
				id: turn.userId,
				label: `● user: ${turn.label} · ${turn.entryIds.length} entries · ~${fmtTokens(turn.estTokens)}`,
				description: isProtected ? "The current turn cannot be removed." : undefined,
				currentValue: this.opts.input.readOnly
					? "read-only"
					: this.controller.turnMarks.has(turn.userId)
						? "drop"
						: isProtected
							? "protected"
							: "keep",
				values: this.opts.input.readOnly ? ["read-only"] : isProtected ? ["protected"] : ["keep", "drop"],
			};
		});
		const list = new SettingsList(
			items,
			this.opts.maxBody ?? 26,
			settingsTheme(this.opts.theme),
			(id, value) => {
				if (this.opts.input.readOnly) return this.deny();
				if (id === protectedId) {
					list.updateValue(id, "protected");
					this.notify("that's the current turn (you're in it) — can't remove it");
					return;
				}
				if (value === "drop") this.controller.turnMarks.add(id);
				else this.controller.turnMarks.delete(id);
				this.opts.tui.requestRender();
			},
			() => this.switchView("tree"),
		);
		this.cropList = list;
		return list;
	}

	private createConsumers(): SelectList {
		const consumers = aggregateConsumers(this.opts.input.contextEntries);
		const largest = Math.max(1, ...consumers.map((consumer) => consumer.tokens));
		const items: SelectItem[] = consumers.map((consumer) => ({
			value: consumer.key,
			label: `${consumer.key} · ${consumer.entries} ${consumer.entries === 1 ? "entry" : "entries"} · ${(consumer.share * 100).toFixed(0)}%`,
			description: `${fmtTokens(consumer.tokens).padStart(7)} ${"▰".repeat(Math.max(1, Math.round((consumer.tokens / largest) * 28)))}`,
		}));
		const list = new SelectList(items, this.opts.maxBody ?? 26, selectTheme(this.opts.theme));
		list.onCancel = () => this.switchView("tree");
		return list;
	}

	private createDecisions(): Container {
		const decisions = [...decisionsOnPath(this.opts.input.branch)].reverse();
		const forks = new Map(this.opts.input.forks.map((fork) => [fork.entryId, fork]));
		const detailsById = new Map<string, string>();
		const items: SelectItem[] = decisions.map((decision) => {
			const details = ctreeDecisionDetails(decision);
			const fork = details ? forks.get(details.forkEntryId) : undefined;
			const model = fork?.data.branchModel ?? fork?.data.trunkModel ?? "—";
			const text = contentText(decision.content, "\n");
			const outcome =
				text
					.split("\n")
					.find((line) => line.startsWith("**Outcome:**"))
					?.replace("**Outcome:**", "")
					.trim() ??
				text.split("\n")[0] ??
				"";
			const lines = [
				`${decision.timestamp.slice(0, 10)} · drafted by ${model} · branch ${details?.forkEntryId ?? "—"} · human-confirmed ✓`,
				outcome,
				...(details?.siblings ?? []).map((sibling) => `✗ ${sibling.name} — ${sibling.reason}`),
			];
			detailsById.set(decision.id, lines.join("\n"));
			return { value: decision.id, label: `◆ ${details?.branchName ?? "decision"}` };
		});
		if (items.length === 0) {
			items.push({ value: "", label: "(no decision records on this trunk yet — /merge → squash creates them)" });
		}
		const list = new SelectList(items, Math.max(3, (this.opts.maxBody ?? 26) - 5), selectTheme(this.opts.theme));
		const detail = new Text("", 2, 0);
		const showDetails = (item: SelectItem): void => {
			detail.setText(detailsById.get(item.value) ?? "");
			this.opts.tui.requestRender();
		};
		if (items[0]) showDetails(items[0]);
		list.onSelectionChange = showDetails;
		list.onSelect = (item) => {
			if (item.value) this.act({ type: "jump", entryId: item.value });
		};
		list.onCancel = () => this.switchView("tree");
		const container = new Container();
		container.addChild(list);
		container.addChild(detail);
		return Object.assign(container, {
			handleInput: (data: string) => list.handleInput(data),
		});
	}

	private createInspect(): Component {
		const entry = this.controller.inspectId
			? this.opts.input.entries.find((candidate) => candidate.id === this.controller.inspectId)
			: undefined;
		if (!entry) return new Text("(nothing selected)", 0, 0);
		const tokens = estimateEntryTokens(entry);
		const tool =
			entry.type === "message" && entry.message.role === "toolResult" ? ` · tool ${entry.message.toolName}` : "";
		const meta = `id ${entry.id} · type ${entry.type}${tool} · ~${fmtTokens(tokens)} tokens (${(
			tokens * 4
		).toLocaleString("en-US")} chars) · parent ${entry.parentId ?? "—"}`;
		const lines = (serializeEntry(entry) ?? "(no content)").split("\n");
		const visible = lines.slice(
			this.controller.inspectOffset,
			this.controller.inspectOffset + (this.opts.maxBody ?? 26),
		);
		return new Markdown(`${meta}\n\n\`\`\`text\n${visible.join("\n")}\n\`\`\``, 0, 0, getMarkdownTheme());
	}

	private createBody(): Component & { dispose?(): void } {
		this.treeSelector = undefined;
		this.cropList = undefined;
		switch (this.controller.view) {
			case "tree":
				return this.createTree();
			case "crop":
				return this.controller.cropMode === "turn" ? this.turnSettings() : this.resultSettings();
			case "consumers":
				return this.createConsumers();
			case "decisions":
				return this.createDecisions();
			case "inspect":
				return this.createInspect();
		}
	}

	private switchView(view: PanelView): void {
		this.controller.setView(view);
		this.body.dispose?.();
		this.body = this.createBody();
		this.lastNotify = undefined;
		this.opts.tui.requestRender();
	}

	private delegate(data: string): void {
		this.body.handleInput?.(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
		this.opts.tui.requestRender();
	}

	private applyCrop(): void {
		if (this.opts.input.readOnly) {
			this.deny();
			return;
		}
		try {
			if (this.controller.cropMode === "turn") {
				if (this.controller.turnMarks.size === 0) {
					this.notify("no turns marked — space to mark a whole Q&A turn");
					return;
				}
				this.act({
					type: "crop-apply",
					plan: planRemoveTurns(this.opts.input, [...this.controller.turnMarks]),
					dryRun: this.opts.input.dryRun ?? false,
				});
				return;
			}
			if (this.controller.marks.size === 0) {
				this.notify("nothing marked — space to mark entries");
				return;
			}
			this.act({
				type: "crop-apply",
				plan: planCrop(this.opts.input, [...this.controller.marks]),
				dryRun: this.opts.input.dryRun ?? false,
			});
		} catch (error) {
			this.notify((error as Error).message);
		}
	}

	handleInput(data: string): void {
		if (data === "q") {
			this.act({ type: "close" });
			return;
		}
		const isEscape = matchesKey(data, "escape");
		const isEnter = matchesKey(data, "enter");
		if (this.controller.view === "tree") {
			if (data === "c") {
				this.switchView("crop");
				return;
			}
			if (data === "D") {
				this.switchView("decisions");
				return;
			}
			if (data === "u") {
				this.switchView("consumers");
				return;
			}
			if (data === "m") {
				this.act({ type: "merge" });
				return;
			}
			if (data === "b") {
				const entryId = this.selectedTreeEntryId();
				if (entryId) this.act({ type: "branch", entryId });
				return;
			}
			if (data === "i") {
				this.controller.inspectId = this.selectedTreeEntryId();
				this.switchView("inspect");
				return;
			}
			this.delegate(data);
			return;
		}
		if (isEscape) {
			this.switchView("tree");
			return;
		}
		if (this.controller.view === "crop") {
			if (data === "c") {
				this.switchView("tree");
				return;
			}
			if (data === "t") {
				this.controller.cropMode = this.controller.cropMode === "result" ? "turn" : "result";
				this.switchView("crop");
				return;
			}
			if (data === "a" && this.controller.cropMode === "result") {
				if (this.opts.input.readOnly) {
					this.deny();
					return;
				}
				const ids = autoSelect(cropCandidates(this.opts.input), {});
				for (const id of ids) {
					this.controller.marks.add(id);
					this.cropList?.updateValue(id, "crop");
				}
				this.notify(`--auto marked ${ids.length} (protected skipped) — review, then ⏎ to apply`);
				return;
			}
			if (isEnter) {
				this.applyCrop();
				return;
			}
			this.delegate(data);
			return;
		}
		if (this.controller.view === "consumers") {
			if (data === "c") {
				this.switchView("crop");
				return;
			}
			this.delegate(data);
			return;
		}
		if (this.controller.view === "decisions") {
			this.delegate(data);
			return;
		}
		if (this.controller.view !== "inspect") return;
		if (data === "j" || matchesKey(data, "down")) this.controller.inspectOffset += 1;
		else if (data === "k" || matchesKey(data, "up")) {
			this.controller.inspectOffset = Math.max(0, this.controller.inspectOffset - 1);
		} else if (data === "c") {
			if (this.opts.input.readOnly) {
				this.deny();
				return;
			}
			const id = this.controller.inspectId;
			if (id && cropCandidates(this.opts.input).some((candidate) => candidate.entryId === id)) {
				this.controller.marks.add(id);
				this.controller.cropMode = "result";
				this.switchView("crop");
				this.notify("pre-marked from inspector — review, then ⏎ to apply");
				return;
			}
			this.notify("only tool/MCP results are croppable (F3.3)");
			return;
		} else return;
		this.body = this.createInspect();
		this.opts.tui.requestRender();
	}

	render(width: number): string[] {
		const header = panelHeader(this.opts.input, this.controller.view);
		const frame = new Container();
		const readOnly = header.readOnly ? this.opts.theme.fg("warning", " READ-ONLY ") : "";
		const session = header.sessionName ? ` · ${header.sessionName}` : "";
		frame.addChild(
			new Text(
				` ${this.opts.theme.fg("accent", this.opts.theme.bold("pi-context-tree"))} ${this.opts.theme.fg("dim", `· ${header.view}`)}  ${header.project}${this.opts.theme.fg("dim", session)} ${this.opts.theme.fg("success", `⎇ ${header.branchName}`)}${header.model ? this.opts.theme.fg("dim", ` · ${header.model}`) : ""}${readOnly}`,
				0,
				0,
			),
		);
		frame.addChild(
			new Text(
				` ${renderGauge(
					{
						tokens: header.tokens,
						window: header.window,
						estimated: header.estimated,
						barWidth: Math.min(30, Math.max(10, width - 50)),
					},
					this.opts.theme,
				)}`,
				0,
				0,
			),
		);
		frame.addChild(new Text(this.opts.theme.fg("dim", "─".repeat(Math.max(0, width))), 0, 0));
		const title = this.controller.sectionTitle();
		if (title) frame.addChild(new Text(` ${this.opts.theme.fg("dim", title)}`, 0, 0));
		frame.addChild(this.body);
		if (this.controller.view === "decisions") {
			frame.addChild(
				new Text(
					this.opts.theme.fg("dim", " (epitaphs keep the trunk model from re-proposing rejected approaches — G3)"),
					0,
					0,
				),
			);
		}
		frame.addChild(new Text(this.opts.theme.fg("dim", "─".repeat(Math.max(0, width))), 0, 0));
		frame.addChild(new Text(this.lastNotify ? ` ${this.opts.theme.fg("warning", this.lastNotify)}` : "", 0, 0));
		frame.addChild(new Text(` ${this.opts.theme.fg("dim", this.controller.footerHelp())}`, 0, 0));
		return frame.render(width).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.body.invalidate();
	}

	dispose(): void {
		this.body.dispose?.();
	}
}

export function buildPanelInput(pi: ExtensionAPI, ctx: ExtensionContext, opts: PanelOpenOptions = {}): PanelInput {
	const usage = ctx.getContextUsage();
	const state = deriveState(ctx);
	return {
		sessionId: state.sessionId,
		entries: state.entries,
		branch: state.branch,
		contextEntries: state.contextEntries,
		tree: state.tree,
		forks: state.forks,
		leafId: state.leafId,
		project: basename(ctx.cwd),
		sessionName: pi.getSessionName(),
		model: ctx.model?.id,
		contextWindow: ctx.model?.contextWindow ?? usage?.contextWindow,
		usageTokens: usage?.tokens,
		readOnly: opts.readOnly,
		dryRun: opts.dryRun,
		initialView: opts.initialView,
		premark: opts.premark,
	};
}

export async function openPanel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: PanelOpenOptions = {},
): Promise<PanelAction | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("the context panel needs pi's interactive TUI (ui.custom unavailable in this mode)", "warning");
		return undefined;
	}
	const input = buildPanelInput(pi, ctx, opts);
	const action = await ctx.ui.custom<PanelAction>(
		(tui, theme, _keybindings, done) => {
			const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
			return new ContextPanel({
				input,
				tui,
				theme,
				maxBody: Math.max(8, (rows ?? 34) - 9),
				onAction: done,
			});
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "100%" } },
	);
	return action;
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return "navigateTree" in ctx;
}

async function executePanelAction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: PanelAction | undefined,
	draft: DraftFn,
): Promise<void> {
	if (!action || action.type === "close") return;
	if (!isCommandContext(ctx)) {
		ctx.ui.notify("this action needs a command context — run /panel (Ctrl+Q is view-only in 0.84.3)", "warning");
		return;
	}
	switch (action.type) {
		case "jump": {
			const navigation = await ctx.navigateTree(action.entryId, { summarize: false });
			if (!navigation.cancelled) ctx.ui.notify(`jumped — context now ends at ${action.entryId}`, "info");
			return;
		}
		case "branch": {
			if (action.entryId !== ctx.sessionManager.getLeafId()) {
				const navigation = await ctx.navigateTree(action.entryId, { summarize: false });
				if (navigation.cancelled) return;
			}
			const name = await ctx.ui.input("branch name", "fix-flaky-test");
			if (!name?.trim()) return;
			const model = await ctx.ui.input("branch model (empty = keep current)", "");
			await branchHandler(pi, ctx, `${name.trim()}${model?.trim() ? ` ${model.trim()}` : ""}`);
			return;
		}
		case "merge":
			await mergeHandler(pi, ctx, "", draft);
			return;
		case "crop-apply":
			if (action.dryRun) {
				ctx.ui.notify(`(dry-run) would crop ${action.plan.stubs.length} — nothing written`, "info");
				return;
			}
			await applyCropPlan(pi, ctx, action.plan);
	}
}

async function runPanel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	draft: DraftFn,
	opts: PanelOpenOptions = {},
): Promise<void> {
	for (let count = 0; count < 50; count++) {
		const action = await openPanel(pi, ctx, opts);
		if (!action || action.type === "close") return;
		await executePanelAction(pi, ctx, action, draft);
	}
}

export function registerPanel(pi: ExtensionAPI, draft: DraftFn): void {
	pi.registerCommand("panel", {
		description: "pi-context-tree: full-screen context panel (tree · crop · consumers · decisions)",
		handler: (_args, ctx) => runPanel(pi, ctx, draft),
	});
	pi.registerShortcut("ctrl+q", {
		description: "pi-context-tree: open the context panel",
		handler: (ctx) => runPanel(pi, ctx, draft, { readOnly: !isCommandContext(ctx) }),
	});
	pi.registerCommand("decisions", {
		description: "pi-context-tree: decision records on the current trunk (F7) — --export [path] for portable markdown",
		handler: async (args, ctx) => {
			const parsed = parseDecisionArgs(args);
			if (parsed.export) {
				exportDecisions(ctx, parsed.exportPath);
				return;
			}
			if (ctx.mode !== "tui") {
				notifyDecisions(ctx);
				return;
			}
			await runPanel(pi, ctx, draft, { initialView: "decisions" });
		},
		getArgumentCompletions: (prefix) =>
			"--export".startsWith(prefix.split(/\s+/).pop() ?? "") ? [{ value: "--export", label: "--export" }] : null,
	});
}

let warnedRed = false;
let lastPct: number | null = null;
let lastEstimated = true;
let lastConsumers = new Map<string, number>();
const TREND_PTS = 3;
const ATTRIBUTE_PTS = 5;

export function resetAmbient(): void {
	lastPct = null;
	lastEstimated = true;
	lastConsumers = new Map();
}

function trendMarker(pct: number, estimated: boolean, consumers: Map<string, number>): string {
	let marker = "";
	if (lastPct !== null && estimated === lastEstimated) {
		const delta = pct - lastPct;
		if (delta >= ATTRIBUTE_PTS) {
			let topKey = "";
			let topGrowth = 0;
			for (const [key, tokens] of consumers) {
				const growth = tokens - (lastConsumers.get(key) ?? 0);
				if (growth > topGrowth) {
					topGrowth = growth;
					topKey = key;
				}
			}
			marker = topKey ? ` ▲ +${Math.round(delta)}% (${topKey})` : ` ▲ +${Math.round(delta)}%`;
		} else if (delta >= TREND_PTS) marker = " ▲";
	}
	lastPct = pct;
	lastEstimated = estimated;
	lastConsumers = consumers;
	return marker;
}

function nudgeOnRed(ctx: ExtensionContext, value: Band): void {
	if (value === "red" && !warnedRed) {
		warnedRed = true;
		ctx.ui.notify(
			"context crossed 40% of the window — consider /merge, /compress, /crop, or /branch (F5.3)",
			"warning",
		);
	}
	if (value !== "red") warnedRed = false;
}

export function refreshAmbient(_pi: ExtensionAPI, ctx: ExtensionContext): void {
	let state: ReturnType<typeof deriveState> | undefined;
	try {
		state = deriveState(ctx);
	} catch {}
	const branch = state?.currentFork?.data.name ?? "trunk";
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	const slice = state?.contextEntries;
	const consumers = slice
		? new Map(aggregateConsumers(slice).map((consumer) => [consumer.key, consumer.tokens] as const))
		: undefined;
	let gaugeTokens: number | null = null;
	let pct: number | null = null;
	let estimated = true;
	if (usage && usage.percent !== null && usage.tokens !== null && usage.tokens > 0) {
		gaugeTokens = usage.tokens;
		pct = usage.percent;
		estimated = false;
	}
	const trend = pct !== null && consumers ? trendMarker(pct, estimated, consumers) : "";
	let gaugeText = "ctx —";
	if (pct !== null) {
		const value = band(pct);
		gaugeText = estimated ? `ctx ${value} · est${trend}` : `ctx ${pct.toFixed(1)}% ${value}${trend}`;
		nudgeOnRed(ctx, value);
	} else if (usage) gaugeText = "ctx est…";
	ctx.ui.setStatus("ctree", `⎇ ${branch} · ${gaugeText}`);
	ctx.ui.setTitle(`${basename(ctx.cwd)}${branch !== "trunk" ? ` (${branch})` : ""} (pi)`);
	if (ctx.mode === "tui" && window && window > 0) {
		const gauge = renderGauge({ tokens: gaugeTokens, window, estimated, barWidth: 28 }, ctx.ui.theme);
		ctx.ui.setWidget("ctree-gauge", [` ${gauge}${trend}`], { placement: "aboveEditor" });
	}
}

export function registerAmbient(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		resetAmbient();
		refreshAmbient(pi, ctx);
	});
	pi.on("turn_end", (_event, ctx) => refreshAmbient(pi, ctx));
	pi.on("session_tree", (_event, ctx) => refreshAmbient(pi, ctx));
	pi.on("session_before_compact", (_event, ctx) => {
		ctx.ui.notify(
			"heads-up: /compact replaces source material with a lossy summary — pi-context-tree prefers /branch + /merge (decision records), /compress (reviewed range summaries), or /crop. Continuing anyway (F5.4).",
			"warning",
		);
	});
}

export function registerDecisionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<CtreeDecisionDetails>(CTREE_DECISION, (message, options, theme) => {
		const details = parseCtreeDecisionDetails(message.details);
		const content = contentText(message.content, "\n");
		const body = content.split("\n");
		const container = new Container();
		container.addChild(
			new Text(
				`${theme.fg("accent", "◆")} ${theme.fg("accent", details?.branchName ?? "decision")} ${theme.fg(
					"dim",
					"— decision record (squash-merged branch)",
				)}`,
				0,
				0,
			),
		);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${message.timestamp ? new Date(message.timestamp).toISOString().slice(0, 10) : ""}${message.timestamp ? " · " : ""}human-confirmed ✓`,
				),
				0,
				0,
			),
		);
		if (options.expanded) container.addChild(new Markdown(content, 2, 0, getMarkdownTheme()));
		else {
			container.addChild(new Text(`  ${body.find((line) => line.startsWith("**Outcome:**")) ?? body[0] ?? ""}`, 0, 0));
			container.addChild(new Text(theme.fg("dim", "  (expand to see the full record)"), 0, 0));
		}
		for (const sibling of details?.siblings ?? []) {
			container.addChild(new Text(`  ${theme.fg("error", `✗ ${sibling.name} — ${sibling.reason}`)}`, 0, 0));
		}
		return container;
	});
}
