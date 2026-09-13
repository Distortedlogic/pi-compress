/**
 * pi-context-tree — pi extension entry point. Load with:
 *   pi -e /path/to/pi-context-tree/src/index.ts
 * or symlink this package into ~/.pi/agent/extensions/ for auto-discovery.
 *
 * Commands: /branch /merge /crop /compress /panel /decisions (+ Ctrl+Q).
 * Pinned against pi 0.84.3 — see pi-context-tree-architecture.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CTREE_DECISION, type CtreeDecisionDetails, textOfContent } from "./core/index.ts";
import type { Deps, PiLike } from "./extension/adapter.ts";
import { registerAmbient } from "./extension/ambient.ts";
import { registerBatchCompression } from "./extension/batch-service.ts";
import { registerBranch } from "./extension/branch.ts";
import { registerCrop } from "./extension/crop-cmd.ts";
import { realDraft } from "./extension/draft.ts";
import { registerMerge } from "./extension/merge.ts";
import { registerPanel } from "./extension/panel-cmd.ts";
import { registerRangeCompress } from "./extension/range-compress.ts";
import { registerUndo } from "./extension/undo.ts";
import { decisionCardLines } from "./tui/index.ts";

export default function piContextCompress(api: ExtensionAPI): void {
	// pi's ExtensionAPI is a structural superset of PiLike (verified 0.84.3).
	const pi = api as unknown as PiLike;
	const deps: Deps = { draft: realDraft };

	registerBranch(pi);
	registerMerge(pi, deps);
	registerCrop(pi);
	registerRangeCompress(pi, deps);
	registerPanel(pi, deps);
	registerUndo(pi);
	registerAmbient(pi);
	if (api.events) registerBatchCompression(api);

	// ◆ decision records render as mockup-style cards in the chat (F7 polish)
	pi.registerMessageRenderer?.<CtreeDecisionDetails>(CTREE_DECISION, (message, options) => ({
		invalidate: () => {},
		render: (width: number) =>
			decisionCardLines(
				{
					branchName: message.details?.branchName,
					dateIso: message.timestamp ? new Date(message.timestamp).toISOString().slice(0, 10) : undefined,
					content: textOfContent(message.content),
					siblings: message.details?.siblings,
					expanded: options.expanded,
				},
				width,
			),
	}));
}
