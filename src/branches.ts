import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import parseArgs from "yargs-parser";
import { type ForkInfo, type SessionState, decisionsOnPath, deriveState, serializeEntries } from "./context.ts";
import { DRAFT_SYSTEM_PROMPT, type DraftFn, draftUserPrompt, modelKey, resolveModel } from "./extension/draft.ts";
import { refreshAmbient } from "./panel.ts";
import {
	CTREE_CLOSE,
	CTREE_DECISION,
	CTREE_FORK,
	compressionDetails,
	ctreeCloseData,
	ctreeCropData,
	ctreeDecisionDetails,
	ctreeForkData,
	ctreeRangeCompactData,
} from "./protocol.ts";

export interface DecisionDraft {
	branchName: string;
	dateIso: string;
	model: string;
	branchId: string;
	outcome: string;
	why: string[];
	assumptions?: string;
	changes?: string;
	gotchas?: string;
	openQuestions?: string;
	confidence?: string;
	rejected?: { name: string; reason: string }[];
}

export interface DecisionArgs {
	export: boolean;
	exportPath?: string;
}

type MergeMode = "squash" | "no-llm" | "discard" | "tournament";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const ARGUMENT_CONFIGURATION = {
	"boolean-negation": false,
	"camel-case-expansion": false,
	"parse-numbers": false,
	"unknown-options-as-args": true,
} as const;
let modelReferences: string[] = [];

function siblingForks(forks: ForkInfo[], forkEntryId: string): ForkInfo[] {
	const selected = forks.find((fork) => fork.entryId === forkEntryId);
	if (!selected) return [];
	return forks.filter(
		(fork) =>
			fork.entryId !== forkEntryId && fork.status === "open" && fork.data.parentEntryId === selected.data.parentEntryId,
	);
}

function branchEntries(state: SessionState, forkEntryId: string): SessionEntry[] {
	const forkIndex = state.branch.findIndex((entry) => entry.id === forkEntryId);
	if (forkIndex === -1) return [];
	const afterFork = new Set(state.branch.slice(forkIndex + 1).map((entry) => entry.id));
	return state.contextEntries.filter((entry) => afterFork.has(entry.id));
}

function rememberModels(ctx: ExtensionContext): void {
	modelReferences = ctx.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`);
}

export function resetModelCompletions(): void {
	modelReferences = [];
}

export function modelCompletions(argumentPrefix: string): { value: string; label: string }[] | null {
	const parts = argumentPrefix.split(/\s+/);
	if (parts.length < 2) return null;
	const prefix = (parts.at(-1) ?? "").toLowerCase();
	const matches = modelReferences.filter((reference) => {
		const modelId = reference.slice(reference.indexOf("/") + 1);
		return reference.toLowerCase().startsWith(prefix) || modelId.toLowerCase().startsWith(prefix);
	});
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

export function renderDecisionRecord(draft: DecisionDraft): string {
	const lines: string[] = [
		`## Decision: ${draft.branchName}`,
		`**Date:** ${draft.dateIso} · **Model:** ${draft.model} · **Branch:** ${draft.branchId}`,
		`**Outcome:** ${draft.outcome}`,
		"**Why:**",
		...draft.why.map((reason) => `- ${reason}`),
		`**Assumptions:** ${draft.assumptions ?? "—"}`,
		`**Changes:** ${draft.changes ?? "none"}`,
		`**Gotchas:** ${draft.gotchas ?? "—"}`,
		`**Open questions:** ${draft.openQuestions ?? "—"}`,
		`**Confidence / revisit-if:** ${draft.confidence ?? "—"}`,
	];
	if (draft.rejected?.length) {
		lines.push("### Rejected alternatives");
		for (const rejected of draft.rejected) lines.push(`- **${rejected.name}:** ${rejected.reason}`);
	}
	return `${lines.join("\n")}\n`;
}

export function exportDecisionsMarkdown(records: readonly string[], project?: string): string {
	const title = `# Decision records${project ? ` — ${project}` : ""}`;
	const meta = `_${records.length} record${records.length === 1 ? "" : "s"} · exported by pi-context-tree_`;
	if (records.length === 0) {
		return `${title}\n\n${meta}\n\n_(none yet — \`/merge\` → squash creates them.)_\n`;
	}
	return `${title}\n\n${meta}\n\n${records.map((record) => record.trim()).join("\n\n---\n\n")}\n`;
}

