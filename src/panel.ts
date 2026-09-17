import { basename } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	TreeSelectorComponent,
	getMarkdownTheme,
	getSettingsListTheme,
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
import parseArgs from "yargs-parser";
import { renderGauge } from "./ambient.ts";
import { branchHandler, exportDecisions, mergeHandler, notifyDecisions, parseDecisionArgs } from "./branches.ts";
import {
	type ForkInfo,
	type SessionSnapshot,
	aggregateConsumers,
	decisionsOnPath,
	deriveState,
	estimateEntryTokens,
	fmtTokens,
	nearestOpenFork,
	serializeEntry,
} from "./context.ts";
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
} from "./crop.ts";
import type { DraftFn } from "./draft.ts";
import {
	CTREE_DECISION,
	type CtreeDecisionDetails,
	ctreeDecisionDetails,
	parseCtreeDecisionDetails,
} from "./protocol.ts";

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
	dryRun?: boolean;
	initialView?: PanelView;
	premark?: string[];
}

type PanelAction =
	| { type: "close" }
	| { type: "jump"; entryId: string }
	| { type: "branch"; entryId: string }
	| { type: "merge" }
	| { type: "crop-apply"; plan: CropPlan; dryRun: boolean };

interface CropFlags {
	auto: boolean;
	dryRun: boolean;
	apply: boolean;
	top: boolean;
	minTokens?: number;
	olderThan?: number;
	keep: string[];
}

const CROP_ARGUMENT_CONFIGURATION = {
	"boolean-negation": false,
	"camel-case-expansion": false,
	"parse-numbers": false,
	"unknown-options-as-args": true,
} as const;

export interface PanelOpenOptions {
	initialView?: PanelView;
	premark?: string[];
	dryRun?: boolean;
}

export interface ContextPanelOptions {
	input: PanelInput;
	tui: TUI;
	theme: PiTheme;
	onAction: (action: PanelAction) => void;
	onNotify?: (message: string) => void;
	maxBody?: number;
}

class PanelController {
	readonly input: PanelInput;
	view: PanelView;
	cropMode: "result" | "turn" = "result";
	readonly marks = new Set<string>();
	readonly turnMarks = new Set<string>();
	armedId: string | undefined;
	inspectId: string | undefined;
	inspectOffset = 0;

