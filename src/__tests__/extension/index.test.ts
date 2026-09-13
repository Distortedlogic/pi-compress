import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionCommandContext, createEventBus } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { registerBatchCompression } from "../../batch.ts";
import { undoHandler } from "../../branches.ts";
import { applyRangeCompressionPlan, prepareRewrite } from "../../compression.ts";
import piContextTree from "../../index.ts";
import {
	COMPRESSION_ENTRY,
	COMPRESSION_REQUEST,
	COMPRESSION_RESULT,
	COMPRESSION_TAIL,
	type CompressionDetails,
	type CompressionRequest,
	CompressionRequestSchema,
	type CompressionResult,
	CompressionResultSchema,
	LEGACY_COMPRESSION_ENTRY,
	QUEUED_TASK_TAIL,
	compressionDetails,
	compressionTailDetails,
} from "../../protocol.ts";
import { snapshotSession } from "../../session.ts";
import { makeFake } from "./fake-pi.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping is the point
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

describe("extension entry point", () => {
	it("registers all commands in deterministic order and the ◆ decision card renderer", () => {
		const w = makeFake();
		const renderers = new Map<
			string,
			(
				m: { customType: string; content: string; details?: unknown; timestamp?: number },
				o: { expanded: boolean },
				t: unknown,
			) => { render(width: number): string[] } | undefined
		>();
		(w.pi as { registerMessageRenderer?: unknown }).registerMessageRenderer = (customType: string, renderer: never) => {
			renderers.set(customType, renderer);
		};

		piContextTree(w.pi as unknown as ExtensionAPI);

		expect([...w.commands.keys()]).toEqual(["branch", "merge", "crop", "compress", "panel", "decisions", "undo"]);
		const renderer = renderers.get("ctree/decision");
		expect(renderer).toBeDefined();
		const component = renderer?.(
			{
				customType: "ctree/decision",
				content: "## Decision: feat-x\n**Outcome:** works.",
				details: { v: 1, forkEntryId: "e1", branchName: "feat-x", siblings: [{ name: "alt", reason: "slower" }] },
				timestamp: Date.parse("2026-06-12T10:00:00Z"),
			},
			{ expanded: false },
			{ fg: (_color: string, text: string) => text },
		);
		const lines = (component?.render(90) ?? []).map(strip);
		expect(lines[0]).toContain("◆ feat-x");
		expect(lines.join("\n")).toContain("2026-06-12");
		expect(lines.join("\n")).toContain("✗ alt — slower");
	});
});

function batchWorld() {
	const world = makeFake();
	const hooks = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => void>();
	const api = Object.assign(world.pi, {
		events: createEventBus(),
		on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void) => hooks.set(name, handler),
	}) as unknown as ExtensionAPI;
	const ctx = Object.assign(world.ctx, {
		cwd: "/tmp",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
	}) as unknown as ExtensionCommandContext;
	ctx.modelRegistry.complete = async () => ({ content: [{ type: "text", text: "Reviewed batch summary." }] }) as never;
	world.session.user("Source context.");
	const anchorEntryId = world.session.append({ type: "custom", customType: "batch-anchor", data: {} });
	world.session.user("[Queued task]\n\n## Current batch\n- [ ] Do the current work.");
	const lastSettledEntryId = world.session.assistant("Current work finished.");
	const base = {
		v: 1 as const,
		sessionId: ctx.sessionManager.getSessionId(),
		operationId: randomUUID(),
		runId: "run",
		batch: {
			planId: "a".repeat(64),
			batchId: "b".repeat(64),
			structuralRevision: "c".repeat(64),
			fileRevision: "d".repeat(64),
			bitmap: [false],
		},
		anchorEntryId,
		lastSettledEntryId,
	};
	registerBatchCompression(api);

	function request(
		action: CompressionRequest["action"],
		changes: Partial<CompressionRequest> = {},
	): Promise<CompressionResult> {
		const input: CompressionRequest = { ...base, action, requestId: randomUUID(), ...changes };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error("Compression request timed out."));
			}, 1000);
			const unsubscribe = api.events.on(COMPRESSION_RESULT, (value) => {
				if ((value as { requestId?: string })?.requestId !== input.requestId) return;
				clearTimeout(timer);
				unsubscribe();
				if (!Value.Check(CompressionResultSchema, value)) reject(new Error("Invalid compression result."));
				else resolve(value);
			});
			api.events.emit(COMPRESSION_REQUEST, { request: input, context: ctx });
		});
	}
	return { ...world, ctx, api, request, base };
}

