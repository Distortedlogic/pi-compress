import { describe, expect, it } from "vitest";
import { extractForks } from "../../branches.ts";
import { PanelController, panelHeader } from "../../panel.ts";
import { snapshotSession } from "../../session.ts";
import { PiSessionFixture, filler } from "../session-fixture.ts";

function build() {
	const session = new PiSessionFixture();
	session.user("kickoff");
	session.assistant("plan");
	const storage = session.fork("storage-layer");
	session.user("noisy branch work");
	session.at(storage);
	const decision = session.decision(storage, "storage-layer", "## Decision: storage-layer\nchose session storage");
	session.close(storage, "squashed", { decisionEntryId: decision });
	const snapshot = session.toolUse("chrome.snapshot", { url: "tab-audit" }, filler(60_000));
	session.assistant("analysis");
	const latestSnapshot = session.toolUse("chrome.snapshot", { url: "after" }, filler(400));
	session.at(latestSnapshot);
	session.fork("fix-flaky-test", { trunkModel: "opus-4.8", branchModel: "haiku-4.5" });
	session.user("tests flake");
	session.toolUse("run_tests", {}, filler(8_000));
	session.assistant("root cause found");
	return { session, ids: { decision, snapshot } };
}

function panelInput(session: PiSessionFixture, overrides: Record<string, unknown> = {}) {
	return {
		...snapshotSession(session.session),
		forks: extractForks(session.session),
		project: "tabwrangler",
		model: "haiku-4.5",
		contextWindow: 200_000,
		...overrides,
	};
}

function makeController(overrides: Record<string, unknown> = {}) {
	const { session, ids } = build();
	return { controller: new PanelController(panelInput(session, overrides)), ids };
}

describe("panel header", () => {
	it("derives the active branch and estimated gauge band", () => {
		const { controller } = makeController();
		const header = panelHeader(controller.input, controller.view);
		expect(header.branchName).toBe("fix-flaky-test");
		expect(header.window).toBe(200_000);
		expect(header.tokens).toBeGreaterThan(15_000);
		expect(["low", "healthy", "filling", "red"]).toContain(header.band);
	});

	it("uses an estimate for zero usage and trusts non-zero Pi usage", () => {
		const estimated = makeController({ usageTokens: 0 }).controller;
		expect(panelHeader(estimated.input, estimated.view).estimated).toBe(true);
		const measured = makeController({ usageTokens: 42_000 }).controller;
		const header = panelHeader(measured.input, measured.view);
		expect(header.tokens).toBe(42_000);
		expect(header.estimated).toBe(false);
	});
});

describe("PanelController sections", () => {
	it("shows the tree title and optional session name", () => {
		const named = makeController({ sessionName: "2026-06-12-a" }).controller;
		expect(named.sectionTitle()).toBe("SESSION 2026-06-12-a · TRUNK + BRANCHES · est tokens (~chars/4)");
		expect(makeController().controller.sectionTitle()).toBe("TRUNK + BRANCHES · est tokens (~chars/4)");
	});

	it("shows live crop reclaim totals", () => {
		const { controller: panel, ids } = makeController();
		panel.setView("crop");
		expect(panel.sectionTitle()).toContain("reclaim ~0");
		panel.marks.add(ids.snapshot);
		expect(panel.sectionTitle()).toContain("reclaim ~15k");
		expect(panel.sectionTitle()).toContain("originals untouched");
	});

	it("names consumer, decision, and whole-turn views", () => {
		const panel = makeController().controller;
		panel.setView("consumers");
		expect(panel.sectionTitle()).toBe("TOKENS BY SOURCE — CURRENT BRANCH CONTEXT");
		panel.setView("decisions");
		expect(panel.sectionTitle()).toBe("DECISION RECORDS ON TRUNK (newest first)");
		panel.cropMode = "turn";
		panel.setView("crop");
		expect(panel.sectionTitle()).toContain("REMOVE WHOLE TURNS");
	});
});

describe("PanelController state", () => {
	it("keeps premarks and read-only state as plain controller data", () => {
		const { session, ids } = build();
		const panel = new PanelController(panelInput(session, { premark: [ids.snapshot], readOnly: true }));
		expect(panel.marks.has(ids.snapshot)).toBe(true);
		expect(panel.input.readOnly).toBe(true);
	});

	it("changes views without keeping an armed protected result", () => {
		const panel = makeController().controller;
		panel.armedId = "entry";
		panel.setView("crop");
		expect(panel.view).toBe("crop");
		expect(panel.armedId).toBeUndefined();
		expect(panel.footerHelp()).toContain("space mark");
	});
});