export function parseDecisionArgs(args: string): DecisionArgs {
	const parsed = parseArgs(args, {
		string: ["export"],
		configuration: ARGUMENT_CONFIGURATION,
	});
	const hasExport = Object.hasOwn(parsed, "export");
	const optionPath = typeof parsed.export === "string" ? parsed.export.trim() : "";
	const positionalPath = parsed._[0] === undefined ? "" : String(parsed._[0]);
	return {
		export: hasExport,
		exportPath: optionPath || positionalPath || undefined,
	};
}

export function notifyDecisions(ctx: ExtensionContext): void {
	const decisions = decisionsOnPath(ctx.sessionManager.getBranch());
	if (decisions.length === 0) {
		ctx.ui.notify("no decision records on this trunk yet — /merge → squash creates them (F7)", "info");
		return;
	}
	const lines = [...decisions].reverse().map((decision) => {
		const details = ctreeDecisionDetails(decision);
		const text = contentText(decision.content, "\n");
		const outcome = text.split("\n").find((line) => line.startsWith("**Outcome:**")) ?? text.split("\n")[0] ?? "";
		return `◆ ${details?.branchName ?? "decision"} (${decision.timestamp.slice(0, 10)}) ${outcome.replace("**Outcome:**", "").trim()}`;
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

export function exportDecisions(ctx: ExtensionContext, path: string | undefined): void {
	const decisions = decisionsOnPath(ctx.sessionManager.getBranch());
	const markdown = exportDecisionsMarkdown(
		decisions.map((decision) => contentText(decision.content, "\n")),
		basename(ctx.cwd),
	);
	const outputPath = resolve(ctx.cwd, path || "ctree-decisions.md");
	try {
		writeFileSync(outputPath, markdown, "utf8");
	} catch (error) {
		ctx.ui.notify(`could not write ${outputPath}: ${(error as Error).message}`, "error");
		return;
	}
	ctx.ui.notify(
		`wrote ${decisions.length} decision record${decisions.length === 1 ? "" : "s"} → ${outputPath}`,
		"info",
	);
}

export async function branchHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const [name, modelRef] = args.trim().split(/\s+/).filter(Boolean);
	if (!name) {
		ctx.ui.notify("usage: /branch <name> [model] — e.g. /branch fix-flaky-test haiku-4.5", "warning");
		return;
	}
	if (!NAME_RE.test(name)) {
		ctx.ui.notify(`branch name "${name}" — use letters, digits, dot, dash, underscore`, "error");
		return;
	}

	await ctx.waitForIdle();
	const state = deriveState(ctx);
	if (state.forks.some((fork) => fork.status === "open" && fork.data.name === name)) {
		ctx.ui.notify(`an open branch named "${name}" already exists — /merge it first or pick another name`, "error");
		return;
	}

	const branchModel = modelRef ? resolveModel(ctx, modelRef) : undefined;
	if (modelRef && !branchModel) {
		ctx.ui.notify(`unknown model "${modelRef}" — try provider/id (e.g. anthropic/claude-haiku-4-5)`, "error");
		return;
	}

	const trunkModel = modelKey(ctx.model);
	pi.appendEntry(CTREE_FORK, {
		v: 1,
		name,
		parentEntryId: ctx.sessionManager.getLeafId(),
		trunkModel,
		branchModel: modelKey(branchModel),
		createdAt: Date.now(),
		status: "open",
	});
	const forkId = ctx.sessionManager.getLeafId();
	if (forkId) pi.setLabel(forkId, name);

	if (branchModel) {
		const changed = await pi.setModel(branchModel);
		if (!changed) ctx.ui.notify(`no API key for ${modelKey(branchModel)} — staying on ${trunkModel}`, "warning");
	}

	refreshAmbient(pi, ctx);
	ctx.ui.notify(
		`⎇ branched: ${name}${branchModel ? ` on ${modelKey(branchModel)}` : ""} — /merge squashes it back to this point`,
		"info",
	);
}

function parseMergeArgs(args: string): { mode?: MergeMode; pick: boolean; note: string } {
	const parsed = parseArgs(args, {
		boolean: ["squash", "no-llm", "discard", "tournament", "pick"],
		configuration: ARGUMENT_CONFIGURATION,
	});
	const mode = parsed.squash
		? "squash"
		: parsed["no-llm"]
			? "no-llm"
			: parsed.discard
				? "discard"
				: parsed.tournament
					? "tournament"
					: undefined;
	return { mode, pick: parsed.pick === true, note: parsed._.map(String).join(" ") };
}

async function pickMode(
	ctx: ExtensionCommandContext,
	fork: ForkInfo,
	siblings: ForkInfo[],
): Promise<MergeMode | undefined> {
	const options = [
		"squash — draft a decision record with the branch model, you confirm/edit",
		"squash --no-llm — write the decision record yourself",
		"discard — return to the label, inject nothing, mark rejected",
		siblings.length > 0
			? `tournament — winner record + epitaphs for ${siblings.length} sibling(s), ONE combined node`
			: "tournament — (needs open siblings sharing this label — none found)",
	];
	const choice = await ctx.ui.select(`Merge branch '${fork.data.name}'?`, options);
	if (choice === undefined) return undefined;
	if (choice.startsWith("squash —")) return "squash";
	if (choice.startsWith("squash --no-llm")) return "no-llm";
	if (choice.startsWith("discard")) return "discard";
	if (choice.startsWith("tournament")) return siblings.length > 0 ? "tournament" : undefined;
	return undefined;
}

function recordTemplate(fork: ForkInfo, model: string | undefined): string {
	return renderDecisionRecord({
		branchName: fork.data.name,
		dateIso: new Date().toISOString().slice(0, 10),
		model: model ?? "—",
		branchId: fork.entryId,
		outcome: "",
		why: ["", ""],
	});
}

function siblingTail(ctx: ExtensionCommandContext, sibling: ForkInfo): SessionEntry[] {
	return ctx.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.id !== sibling.entryId &&
				ctx.sessionManager.getBranch(entry.id).some((parent) => parent.id === sibling.entryId),
		);
}

async function epitaphFor(draft: DraftFn, ctx: ExtensionCommandContext, sibling: ForkInfo): Promise<string> {
	const serialized = serializeEntries(siblingTail(ctx, sibling), { perEntryCap: 800 }).slice(0, 8000);
	try {
		const text = await draft(
			ctx,
			sibling.data.branchModel,
			"You write one-line epitaphs for rejected engineering approaches. Output ONE line, ≤120 chars, format: <reason it was rejected>.",
			`Branch "${sibling.data.name}" lost a tournament. Its transcript:\n---\n${serialized}\n---\nWhy was it rejected? One line.`,
		);
		return text.split("\n", 1)[0]?.slice(0, 160) ?? "rejected";
	} catch {
		const manual = await ctx.ui.input(`epitaph for rejected '${sibling.data.name}' (one line)`, "why it lost");
		return manual?.trim() || "rejected in tournament";
	}
}

async function restoreTrunkModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, fork: ForkInfo): Promise<void> {
	const trunkRef = fork.data.trunkModel;
	if (!trunkRef || trunkRef === modelKey(ctx.model)) return;
	const model = resolveModel(ctx, trunkRef);
	if (!model) {
		ctx.ui.notify(`could not resolve trunk model ${trunkRef} — staying on ${modelKey(ctx.model)}`, "warning");
		return;
	}
	const changed = await pi.setModel(model);
	if (!changed) ctx.ui.notify(`no API key for ${trunkRef} — staying on ${modelKey(ctx.model)}`, "warning");
}

