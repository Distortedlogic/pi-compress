/**
 * pi-context-tree — pi extension entry point. Load with:
 *   pi -e /path/to/pi-context-tree/src/index.ts
 * or symlink this package into ~/.pi/agent/extensions/ for auto-discovery.
 *
 * Commands: /branch /merge /crop /compress /panel /decisions (+ Ctrl+Q).
 * Pinned against pi 0.84.3 — see pi-context-tree-architecture.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CTREE_DECISION, type CtreeDecisionDetails, parseCtreeDecisionDetails, textOfContent } from "./core/index.ts";
import { registerAmbient } from "./extension/ambient.ts";
import { registerBatchCompression } from "./extension/batch-service.ts";
import { registerBranch } from "./extension/branch.ts";
import { registerCrop } from "./extension/crop-cmd.ts";
import { type Deps, realDraft } from "./extension/draft.ts";
import { registerMerge } from "./extension/merge.ts";
import { registerPanel } from "./extension/panel-cmd.ts";
import { registerRangeCompress } from "./extension/range-compress.ts";
import { registerUndo } from "./extension/undo.ts";
import { decisionCardLines } from "./tui/index.ts";

export default function piContextCompress(api: ExtensionAPI): void {
	const deps: Deps = { draft: realDraft };

	registerBranch(api);
	registerMerge(api, deps);
	registerCrop(api);
	registerRangeCompress(api, deps);
	registerPanel(api, deps);
	registerUndo(api);
	registerAmbient(api);
	if (api.events) registerBatchCompression(api);

	// ◆ decision records render as mockup-style cards in the chat (F7 polish)
	api.registerMessageRenderer<CtreeDecisionDetails>(CTREE_DECISION, (message, options) => {
		const details = parseCtreeDecisionDetails(message.details);
		return {
			invalidate: () => {},
			render: (width: number) =>
				decisionCardLines(
					{
						branchName: details?.branchName,
						dateIso: message.timestamp ? new Date(message.timestamp).toISOString().slice(0, 10) : undefined,
						content: textOfContent(message.content),
						siblings: details?.siblings,
						expanded: options.expanded,
					},
					width,
				),
		};
	});
}
