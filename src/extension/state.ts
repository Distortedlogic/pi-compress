import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type ForkInfo, extractForks, nearestOpenFork } from "../core/index.ts";
import { type SessionSnapshot, snapshotSession } from "../session.ts";

export type ModelLike = Model<any>;

export interface SessionState extends SessionSnapshot {
	forks: ForkInfo[];
	currentFork: ForkInfo | undefined;
}

export function deriveState(ctx: ExtensionContext): SessionState {
	const snapshot = snapshotSession(ctx.sessionManager);
	const forks = extractForks(ctx.sessionManager);
	const currentFork = nearestOpenFork(snapshot.branch, forks);
	return { ...snapshot, forks, currentFork };
}

export function branchEntries(state: SessionState, forkEntryId: string): SessionEntry[] {
	const forkIndex = state.branch.findIndex((entry) => entry.id === forkEntryId);
	if (forkIndex === -1) return [];
	const afterFork = new Set(state.branch.slice(forkIndex + 1).map((entry) => entry.id));
	return state.contextEntries.filter((entry) => afterFork.has(entry.id));
}

export function modelKey(model: ModelLike | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function resolveModel(ctx: ExtensionContext, reference: string): ModelLike | undefined {
	if (reference.includes("/")) {
		const [provider, ...modelId] = reference.split("/");
		return ctx.modelRegistry.find(provider ?? "", modelId.join("/"));
	}
	const models = ctx.modelRegistry.getAll();
	const exact = models.find((model) => model.id === reference);
	if (exact) return exact;
	const matches = models.filter((model) => model.id.includes(reference));
	return matches.length === 1 ? matches[0] : undefined;
}
