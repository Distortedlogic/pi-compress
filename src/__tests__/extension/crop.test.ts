import { describe, expect, it, vi } from "vitest";
import {
	type CropPlan,
	applyCropPlan,
	cropCandidates,
	cropHandler,
	parseCropFlags,
	planCrop,
	planRemoveTurns,
	prepareRewrite,
	rangeCompressHandler,
	runBlockingRangeCompression,
} from "../../compression.ts";
import { snapshotSession } from "../../session.ts";
import { type FakeWorld, entriesByType, makeFake } from "./fake-pi.ts";

const nativeSelectorHarness = vi.hoisted(() => ({
	calls: [] as unknown[][],
	selections: [] as (string | undefined)[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		TreeSelectorComponent: class {
			constructor(...args: unknown[]) {
				nativeSelectorHarness.calls.push(args);
				const selected = nativeSelectorHarness.selections.shift();
				if (selected === undefined) (args[4] as () => void)();
				else (args[3] as (entryId: string) => void)(selected);
			}
		},
	};
});

function seedBigSession(w: FakeWorld): { snap1: string; snap2: string } {
	w.session.user("audit my tabs");
	w.session.assistant("calling snapshot");
	const snap1 = w.session.toolResult("chrome.snapshot", "S1".repeat(40_000));
	w.session.assistant("analysis of tabs");
	const snap2 = w.session.toolResult("chrome.snapshot", "S2".repeat(200));
	w.session.assistant("done");
	return { snap1, snap2 };
}

function seedRangeSession(w: FakeWorld) {
	w.session.user("root");
	const anchor = w.session.assistant("anchor");
	const start = w.session.user("selected source question");
	const end = w.session.assistant("selected source answer");
	const continuation = w.session.user("continuation question");
	const leaf = w.session.assistant("continuation answer");
	const plan = prepareRewrite(snapshotSession(w.session.manager), start, end);
	return { plan, ids: { anchor, start, end, continuation, leaf } };
}

describe("parseCropFlags", () => {
	it("parses auto/dry-run/thresholds/keep globs", () => {
		const f = parseCropFlags("--auto --dry-run --min-tokens 5000 --older-than 3 --keep chrome.* --keep run_tests");
		expect(f).toEqual({
			auto: true,
			dryRun: true,
			apply: false,
			top: false,
			minTokens: 5000,
			olderThan: 3,
			keep: ["chrome.*", "run_tests"],
		});
	});

	it("parses --apply and --top", () => {
		expect(parseCropFlags("--auto --apply").apply).toBe(true);
		expect(parseCropFlags("--top").top).toBe(true);
	});
});

describe("/crop --top (biggest unprotected result, inline)", () => {
	it("crops the single biggest unprotected result after a confirm", async () => {
		const w = makeFake();
		w.session.user("q");
		w.session.toolResult("small.tool", "s".repeat(8_000)); // unprotected (older), small
		w.session.assistant("a1");
		w.session.toolResult("small.tool", "s".repeat(400)); // latest small.tool — protected
		w.session.assistant("a2");
		const big = w.session.toolResult("big.tool", "b".repeat(120_000)); // unprotected (older), biggest
		w.session.assistant("a3");
		w.session.toolResult("big.tool", "b".repeat(400)); // latest big.tool — protected
		w.session.assistant("a4");

		w.ui.confirmQueue.push(true);
		await cropHandler(w.pi, w.ctx, "--top");

		const markers = entriesByType(w.session, "custom", "ctree/crop");
		expect(markers).toHaveLength(1);
		const stubbed = (markers[0] as { data?: { stubbed?: { entryId: string; tool: string }[] } }).data?.stubbed ?? [];
		expect(stubbed[0]?.entryId).toBe(big); // chose the biggest unprotected, not the small one
		expect(stubbed[0]?.tool).toBe("big.tool");
	});

	it("writes nothing when the user declines the confirm", async () => {
		const w = makeFake();
		const { snap1 } = seedBigSession(w);
		void snap1;
		w.ui.confirmQueue.push(false);
		await cropHandler(w.pi, w.ctx, "--top");
		expect(entriesByType(w.session, "custom", "ctree/crop")).toHaveLength(0);
		expect(w.ui.notes().some((n) => n.includes("cancelled"))).toBe(true);
	});

	it("reports when every candidate is a protected latest result", async () => {
		const w = makeFake();
		w.session.user("q");
		w.session.toolResult("only.tool", "x".repeat(40_000)); // single result → latest → protected
		w.session.assistant("a");
		await cropHandler(w.pi, w.ctx, "--top");
		expect(entriesByType(w.session, "custom", "ctree/crop")).toHaveLength(0);
		expect(w.ui.notes().some((n) => n.includes("protected"))).toBe(true);
	});
});

describe("/crop --auto --apply (headless, no panel)", () => {
	it("applies the auto-selected plan without ui.custom; latest-per-tool stays protected", async () => {
		const w = makeFake();
		const { snap1 } = seedBigSession(w);
		const entriesBefore = w.session.entries.length;

		await cropHandler(w.pi, w.ctx, "--auto --min-tokens 1000 --older-than 1 --apply");

		const tails = entriesByType(w.session, "custom_message", "ctree/crop-tail");
		expect(tails).toHaveLength(1);
		const marker = entriesByType(w.session, "custom", "ctree/crop");
		expect(marker).toHaveLength(1);
		const stubbed = (marker[0] as { data?: { stubbed?: { entryId: string }[] } }).data?.stubbed ?? [];
		expect(stubbed.map((s) => s.entryId)).toEqual([snap1]); // snap2 is latest chrome.snapshot → protected
		// append-only: originals still present
		expect(w.session.entries.length).toBe(entriesBefore + 2);
		expect(w.session.entries.find((e) => e.id === snap1)).toBeDefined();
		expect(w.ui.notes().some((n) => n.includes("✂ cropped 1"))).toBe(true);
	});

	it("--dry-run wins over --apply: reports, writes nothing", async () => {
		const w = makeFake();
		seedBigSession(w);
		const entriesBefore = w.session.entries.length;

		await cropHandler(w.pi, w.ctx, "--auto --min-tokens 1000 --older-than 1 --apply --dry-run");

		expect(w.session.entries.length).toBe(entriesBefore);
		expect(w.ui.notes().some((n) => n.includes("(dry-run) would crop 1"))).toBe(true);
	});

	it("--apply without --auto is refused (interactive review applies from the panel)", async () => {
		const w = makeFake();
		seedBigSession(w);
		const entriesBefore = w.session.entries.length;

		await cropHandler(w.pi, w.ctx, "--apply");

		expect(w.session.entries.length).toBe(entriesBefore);
		expect(w.ui.notesOf("error").some((n) => n.includes("--apply needs --auto"))).toBe(true);
	});

	it("--auto --apply matching nothing writes nothing and says so", async () => {
		const w = makeFake();
		seedBigSession(w);
		const entriesBefore = w.session.entries.length;

		await cropHandler(w.pi, w.ctx, "--auto --min-tokens 999999 --apply");

		expect(w.session.entries.length).toBe(entriesBefore);
		expect(w.ui.notes().some((n) => n.includes("matched nothing"))).toBe(true);
	});
});

describe("applyCropPlan", () => {
	it("branches at the anchor, writes the crop-tail block + marker, keeps originals", async () => {
		const w = makeFake();
		const { snap1 } = seedBigSession(w);
		const tree = snapshotSession(w.session.manager);
		const leaf = w.session.leaf!;
		const plan = planCrop(tree, [snap1]);
		const entriesBefore = w.session.entries.length;

		await applyCropPlan(w.pi, w.ctx, plan);

		// navigated to the anchor with summarize suppressed
		expect(w.calls.navigate).toEqual([{ target: plan.anchorId, options: { summarize: false } }]);
		// crop-tail custom_message carries stubs + kept content
		const tails = entriesByType(w.session, "custom_message", "ctree/crop-tail");
		expect(tails).toHaveLength(1);
		const content = (tails[0] as { content?: string }).content ?? "";
		expect(content).toContain("[cropped: chrome.snapshot");
		expect(content).toContain("analysis of tabs");
		expect(content).not.toContain("S1".repeat(500));
		// marker entry written
		expect(entriesByType(w.session, "custom", "ctree/crop")).toHaveLength(1);
		// append-only: original entries untouched, only additions
		expect(w.session.entries.length).toBe(entriesBefore + 2);
		expect(w.session.entries.find((e) => e.id === snap1)).toBeDefined();
		expect(w.ui.notes().some((n) => n.includes("✂ cropped 1"))).toBe(true);
	});

	it("removes a whole Q&A turn: drop note in the tail, dropped[] in the marker, originals kept", async () => {
		const w = makeFake();
		w.session.user("audit my tabs");
		w.session.assistant("checking");
		const u2 = w.session.user("now suspend the noisy ones");
		w.session.toolResult("chrome.snapshot", "S".repeat(40_000));
		w.session.assistant("done, 41 suspended");
		w.session.user("thanks");
		w.session.assistant("you're welcome");
		const tree = snapshotSession(w.session.manager);
		const plan = planRemoveTurns(tree, [u2]);
		const before = w.session.entries.length;

		await applyCropPlan(w.pi, w.ctx, plan);

		const tail = entriesByType(w.session, "custom_message", "ctree/crop-tail")[0] as { content?: string };
		expect(tail.content).toContain("[dropped turn —");
		expect(tail.content).not.toContain("now suspend the noisy ones"); // question text not re-injected
		expect(tail.content).not.toContain("done, 41 suspended");
		expect(tail.content).toContain("thanks"); // survivor kept

		const marker = entriesByType(w.session, "custom", "ctree/crop")[0] as {
			data?: { dropped?: { userId: string; label: string }[] };
		};
		expect(marker.data?.dropped?.[0]?.userId).toBe(u2);
		expect(marker.data?.dropped?.[0]?.label).toBe("now suspend the noisy ones"); // label preserved in marker

		expect(w.session.entries.length).toBe(before + 2); // append-only
		expect(w.ui.notes().some((n) => n.includes("removed 1 turn"))).toBe(true);
	});

	it("re-validates the leaf and aborts if the session moved (TRD §6)", async () => {
		const w = makeFake();
		const { snap1 } = seedBigSession(w);
		const tree = snapshotSession(w.session.manager);
		const plan = planCrop(tree, [snap1]);

		w.session.user("a new message arrives while the panel was open");
		await applyCropPlan(w.pi, w.ctx, plan);

		expect(w.calls.navigate).toHaveLength(0);
		expect(entriesByType(w.session, "custom_message", "ctree/crop-tail")).toHaveLength(0);
		expect(w.ui.notes().some((n) => n.includes("re-run /crop"))).toBe(true);
	});

	it("rejects changed rewrite identity, ids, and hash before mutation", async () => {
		const w = makeFake();
		const { snap1 } = seedBigSession(w);
		const plan = planCrop(snapshotSession(w.session.manager), [snap1]);
		const before = w.session.entries.length;
		const changedPlans: CropPlan[] = [
			{ ...plan, sessionId: "different-session" },
			{ ...plan, selectedEntryIds: [...plan.selectedEntryIds, "changed"] },
			{ ...plan, continuationEntryIds: [...plan.continuationEntryIds, "changed"] },
			{ ...plan, sourceSha256: "0".repeat(64) },
		];

		for (const changed of changedPlans) await applyCropPlan(w.pi, w.ctx, changed);

		expect(w.calls.navigate).toHaveLength(0);
		expect(w.session.entries).toHaveLength(before);
		expect(entriesByType(w.session, "custom_message", "ctree/crop-tail")).toHaveLength(0);
	});

	it("protects the latest result per tool in candidates (panel enforces double-mark)", () => {
		const w = makeFake();
		const { snap1, snap2 } = seedBigSession(w);
		const tree = snapshotSession(w.session.manager);
		const cands = cropCandidates(tree);
		expect(cands.find((c) => c.entryId === snap1)?.protected).toBe(false);
		expect(cands.find((c) => c.entryId === snap2)?.protected).toBe(true);
	});
});

interface NativeSelectorDriver {
	liveTree: never;
	getTreeCalls: { count: number };
	customOptions: unknown[];
	confirmations: { title: string; message: string }[];
}

function driveNativeSelectors(w: FakeWorld, selections: (string | undefined)[]): NativeSelectorDriver {
	nativeSelectorHarness.calls.length = 0;
	nativeSelectorHarness.selections.length = 0;
	nativeSelectorHarness.selections.push(...selections);

	const liveTree = w.session.entries.map((entry) => ({ entry, children: [] })) as never;
	const getTreeCalls = { count: 0 };
	w.ctx.sessionManager.getTree = (() => {
		getTreeCalls.count += 1;
		return liveTree;
	}) as typeof w.ctx.sessionManager.getTree;
	w.ctx.sessionManager.getEntry = ((entryId: string) =>
		w.session.entries.find((entry) => entry.id === entryId)) as typeof w.ctx.sessionManager.getEntry;
	w.ctx.sessionManager.getBranch = (() => w.session.entries) as typeof w.ctx.sessionManager.getBranch;

	const customOptions: unknown[] = [];
	w.ui.custom = async <T>(factory: unknown, options?: unknown): Promise<T> => {
		customOptions.push(options);
		let result: T | undefined;
		const done = (value: unknown): void => {
			result = value as T;
		};
		(factory as (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown)(
			{ terminal: { rows: 42 } },
			undefined,
			undefined,
			done,
		);
		return result as T;
	};

	const confirmations: { title: string; message: string }[] = [];
	w.ctx.ui.confirm = async (title, message) => {
		confirmations.push({ title, message });
		return false;
	};
	return { liveTree, getTreeCalls, customOptions, confirmations };
}

function expectNoRangeWrites(w: FakeWorld): void {
	expect(entriesByType(w.session, "custom_message", "ctree/range-tail")).toHaveLength(0);
	expect(entriesByType(w.session, "custom", "ctree/range-compact")).toHaveLength(0);
}

async function runNativeCompress(w: FakeWorld): Promise<number> {
	let drafts = 0;
	await rangeCompressHandler(w.pi, w.ctx, "", {
		draft: async () => {
			drafts += 1;
			return "unused summary";
		},
	});
	return drafts;
}

describe("/compress native two-pass selector", () => {
	it("passes the live tree to both selectors and confirms normalized labels and tokens without navigation", async () => {
		const w = makeFake();
		const { ids } = seedRangeSession(w);
		const driver = driveNativeSelectors(w, [ids.start, ids.end]);

		const drafts = await runNativeCompress(w);

		expect(nativeSelectorHarness.calls).toHaveLength(2);
		expect(driver.getTreeCalls.count).toBe(3);
		expect(nativeSelectorHarness.calls[0]?.[0]).not.toBe(driver.liveTree);
		expect(nativeSelectorHarness.calls[1]?.[0]).toEqual(nativeSelectorHarness.calls[0]?.[0]);
		expect(nativeSelectorHarness.calls[0]?.[1]).toBe(ids.leaf);
		expect(nativeSelectorHarness.calls[0]?.[6]).toBe(ids.leaf);
		expect(nativeSelectorHarness.calls[1]?.[6]).toBe(ids.start);
		expect(nativeSelectorHarness.calls.map((call) => call[7])).toEqual(["default", "default"]);
		expect(driver.customOptions).toEqual([undefined, undefined]);
		expect(w.calls.navigate).toHaveLength(0);
		expect(driver.confirmations).toHaveLength(1);
		expect(driver.confirmations[0]?.message).toContain("selected source question");
		expect(driver.confirmations[0]?.message).toContain("selected source answer");
		expect(driver.confirmations[0]?.message).toMatch(/2 entries · ~[0-9.]+k? tokens/);
		expect(drafts).toBe(0);
		expectNoRangeWrites(w);
	});

	it("writes nothing when the first selector is cancelled", async () => {
		const w = makeFake();
		seedRangeSession(w);
		driveNativeSelectors(w, [undefined]);

		expect(await runNativeCompress(w)).toBe(0);
		expect(nativeSelectorHarness.calls).toHaveLength(1);
		expect(w.calls.navigate).toHaveLength(0);
		expectNoRangeWrites(w);
	});

	it("writes nothing when the second selector is cancelled", async () => {
		const w = makeFake();
		const { ids } = seedRangeSession(w);
		driveNativeSelectors(w, [ids.start, undefined]);

		expect(await runNativeCompress(w)).toBe(0);
		expect(nativeSelectorHarness.calls).toHaveLength(2);
		expect(w.calls.navigate).toHaveLength(0);
		expectNoRangeWrites(w);
	});

	it("shows an off-path notice and reopens the first selector", async () => {
		const w = makeFake();
		w.session.user("root");
		const anchor = w.session.assistant("anchor");
		const offPath = w.session.user("inactive branch message");
		w.session.assistant("inactive branch answer");
		w.session.at(anchor);
		const start = w.session.user("selected start");
		const end = w.session.assistant("selected end");
		w.session.assistant("continuation");
		driveNativeSelectors(w, [offPath, start, end]);

		await runNativeCompress(w);

		expect(nativeSelectorHarness.calls).toHaveLength(3);
		const visibleIds = (nativeSelectorHarness.calls[0]?.[0] as { entry: { id: string } }[]).map(
			(node) => node.entry.id,
		);
		expect(visibleIds).not.toContain(offPath);
		expect(nativeSelectorHarness.calls[1]?.[6]).toBe(offPath);
		expect(w.ui.notes().some((note) => /off-path|active context/.test(note))).toBe(true);
		expect(w.calls.navigate).toHaveLength(0);
		expectNoRangeWrites(w);
	});

	it("shows a protected decision notice and reopens the first selector", async () => {
		const w = makeFake();
		w.session.user("root");
		w.session.assistant("anchor");
		const decision = w.session.append({
			type: "custom_message",
			customType: "ctree/decision",
			content: "## Decision: protected",
			display: true,
		});
		const start = w.session.user("selected start");
		const end = w.session.assistant("selected end");
		w.session.assistant("continuation");
		driveNativeSelectors(w, [decision, start, end]);

		await runNativeCompress(w);

		expect(nativeSelectorHarness.calls).toHaveLength(3);
		expect(nativeSelectorHarness.calls[1]?.[6]).toBe(decision);
		expect(w.ui.notes().some((note) => note.includes("decision record"))).toBe(true);
		expect(w.calls.navigate).toHaveLength(0);
		expectNoRangeWrites(w);
	});

	it("expands a selected tool-result member to the complete group boundaries", async () => {
		const w = makeFake();
		w.session.user("root");
		w.session.assistant("anchor");
		const call = w.session.message({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } }],
			provider: "anthropic",
			model: "opus-4.8",
		});
		const result = w.session.message({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read_file",
			content: [{ type: "text", text: "file body" }],
			isError: false,
		});
		w.session.assistant("continuation");
		const driver = driveNativeSelectors(w, [result, call]);

		await runNativeCompress(w);

		expect(nativeSelectorHarness.calls).toHaveLength(2);
		expect(nativeSelectorHarness.calls[1]?.[6]).toBe(call);
		expect(driver.confirmations[0]?.message).toMatch(/2 entries/);
		expect(driver.confirmations[0]?.message).toContain("read_file");
		expect(w.calls.navigate).toHaveLength(0);
		expectNoRangeWrites(w);
	});
});

