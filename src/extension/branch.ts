/**
 * /branch <name> [model] (F1) — label the current point and branch off,
 * optionally onto a cheaper model. The fork entry doubles as a named
 * checkpoint (F1.6); the name is mirrored into pi's native labels (F1.2).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CTREE_FORK } from "../core/index.ts";
import { refreshAmbient } from "./ambient.ts";
import { deriveState, modelKey, resolveModel } from "./state.ts";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
let modelReferences: string[] = [];

export function rememberModels(ctx: ExtensionContext): void {
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
	if (state.forks.some((f) => f.status === "open" && f.data.name === name)) {
		ctx.ui.notify(`an open branch named "${name}" already exists — /merge it first or pick another name`, "error");
		return;
	}

	let branchModel = undefined as ReturnType<typeof resolveModel>;
	if (modelRef) {
		branchModel = resolveModel(ctx, modelRef);
		if (!branchModel) {
			ctx.ui.notify(`unknown model "${modelRef}" — try provider/id (e.g. anthropic/claude-haiku-4-5)`, "error");
			return;
		}
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
		const ok = await pi.setModel(branchModel);
		if (!ok) ctx.ui.notify(`no API key for ${modelKey(branchModel)} — staying on ${trunkModel}`, "warning");
	}

	refreshAmbient(pi, ctx);
	ctx.ui.notify(
		`⎇ branched: ${name}${branchModel ? ` on ${modelKey(branchModel)}` : ""} — /merge squashes it back to this point`,
		"info",
	);
}

export function registerBranch(pi: ExtensionAPI): void {
	const refreshModels = (_event: unknown, ctx: ExtensionContext): void => rememberModels(ctx);
	pi.on("session_start", refreshModels);
	pi.on("model_select", refreshModels);
	pi.registerCommand("branch", {
		description: "pi-context-tree: label this point and branch off (optionally onto a cheaper model)",
		handler: (args, ctx) => branchHandler(pi, ctx, args),
		// second argument completes against the model registry via the remembered-ctx bridge
		getArgumentCompletions: (prefix) => modelCompletions(prefix),
	});
}
