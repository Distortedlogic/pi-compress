/**
 * /undo (v0.2 friction-killers): one-key revert of the last pi-context-tree
 * mutation. Append-only — nothing is deleted. Each mutation records its
 * pre-mutation anchor (fork.parentEntryId / close.prevLeafId / crop or range sourceLeafId);
 * /undo navigates the leaf back there, so a squash re-opens its branch, a crop or
 * range compaction restores the originals, and a /branch returns to its parent. The markers
 * stay in history, off-path and recoverable. It reverts the last *active* mutation
 * (the most recent one still on the current path) — repeat /undo to peel further.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	compressionDetails,
	ctreeCloseData,
	ctreeCropData,
	ctreeForkData,
	ctreeRangeCompactData,
} from "../protocol.ts";
import { refreshAmbient } from "./ambient.ts";
import { type SessionState, deriveState } from "./state.ts";

interface UndoStep {
	target: string;
	describe: string;
}

/** The most recent ctree mutation whose effect is still on the active path. */
function lastUndo(state: SessionState): UndoStep | undefined {
	const { leafId, entries, branch, forks } = state;
	if (!leafId) return undefined;
	const branchIds = new Set(branch.map((entry) => entry.id));
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || !branchIds.has(e.id)) continue;
		const compression = compressionDetails(e);
		if (compression) {
			return {
				target: compression.sourceLeafId,
				describe: "restore the batch execution before compression",
			};
		}

		const close = ctreeCloseData(e);
		if (close?.prevLeafId) {
			const name = forks.find((fork) => fork.entryId === close.forkEntryId)?.data.name ?? "branch";
			const how = close.status === "discarded" ? "re-open discarded" : "re-open";
			return {
				target: close.prevLeafId,
				describe: `${how} '${name}' at its leaf — the close marker stays in history`,
			};
		}

		const crop = ctreeCropData(e);
		if (crop) {
			const count = crop.stubbed.length + (crop.dropped?.length ?? 0);
			return {
				target: crop.sourceLeafId,
				describe: `restore ${count} cropped item${count === 1 ? "" : "s"} — back to before the crop`,
			};
		}

		const range = ctreeRangeCompactData(e);
		if (range) {
			const count = range.selectedEntryIds.length;
			return {
				target: range.sourceLeafId,
				describe: `restore compressed message range (${count} entr${count === 1 ? "y" : "ies"}) — summary and marker stay in off-path history`,
			};
		}

		const fork = ctreeForkData(e);
		if (fork?.parentEntryId) {
			return { target: fork.parentEntryId, describe: `undo /branch '${fork.name}' — back to where you branched` };
		}
	}
	return undefined;
}

export async function undoHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const state = deriveState(ctx);
	const step = lastUndo(state);
	if (!step) {
		ctx.ui.notify("nothing to undo — no pi-context-tree mutation on the current branch", "info");
		return;
	}
	const ok = await ctx.ui.confirm("Undo last change", `↩ ${step.describe}? (nothing is deleted — append-only)`);
	if (!ok) {
		ctx.ui.notify("undo cancelled — nothing changed", "info");
		return;
	}
	const nav = await ctx.navigateTree(step.target, { summarize: false });
	if (nav.cancelled) {
		ctx.ui.notify("undo aborted — navigation cancelled, nothing changed", "warning");
		return;
	}
	refreshAmbient(pi, ctx);
	ctx.ui.notify(`↩ undone — ${step.describe}`, "info");
}

export function registerUndo(pi: ExtensionAPI): void {
	pi.registerCommand("undo", {
		description: "pi-context-tree: revert the last mutation (re-open a branch / restore a crop) — append-only",
		handler: (_args, ctx) => undoHandler(pi, ctx),
	});
}