	constructor(input: PanelInput) {
		this.input = input;
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

	private selectedTreeEntryId(): string | undefined {
		return this.treeSelector?.getTreeList().getSelectedNode()?.entry.id ?? this.opts.input.leafId ?? undefined;
	}

	private createTree(): TreeSelectorComponent {
		const selector = new TreeSelectorComponent(
			decorateTree(this.opts.input.tree, this.opts.input.forks),
			this.opts.input.leafId,
			Math.max(10, (this.opts.maxBody ?? 26) * 2),
			(entryId) => this.opts.onAction({ type: "jump", entryId }),
			() => this.opts.onAction({ type: "close" }),
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
				currentValue,
				values: candidate.protected ? ["protected", "crop"] : ["keep", "crop"],
			};
		});
		const list = new SettingsList(
			items,
			this.opts.maxBody ?? 26,
			getSettingsListTheme(),
			(id, value) => {
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
				currentValue: this.controller.turnMarks.has(turn.userId) ? "drop" : isProtected ? "protected" : "keep",
				values: isProtected ? ["protected"] : ["keep", "drop"],
			};
		});
		const list = new SettingsList(
			items,
			this.opts.maxBody ?? 26,
			getSettingsListTheme(),
			(id, value) => {
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
			if (item.value) this.opts.onAction({ type: "jump", entryId: item.value });
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
		try {
			if (this.controller.cropMode === "turn") {
				if (this.controller.turnMarks.size === 0) {
					this.notify("no turns marked — space to mark a whole Q&A turn");
					return;
				}
				this.opts.onAction({
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
			this.opts.onAction({
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
			this.opts.onAction({ type: "close" });
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
				this.opts.onAction({ type: "merge" });
				return;
			}
			if (data === "b") {
				const entryId = this.selectedTreeEntryId();
				if (entryId) this.opts.onAction({ type: "branch", entryId });
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
		const input = this.opts.input;
		const currentFork = nearestOpenFork(input.branch, input.forks);
		const session = input.sessionName ? ` · ${input.sessionName}` : "";
		const frame = new Container();
		frame.addChild(
			new Text(
				` ${this.opts.theme.fg("accent", this.opts.theme.bold("pi-context-compress"))} ${this.opts.theme.fg("dim", `· ${this.controller.view}`)}  ${input.project}${this.opts.theme.fg("dim", session)} ${this.opts.theme.fg("success", `⎇ ${currentFork?.data.name ?? "trunk"}`)}${input.model ? this.opts.theme.fg("dim", ` · ${input.model}`) : ""}`,
				0,
				0,
			),
		);
		frame.addChild(
			new Text(
				` ${renderGauge(
					{
						tokens: input.usageTokens ?? null,
						window: input.contextWindow,
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

export function buildPanelInput(ctx: ExtensionContext, opts: PanelOpenOptions = {}): PanelInput {
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
		sessionName: ctx.sessionManager.getSessionName(),
		model: ctx.model?.id,
		contextWindow: ctx.model?.contextWindow ?? usage?.contextWindow,
		usageTokens: usage?.tokens,
		dryRun: opts.dryRun,
		initialView: opts.initialView,
		premark: opts.premark,
	};
}

async function openPanel(ctx: ExtensionContext, opts: PanelOpenOptions = {}): Promise<PanelAction | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("the context panel needs pi's interactive TUI (ui.custom unavailable in this mode)", "warning");
		return undefined;
	}
	const input = buildPanelInput(ctx, opts);
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

function parseCropFlags(args: string): CropFlags {
	const parsed = parseArgs(args, {
		array: ["keep"],
		boolean: ["auto", "dry-run", "apply", "top"],
		number: ["min-tokens", "older-than"],
		string: ["keep"],
		configuration: CROP_ARGUMENT_CONFIGURATION,
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
	const action = await openPanel(ctx, { initialView: "crop", premark, dryRun: flags.dryRun });
	if (!action || action.type !== "crop-apply") return;
	if (action.dryRun) return notifyDryRun(ctx, action.plan);
	await applyCropPlan(pi, ctx, action.plan);
}

export function registerCrop(pi: ExtensionAPI): void {
	pi.registerCommand("crop", {
		description:
			"pi-context-compress: surgically stub out huge tool/MCP results (--top for the biggest; interactive; --auto --apply --dry-run)",
		handler: (args, ctx) => cropHandler(pi, ctx, args),
		getArgumentCompletions: (prefix) => {
			const flags = ["--top", "--auto", "--apply", "--dry-run", "--min-tokens", "--older-than", "--keep"];
			const last = prefix.split(/\s+/).pop() ?? "";
			const matches = flags.filter((flag) => flag.startsWith(last));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
	});
}

async function executePanelAction(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	action: PanelAction | undefined,
	draft: DraftFn,
): Promise<void> {
	if (!action || action.type === "close") return;
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
	ctx: ExtensionCommandContext,
	draft: DraftFn,
	opts: PanelOpenOptions = {},
): Promise<void> {
	while (true) {
		const action = await openPanel(ctx, opts);
		if (!action || action.type === "close") return;
		await executePanelAction(pi, ctx, action, draft);
	}
}

export function registerPanel(pi: ExtensionAPI, draft: DraftFn): void {
	pi.registerCommand("panel", {
		description: "pi-context-compress: full-screen context panel (tree · crop · consumers · decisions)",
		handler: (_args, ctx) => runPanel(pi, ctx, draft),
	});
	pi.registerShortcut("ctrl+q", {
		description: "pi-context-compress: open the context panel",
		handler: () => pi.sendUserMessage("/panel", { expandPromptTemplates: true }),
	});
	pi.registerCommand("decisions", {
		description:
			"pi-context-compress: decision records on the current trunk (F7) — --export [path] for portable markdown",
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
