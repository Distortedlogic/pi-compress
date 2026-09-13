import type { ExtensionContext, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

export type SessionManagerView = ExtensionContext["sessionManager"];

export interface SessionSnapshot {
	entries: SessionEntry[];
	branch: SessionEntry[];
	contextEntries: SessionEntry[];
	tree: SessionTreeNode[];
	leafId: string | null;
}

export function snapshotSession(session: SessionManagerView): SessionSnapshot {
	return {
		entries: structuredClone(session.getEntries()),
		branch: structuredClone(session.getBranch()),
		contextEntries: structuredClone(session.buildContextEntries()),
		tree: structuredClone(session.getTree()),
		leafId: session.getLeafId(),
	};
}

export function snapshotEntry(snapshot: SessionSnapshot, entryId: string): SessionEntry | undefined {
	return snapshot.entries.find((entry) => entry.id === entryId);
}
