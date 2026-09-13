/**
 * /crop (F3): surgical removal of huge tool/MCP results. Interactive review in
 * the panel (default), rule-based pre-marking with --auto, --dry-run never
 * writes. Apply = branch at the anchor + ONE crop-tail reconstruction block
 * (TRD §5 revised) + a ctree/crop marker. Originals stay recoverable (G4).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CTREE_CROP,
	CTREE_CROP_TAIL,
	type CropPlan,
	autoSelect,
	cropCandidates,
	fmtTokens,
	planCrop,
	renderReconstruction,
} from "../core/index.ts";
import { refreshAmbient } from "./ambient.ts";
import { openPanel } from "./panel-cmd.ts";
import { applyRewrite } from "./rewrite.ts";
import { deriveState } from "./state.ts";

interface CropFlags {
	auto: boolean;
	dryRun: boolean;
	apply: boolean;
	top: boolean;
	minTokens?: number;
	olderThan?: number;
	keep: string[];
}

export function parseCropFlags(args: string): CropFlags {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const flags: CropFlags = { auto: false, dryRun: false, apply: false, top: false, keep: [] };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--auto") flags.auto = true;
		else if (t === "--top") flags.top = true;
		else if (t === "--dry-run") flags.dryRun = true;
		else if (t === "--apply") flags.apply = true;
		else if (t === "--min-tokens") flags.minTokens = Number(tokens[++i]);
		else if (t === "--older-than") flags.olderThan = Number(tokens[++i]);
		else if (t === "--keep") {
			const g = tokens[++i];
			if (g) flags.keep.push(g);
		}
	}
	return flags;
}

function notifyDryRun(ctx: ExtensionCommandContext, plan: CropPlan): void {
	const lines = plan.stubs.map((s) => `${s.tool}${s.arg ? ` ${s.arg}` : ""} ~${fmtTokens(s.estTokens)}`);
	ctx.ui.notify(
		`(dry-run) would crop ${plan.stubs.length}: ${lines.join(" · ")} — reclaim ~${fmtTokens(plan.reclaimTokens)}; nothing written`,
		"info",
	);
}

/** Apply a reviewed plan through the shared append-only rewrite engine. */
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
	if (plan.stubs.length)
		parts.push(`cropped ${plan.stubs.length} entr${plan.stubs.length === 1 ? "y" : "ies"} → stubs`);
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

	// --top: one inline decision on the single biggest unprotected result (no panel, no rules sweep)
	if (flags.top) {
		const unprotected = candidates.filter((c) => !c.protected);
		if (unprotected.length === 0) {
			ctx.ui.notify("every candidate is its tool's latest result (protected) — open /crop to double-mark", "info");
			return;
		}
		const top = unprotected.reduce((a, b) => (b.estTokens > a.estTokens ? b : a));
		const ok = await ctx.ui.confirm(
			"Crop the biggest result",
			`✂ ${top.tool}${top.arg ? ` ${top.arg}` : ""} ~${fmtTokens(top.estTokens)} → crop this result? (original stays recoverable)`,
		);
		if (!ok) {
			ctx.ui.notify("crop cancelled — nothing written", "info");
			return;
		}
		const plan = planCrop(state, [top.entryId]);
		if (flags.dryRun) {
			notifyDryRun(ctx, plan);
			return;
		}
		await applyCropPlan(pi, ctx, plan);
		return;
	}

	if (flags.apply && !flags.auto) {
		ctx.ui.notify("--apply needs --auto rules (interactive review applies from the panel)", "error");
		return;
	}

	const premark = flags.auto
		? autoSelect(candidates, { minTokens: flags.minTokens, olderThanTurns: flags.olderThan, keep: flags.keep })
		: [];

	// headless: --auto --apply skips the panel entirely (scriptable + works without a TUI, e.g. RPC mode)
	if (flags.auto && flags.apply) {
		if (premark.length === 0) {
			ctx.ui.notify("--auto matched nothing (protected/latest results are skipped) — nothing to crop", "info");
			return;
		}
		const plan = planCrop(state, premark);
		if (flags.dryRun) {
			notifyDryRun(ctx, plan);
			return;
		}
		await applyCropPlan(pi, ctx, plan);
		return;
	}

	if (flags.auto && premark.length === 0) {
		ctx.ui.notify("--auto matched nothing (protected/latest results are skipped) — opening review anyway", "info");
	}

	const action = await openPanel(pi, ctx, { initialView: "crop", premark, dryRun: flags.dryRun });
	if (!action || action.type !== "crop-apply") return;

	if (action.dryRun) {
		notifyDryRun(ctx, action.plan);
		return;
	}
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
			const hits = flags.filter((f) => f.startsWith(last));
			return hits.length ? hits.map((value) => ({ value, label: value })) : null;
		},
	});
}
