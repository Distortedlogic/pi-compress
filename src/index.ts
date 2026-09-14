import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAmbient } from "./ambient.ts";
import { registerBranch, registerMerge, registerUndo } from "./branches.ts";
import { realDraft } from "./extension/draft.ts";
import { registerCrop, registerDecisionRenderer, registerPanel } from "./panel.ts";
import { registerCompressionServices, registerRangeCompress } from "./range-compression.ts";

export default function piContextCompress(api: ExtensionAPI): void {
	registerBranch(api);
	registerMerge(api, realDraft);
	registerCrop(api);
	registerRangeCompress(api);
	registerCompressionServices(api);
	registerPanel(api, realDraft);
	registerUndo(api);
	registerAmbient(api);
	registerDecisionRenderer(api);
}
