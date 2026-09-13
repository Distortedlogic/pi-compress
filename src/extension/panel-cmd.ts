/**
 * /panel + Ctrl+Q (F4): the full-screen Context Panel, hosted as a pi overlay
 * via ctx.ui.custom({overlay:true}) — the mechanism verified public in 0.84.3.
 * The panel returns ONE action; mutations execute back here in command context
 * after re-validation (TRD §6).
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { branchHandler, deriveState, exportDecisions, notifyDecisions, parseDecisionArgs } from "../branches.ts";
import type { PanelAction, PanelInput, PanelView } from "../core/index.ts";
import { ContextPanel } from "../tui/index.ts";
import type { Deps } from "./draft.ts";

export interface PanelOpenOptions {
	initialView?: PanelView;
	premark?: string[];
	dryRun?: boolean;
	readOnly?: boolean;
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
		usageTokens: usage ? usage.tokens : undefined,
		readOnly: opts.readOnly,
		dryRun: opts.dryRun,
		initialView: opts.initialView,
		premark: opts.premark,
	};
}

/** Mount the panel as an overlay; resolves with the action that closed it. */
export async function openPanel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: PanelOpenOptions = {},
): Promise<PanelAction | undefined> {
	if (!ctx.ui.custom) {
		ctx.ui.notify("the context panel needs pi's interactive TUI (ui.custom unavailable in this mode)", "warning");
		return undefined;
	}
	const input = buildPanelInput(pi, ctx, opts);
	// Full-screen overlay (mockup contract): 100% width, body rows sized to the
	// terminal minus panel chrome (header, gauge, dividers, secthead, footer,
	// notify line, scroll hint). 95% width left the chat showing in the margins.
	const PANEL_CHROME_ROWS = 9;
	const action = await ctx.ui.custom<PanelAction>(
		(tui, _theme, _keybindings, done) => {
			const rows = (tui as { terminal?: { rows?: number } } | undefined)?.terminal?.rows;
			const maxBody = Math.max(8, (rows ?? 34) - PANEL_CHROME_ROWS);
			return new ContextPanel({ input, maxBody, onAction: (a) => done(a) });
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "100%" } },
	);
	return action;
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return "navigateTree" in ctx;
}

export async function executePanelAction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: PanelAction | undefined,
	deps: Deps,
): Promise<void> {
	if (!action || action.type === "close") return;
	if (!isCommandContext(ctx)) {
		ctx.ui.notify("this action needs a command context — run /panel (Ctrl+Q is view-only in 0.84.3)", "warning");
		return;
	}
	switch (action.type) {
		case "jump": {
			const nav = await ctx.navigateTree(action.entryId, { summarize: false });
			if (!nav.cancelled) ctx.ui.notify(`jumped — context now ends at ${action.entryId}`, "info");
			return;
		}
		case "branch": {
			if (action.entryId !== ctx.sessionManager.getLeafId()) {
				const nav = await ctx.navigateTree(action.entryId, { summarize: false });
				if (nav.cancelled) return;
			}
			const name = await ctx.ui.input("branch name", "fix-flaky-test");
			if (!name?.trim()) return;
			const model = await ctx.ui.input("branch model (empty = keep current)", "");
			await branchHandler(pi, ctx, `${name.trim()}${model?.trim() ? ` ${model.trim()}` : ""}`);
			return;
		}
		case "merge": {
			const { mergeHandler } = await import("../branches.ts");
			await mergeHandler(pi, ctx, "", deps);
			return;
		}
		case "crop-apply": {
			const { applyCropPlan, cropHandler } = await import("./crop-cmd.ts");
			if (action.dryRun) {
				ctx.ui.notify(`(dry-run) would crop ${action.plan.stubs.length} — nothing written`, "info");
				return;
			}
			await applyCropPlan(pi, ctx, action.plan);
			return;
		}
	}
}

/** Open → act → reopen with fresh state until the user closes (mockup: the panel stays up). */
async function runPanel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	deps: Deps,
	opts: PanelOpenOptions = {},
): Promise<void> {
	for (let i = 0; i < 50; i++) {
		const action = await openPanel(pi, ctx, opts);
		if (!action || action.type === "close") return;
		await executePanelAction(pi, ctx, action, deps);
	}
}

export function registerPanel(pi: ExtensionAPI, deps: Deps): void {
	pi.registerCommand("panel", {
		description: "pi-context-tree: full-screen context panel (tree · crop · consumers · decisions)",
		handler: (_args, ctx) => runPanel(pi, ctx, deps),
	});
	// ctrl+q, not ctrl+t: pi reserves ctrl+t for app.thinking.toggle (it's in
	// RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS), so a ctrl+t shortcut is
	// silently skipped. ctrl+q is unbound by pi and deliverable (pi runs the
	// terminal in raw mode, so XON/XOFF flow control can't eat it).
	pi.registerShortcut?.("ctrl+q", {
		description: "pi-context-tree: open the context panel",
		handler: (ctx) => runPanel(pi, ctx, deps, { readOnly: !isCommandContext(ctx) }),
	});
	pi.registerCommand("decisions", {
		description: "pi-context-tree: decision records on the current trunk (F7) — --export [path] for portable markdown",
		handler: async (args, ctx) => {
			const parsed = parseDecisionArgs(args);
			if (parsed.export) {
				exportDecisions(ctx, parsed.exportPath);
				return;
			}
			if (!ctx.ui.custom) {
				notifyDecisions(ctx);
				return;
			}
			await runPanel(pi, ctx, deps, { initialView: "decisions" });
		},
		getArgumentCompletions: (prefix) =>
			"--export".startsWith(prefix.split(/\s+/).pop() ?? "") ? [{ value: "--export", label: "--export" }] : null,
	});
}