export async function mergeHandler(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	draftFn: DraftFn,
): Promise<void> {
	await ctx.waitForIdle();
	const state = deriveState(ctx);
	const fork = state.currentFork;
	if (!fork || !state.leafId) {
		ctx.ui.notify("no open branch at or above the current leaf — /branch <name> first (F2.1)", "error");
		return;
	}
	const siblings = siblingForks(state.forks, fork.entryId);
	const parsed = parseMergeArgs(args);
	const mode = parsed.mode ?? (parsed.pick ? await pickMode(ctx, fork, siblings) : "squash");
	if (!mode) {
		ctx.ui.notify("merge cancelled — nothing written", "info");
		return;
	}
	if (mode === "tournament" && siblings.length === 0) {
		ctx.ui.notify("tournament needs ≥1 open sibling branch sharing this label (F2.4)", "error");
		return;
	}

	const branchModelRef = fork.data.branchModel ?? modelKey(ctx.model);
	if (mode === "discard") {
		const note = parsed.note || (await ctx.ui.input("optional one-line note for the close marker", "dead end"));
		const navigation = await ctx.navigateTree(fork.entryId, { summarize: false });
		if (navigation.cancelled) {
			ctx.ui.notify("merge aborted — navigation cancelled, nothing written", "warning");
			return;
		}
		pi.appendEntry(CTREE_CLOSE, {
			v: 1,
			forkEntryId: fork.entryId,
			status: "discarded",
			note: note?.trim() || undefined,
			prevLeafId: state.leafId,
		});
		await restoreTrunkModel(pi, ctx, fork);
		refreshAmbient(pi, ctx);
		ctx.ui.notify(`⎇ discarded ${fork.data.name} — back at the label, nothing injected (history kept)`, "info");
		return;
	}

	const template = recordTemplate(fork, branchModelRef);
	let draft: string;
	if (mode === "no-llm") {
		draft = template;
	} else {
		ctx.ui.notify(`drafting decision record with ${branchModelRef ?? "current model"}…`, "info");
		try {
			draft = await draftFn(
				ctx,
				fork.data.branchModel,
				DRAFT_SYSTEM_PROMPT,
				draftUserPrompt(
					fork.data.name,
					template,
					serializeEntries(branchEntries(state, fork.entryId), { perEntryCap: 2000 }),
					parsed.note || undefined,
				),
			);
		} catch (error) {
			ctx.ui.notify(
				`drafting failed (${(error as Error).message}) — falling back to manual template (--no-llm)`,
				"warning",
			);
			draft = template;
		}
	}

	const rejected: { name: string; reason: string }[] = [];
	if (mode === "tournament") {
		for (const sibling of siblings) {
			rejected.push({ name: sibling.data.name, reason: await epitaphFor(draftFn, ctx, sibling) });
		}
		const lines = [draft.trimEnd()];
		if (!draft.includes("### Rejected alternatives")) lines.push("### Rejected alternatives");
		for (const item of rejected) lines.push(`- **${item.name}:** ${item.reason}`);
		draft = `${lines.join("\n")}\n`;
	}

	const confirmed = await ctx.ui.editor(
		`Decision record — review/edit; closing without saving aborts the merge ('${fork.data.name}')`,
		draft,
	);
	if (confirmed === undefined || confirmed.trim() === "") {
		ctx.ui.notify("merge aborted — no record confirmed, nothing written", "info");
		return;
	}

	const navigation = await ctx.navigateTree(fork.entryId, { summarize: false });
	if (navigation.cancelled) {
		ctx.ui.notify("merge aborted — navigation cancelled, nothing written", "warning");
		return;
	}
	pi.sendMessage(
		{
			customType: CTREE_DECISION,
			content: confirmed,
			display: true,
			details: { v: 1, forkEntryId: fork.entryId, branchName: fork.data.name, siblings: rejected },
		},
		{ triggerTurn: false },
	);
	const decisionEntryId = ctx.sessionManager.getLeafId() ?? undefined;
	pi.appendEntry(CTREE_CLOSE, {
		v: 1,
		forkEntryId: fork.entryId,
		status: "squashed",
		decisionEntryId,
		prevLeafId: state.leafId,
	});
	for (const item of rejected) {
		const sibling = siblings.find((candidate) => candidate.data.name === item.name);
		if (sibling) {
			pi.appendEntry(CTREE_CLOSE, {
				v: 1,
				forkEntryId: sibling.entryId,
				status: "rejected",
				note: item.reason,
			});
		}
	}
	await restoreTrunkModel(pi, ctx, fork);
	refreshAmbient(pi, ctx);
	ctx.ui.notify(
		mode === "tournament"
			? `⎇ tournament: ${fork.data.name} won — 1 combined record, ${rejected.length} epitaph(s), siblings closed`
			: `⎇ squashed ${fork.data.name} → decision record on trunk · branch history kept`,
		"info",
	);
}

