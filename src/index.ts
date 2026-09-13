/**
 * pi-context-tree — pi extension entry point. Load with:
 *   pi -e /path/to/pi-context-tree/src/index.ts
 * or symlink this package into ~/.pi/agent/extensions/ for auto-discovery.
 *
 * Commands: /branch /merge /crop /compress /panel /decisions (+ Ctrl+Q).
 * Pinned against pi 0.84.3 — see pi-context-tree-architecture.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBatchCompression } from "./batch.ts";
import { registerBranch, registerMerge, registerUndo } from "./branches.ts";
import { registerCrop } from "./compression.ts";
import { type Deps, realDraft } from "./extension/draft.ts";
import { registerAmbient, registerDecisionRenderer, registerPanel } from "./panel.ts";
import { registerRangeCompress } from "./range-compression.ts";

export default function piContextCompress(api: ExtensionAPI): void {
	const deps: Deps = { draft: realDraft };

	registerBranch(api);
	registerMerge(api, deps);
	registerCrop(api);
	registerRangeCompress(api);
	registerPanel(api, deps);
	registerUndo(api);
	registerAmbient(api);
	registerDecisionRenderer(api);
	if (api.events) registerBatchCompression(api);
}
