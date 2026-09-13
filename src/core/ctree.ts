/**
 * ctree semantics over Pi session branches: fork extraction, status derivation,
 * tournament siblings, nearest-open-fork, decisions listing.
 *
 * status      = open | squashed | rejected | discarded   (from close markers)
 * presentation = active | dangling | squashed | rejected (panel color, F4.3)
 *   active   = open and the fork is an ancestor-or-self of the current leaf
 *   dangling = open and off the current path
 *   discarded renders with the rejected color but keeps its own status.
 */

import type { CustomEntry, CustomMessageEntry, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CTREE_DECISION,
	CTREE_FORK,
	type CtreeCloseData,
	type CtreeCloseStatus,
	type CtreeForkData,
	ctreeCloseData,
	ctreeForkData,
} from "../protocol.ts";
import { isCustomMessageEntry } from "./types.ts";

export type ForkStatus = "open" | CtreeCloseStatus;
export type ForkPresentation = "active" | "dangling" | "squashed" | "rejected";

export interface ForkInfo {
	entryId: string;
	entry: CustomEntry;
	data: CtreeForkData;
	close?: { entryId: string; data: CtreeCloseData };
	status: ForkStatus;
	presentation: ForkPresentation;
	onCurrentPath: boolean;
	/** 1-based nesting depth: number of fork entries on root→fork path. */
	depth: number;
}

type SessionManagerView = ExtensionContext["sessionManager"];

export function extractForks(session: SessionManagerView): ForkInfo[] {
	const entries = session.getEntries();
	const closes = new Map<string, { entryId: string; data: CtreeCloseData }>();
	for (const entry of entries) {
		const close = ctreeCloseData(entry);
		if (close) closes.set(close.forkEntryId, { entryId: entry.id, data: close });
	}

	const currentBranchIds = new Set(session.getBranch().map((entry) => entry.id));
	const forks: ForkInfo[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const data = ctreeForkData(entry);
		if (!data) continue;
		const close = closes.get(entry.id);
		const status: ForkStatus = close ? close.data.status : "open";
		const onCurrentPath = currentBranchIds.has(entry.id);
		const presentation: ForkPresentation =
			status === "open" ? (onCurrentPath ? "active" : "dangling") : status === "squashed" ? "squashed" : "rejected";
		const depth = session.getBranch(entry.id).filter((parent) => ctreeForkData(parent)).length;
		forks.push({
			entryId: entry.id,
			entry,
			data,
			close,
			status,
			presentation,
			onCurrentPath,
			depth,
		});
	}
	return forks;
}

/** Open forks sharing the given fork's parentEntryId (tournament set), excluding itself. */
export function siblingForks(forks: ForkInfo[], forkEntryId: string): ForkInfo[] {
	const self = forks.find((f) => f.entryId === forkEntryId);
	if (!self) return [];
	return forks.filter(
		(f) => f.entryId !== forkEntryId && f.status === "open" && f.data.parentEntryId === self.data.parentEntryId,
	);
}

/** Closest open fork walking leaf→root; undefined when on a clean trunk (F2.1). */
export function nearestOpenFork(branch: readonly SessionEntry[], forks: ForkInfo[]): ForkInfo | undefined {
	const byId = new Map(forks.map((fork) => [fork.entryId, fork]));
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;
		const fork = byId.get(entry.id);
		if (fork?.status === "open") return fork;
	}
	return undefined;
}

/** ctree/decision records visible from the leaf, in root→leaf order (F7). */
export function decisionsOnPath(branch: readonly SessionEntry[]): CustomMessageEntry[] {
	return branch.filter(
		(entry): entry is CustomMessageEntry => isCustomMessageEntry(entry) && entry.customType === CTREE_DECISION,
	);
}

/** All ctree/fork entries in file order (forest + panel listing). */
export function forkEntries(entries: readonly SessionEntry[]): CustomEntry[] {
	return entries.filter((e): e is CustomEntry => Boolean(ctreeForkData(e)));
}

export { CTREE_FORK };