describe("independent compression interface", () => {
	it("keeps external schemas exact", () => {
		const world = batchWorld();
		const request = {
			...world.base,
			action: "status" as const,
			requestId: randomUUID(),
		};
		const result = {
			v: 1 as const,
			requestId: request.requestId,
			sessionId: request.sessionId,
			operationId: request.operationId,
			status: "missing" as const,
		};

		expect(Value.Check(CompressionRequestSchema, request)).toBe(true);
		expect(Value.Check(CompressionRequestSchema, { ...request, future: true })).toBe(false);
		expect(Value.Check(CompressionRequestSchema, { ...request, batch: { ...request.batch, future: true } })).toBe(
			false,
		);
		expect(Value.Check(CompressionResultSchema, result)).toBe(true);
		expect(Value.Check(CompressionResultSchema, { ...result, future: true })).toBe(false);
	});

	it("reads current and legacy compression markers and both tail types", () => {
		const world = makeFake();
		const hash = "a".repeat(64);
		const details: CompressionDetails = {
			v: 2,
			runId: "run",
			planId: hash,
			batchId: hash,
			operationId: "operation",
			structuralRevision: hash,
			fileRevision: hash,
			preCompletionBitmap: [false],
			sourceLeafId: "source",
			preTaskAnchorId: "anchor",
			taskMessageEntryId: "task",
			startEntryId: "start",
			endEntryId: "end",
			selectedEntryIds: ["start", "end"],
			sourceSha256: hash,
		};
		const current = world.session.append({ type: "custom", customType: COMPRESSION_ENTRY, data: details });
		const legacy = world.session.append({ type: "custom", customType: LEGACY_COMPRESSION_ENTRY, data: details });
		const queued = world.session.append({
			type: "custom_message",
			customType: QUEUED_TASK_TAIL,
			content: "task",
			display: true,
			details,
		});
		const summary = world.session.append({
			type: "custom_message",
			customType: COMPRESSION_TAIL,
			content: "summary",
			display: true,
			details,
		});

		expect(compressionDetails(world.session.manager.getEntry(current)!)?.runId).toBe("run");
		expect(compressionDetails(world.session.manager.getEntry(legacy)!)?.runId).toBe("run");
		expect(compressionTailDetails(world.session.manager.getEntry(queued)!)?.runId).toBe("run");
		expect(compressionTailDetails(world.session.manager.getEntry(summary)!)?.runId).toBe("run");
	});

	it("prepares without mutation, applies once, and restores originals with undo", async () => {
		const world = batchWorld();
		world.ui.editorQueue.push("__ACCEPT_PREFILL__");
		const before = world.session.entries.length;
		expect((await world.request("prepare")).status).toBe("prepared");
		expect(world.session.entries).toHaveLength(before);
		const applied = await world.request("apply");
		expect(applied.status).toBe("applied");
		expect(applied.details?.preCompletionBitmap).toEqual([false]);
		const after = world.session.entries.length;
		expect(after).toBe(before + 3);
		const appended = world.session.entries.slice(before);
		expect(appended.map((entry) => ("customType" in entry ? entry.customType : undefined))).toEqual([
			QUEUED_TASK_TAIL,
			COMPRESSION_TAIL,
			COMPRESSION_ENTRY,
		]);
		expect(appended[1]?.parentId).toBe(appended[0]?.id);
		expect(appended[2]?.parentId).toBe(appended[1]?.id);
		expect((await world.request("apply")).status).toBe("applied");
		expect(world.session.entries).toHaveLength(after);
		await undoHandler(world.api, world.ctx);
		expect(world.session.leaf).toBe(applied.details?.sourceLeafId);
	});

	it("does not mutate after cancellation or an empty review", async () => {
		const world = batchWorld();
		const before = world.session.entries.length;
		expect((await world.request("prepare")).status).toBe("cancelled");
		expect((await world.request("apply")).status).toBe("cancelled");
		expect(world.session.entries).toHaveLength(before);
	});

	it("rejects a session change between preparation and apply", async () => {
		const world = batchWorld();
		world.ui.editorQueue.push("__ACCEPT_PREFILL__");
		expect((await world.request("prepare")).status).toBe("prepared");
		world.session.user("New steering.");
		const before = world.session.entries.length;
		expect((await world.request("apply")).status).toBe("failed");
		expect(world.session.entries).toHaveLength(before);
	});

	it("rejects changed batch metadata for a prepared operation", async () => {
		const world = batchWorld();
		world.ui.editorQueue.push("__ACCEPT_PREFILL__");
		expect((await world.request("prepare")).status).toBe("prepared");
		const result = await world.request("apply", { batch: { ...world.base.batch, bitmap: [true] } });
		expect(result).toMatchObject({ status: "failed", code: "operation_conflict" });
	});

	it("keeps manual range compression without summary review", async () => {
		const world = makeFake();
		world.session.user("Keep the source context.");
		const entryId = world.session.assistant("Compress this execution.");
		const plan = prepareRewrite(snapshotSession(world.session.manager), entryId, entryId);
		world.ui.editorQueue.push("Do not open the editor.");
		const applied = await applyRangeCompressionPlan(world.pi, world.ctx, plan, "test/model", undefined, {
			draft: async () => "Generated summary.",
		});
		expect(applied).toBe(true);
		expect(world.ui.editorQueue).toEqual(["Do not open the editor."]);
	});
});