interface UndoStep {
	target: string;
	describe: string;
}

function lastUndo(state: SessionState): UndoStep | undefined {
	if (!state.leafId) return undefined;
	const branchIds = new Set(state.branch.map((entry) => entry.id));
	for (let index = state.entries.length - 1; index >= 0; index--) {
		const entry = state.entries[index];
		if (!entry || !branchIds.has(entry.id)) continue;
		const compression = compressionDetails(entry);
		if (compression) {
			return { target: compression.sourceLeafId, describe: "restore the batch execution before compression" };
		}
		const close = ctreeCloseData(entry);
		if (close?.prevLeafId) {
			const name = state.forks.find((fork) => fork.entryId === close.forkEntryId)?.data.name ?? "branch";
			const action = close.status === "discarded" ? "re-open discarded" : "re-open";
			return {
				target: close.prevLeafId,
				describe: `${action} '${name}' at its leaf — the close marker stays in history`,
			};
		}
		const crop = ctreeCropData(entry);
		if (crop) {
			const count = crop.stubbed.length + (crop.dropped?.length ?? 0);
			return {
				target: crop.sourceLeafId,
				describe: `restore ${count} cropped item${count === 1 ? "" : "s"} — back to before the crop`,
			};
		}
		const range = ctreeRangeCompactData(entry);
		if (range) {
			const count = range.selectedEntryIds.length;
			return {
				target: range.sourceLeafId,
				describe: `restore compressed message range (${count} entr${count === 1 ? "y" : "ies"}) — summary and marker stay in off-path history`,
			};
		}
		const fork = ctreeForkData(entry);
		if (fork?.parentEntryId) {
			return { target: fork.parentEntryId, describe: `undo /branch '${fork.name}' — back to where you branched` };
		}
	}
	return undefined;
}