function installBlockingUi(w: FakeWorld): () => boolean {
	let busy = false;
	w.ui.custom = <T>(factory: unknown): Promise<T> =>
		new Promise<T>((resolve) => {
			busy = true;
			const done = (value: unknown): void => {
				busy = false;
				resolve(value as T);
			};
			(factory as (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown)(
				{ terminal: { rows: 42 }, requestRender: () => {} },
				{ fg: (_color: string, text: string) => text },
				undefined,
				done,
			);
		});
	return () => busy;
}

describe("range compression behavior", () => {
	it("stays busy until the generated summary becomes compressed context", async () => {
		const w = makeFake();
		const { plan } = seedRangeSession(w);
		const before = w.session.entries.length;
		const isBusy = installBlockingUi(w);
		let markDraftStarted!: () => void;
		const draftStarted = new Promise<void>((resolve) => {
			markDraftStarted = resolve;
		});
		let resolveDraft!: (summary: string) => void;
		const pendingDraft = new Promise<string>((resolve) => {
			resolveDraft = resolve;
		});

		let settled = false;
		const compression = runBlockingRangeCompression(w.pi, w.ctx, plan, undefined, {
			draft: async () => {
				markDraftStarted();
				return pendingDraft;
			},
		});
		void compression.then(() => {
			settled = true;
		});
		await draftStarted;
		await Promise.resolve();

		expect(isBusy()).toBe(true);
		expect(settled).toBe(false);
		expectNoRangeWrites(w);

		resolveDraft("  generated range summary  ");
		expect(await compression).toBe(true);
		expect(isBusy()).toBe(false);

		const tail = entriesByType(w.session, "custom_message", "ctree/range-tail")[0] as { content?: string };
		const marker = entriesByType(w.session, "custom", "ctree/range-compact")[0];
		expect(tail.content).toContain("generated range summary");
		expect(tail.content).not.toContain("selected source question");
		expect(tail.content).not.toContain("selected source answer");
		expect(marker?.parentId).toBe((tail as { id?: string }).id);
		expect(w.session.entries.length).toBe(before + 2);
		expect(plan.selectedEntryIds.every((id) => w.session.entries.some((entry) => entry.id === id))).toBe(true);
	});

	it("writes nothing when summary generation fails", async () => {
		const w = makeFake();
		const { plan } = seedRangeSession(w);
		const before = w.session.entries.length;
		const isBusy = installBlockingUi(w);

		expect(
			await runBlockingRangeCompression(w.pi, w.ctx, plan, undefined, {
				draft: async () => {
					throw new Error("generation failed");
				},
			}),
		).toBe(false);

		expect(isBusy()).toBe(false);
		expect(w.session.entries.length).toBe(before);
		expectNoRangeWrites(w);
	});

	it("writes nothing when anchor navigation is cancelled", async () => {
		const w = makeFake();
		const { plan } = seedRangeSession(w);
		const before = w.session.entries.length;
		w.ctx.navigateTree = async () => ({ cancelled: true });

		await runBlockingRangeCompression(w.pi, w.ctx, plan, undefined, {
			draft: async () => "generated range summary",
		});

		expect(w.session.entries.length).toBe(before);
		expect(entriesByType(w.session, "custom_message", "ctree/range-tail")).toHaveLength(0);
		expect(entriesByType(w.session, "custom", "ctree/range-compact")).toHaveLength(0);
		expect(w.ui.notes().some((note) => note.includes("navigation"))).toBe(true);
	});

	it("writes nothing when the source leaf changed", async () => {
		const w = makeFake();
		const { plan } = seedRangeSession(w);
		w.session.user("new leaf after selection");
		const before = w.session.entries.length;

		await runBlockingRangeCompression(w.pi, w.ctx, plan, undefined, {
			draft: async () => "unused summary",
		});

		expect(w.session.entries.length).toBe(before);
		expectNoRangeWrites(w);
	});

	it("preserves the unchanged continuation after the generated summary", async () => {
		const w = makeFake();
		const { plan } = seedRangeSession(w);

		await runBlockingRangeCompression(w.pi, w.ctx, plan, undefined, {
			draft: async () => "generated range summary",
		});

		const tail = entriesByType(w.session, "custom_message", "ctree/range-tail")[0] as { content?: string };
		const content = tail.content ?? "";
		expect(content).toContain("generated range summary");
		expect(content).toContain("continuation question");
		expect(content).toContain("continuation answer");
		expect(content.indexOf("continuation question")).toBeLessThan(content.indexOf("continuation answer"));
		expect(content).not.toContain("selected source question");
		expect(content).not.toContain("selected source answer");
	});

	it("writes summary-only output when the selected range reaches the leaf", async () => {
		const w = makeFake();
		w.session.user("root");
		w.session.assistant("anchor");
		const start = w.session.user("selected through leaf");
		const leaf = w.session.assistant("selected final answer");
		const plan = prepareRewrite(snapshotSession(w.session.manager), start, leaf);

		await runBlockingRangeCompression(w.pi, w.ctx, plan, undefined, {
			draft: async () => "generated leaf summary",
		});

		const tail = entriesByType(w.session, "custom_message", "ctree/range-tail")[0] as { content?: string };
		const content = tail.content ?? "";
		expect(content).toContain("generated leaf summary");
		expect(content).not.toContain("unchanged continuation");
		expect(content).not.toContain("selected through leaf");
		expect(content).not.toContain("selected final answer");
	});
});