export async function undoHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const step = lastUndo(deriveState(ctx));
	if (!step) {
		ctx.ui.notify("nothing to undo — no pi-context-tree mutation on the current branch", "info");
		return;
	}
	const confirmed = await ctx.ui.confirm("Undo last change", `↩ ${step.describe}? (nothing is deleted — append-only)`);
	if (!confirmed) {
		ctx.ui.notify("undo cancelled — nothing changed", "info");
		return;
	}
	const navigation = await ctx.navigateTree(step.target, { summarize: false });
	if (navigation.cancelled) {
		ctx.ui.notify("undo aborted — navigation cancelled, nothing changed", "warning");
		return;
	}
	refreshAmbient(pi, ctx);
	ctx.ui.notify(`↩ undone — ${step.describe}`, "info");
}

export function registerBranch(pi: ExtensionAPI): void {
	const refreshModels = (_event: unknown, ctx: ExtensionContext): void => rememberModels(ctx);
	pi.on("session_start", refreshModels);
	pi.on("model_select", refreshModels);
	pi.registerCommand("branch", {
		description: "pi-context-tree: label this point and branch off (optionally onto a cheaper model)",
		handler: (args, ctx) => branchHandler(pi, ctx, args),
		getArgumentCompletions: modelCompletions,
	});
}

export function registerMerge(pi: ExtensionAPI, draft: DraftFn): void {
	pi.registerCommand("merge", {
		description: "pi-context-tree: close the open branch — squash (default) | --pick | --discard | --tournament",
		handler: (args, ctx) => mergeHandler(pi, ctx, args, draft),
		getArgumentCompletions: (prefix) => {
			const flags = ["--squash", "--no-llm", "--discard", "--tournament", "--pick"];
			const last = prefix.split(/\s+/).pop() ?? "";
			const matches = flags.filter((flag) => flag.startsWith(last));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
	});
}

export function registerUndo(pi: ExtensionAPI): void {
	pi.registerCommand("undo", {
		description: "pi-context-tree: revert the last mutation (re-open a branch / restore a crop) — append-only",
		handler: (_args, ctx) => undoHandler(pi, ctx),
	});
}
