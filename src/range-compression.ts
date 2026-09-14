import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionTreeNode,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { refreshAmbient } from "./ambient.ts";
import { estimateTextTokens, fmtTokens, serializeEntry, snapshotSession } from "./context.ts";
import {
	type RangeCandidate,
	type RewritePlan,
	applyRewrite,
	prepareRewrite,
	rangeCandidates,
	resolveRangeEndpoint,
	revalidateRewrite,
	sourceSha8,
} from "./core/range-rewrite.ts";
import { draftRangeSummary, realDraft } from "./extension/draft.ts";
import {
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CtreeRangeCompactData,
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	type RangeCompressionFailureCode,
	type RangeCompressionPrepareRequest,
	type RangeCompressionRequest,
	RangeCompressionRequestSchema,
	type RangeCompressionResult,
	RangeCompressionResultSchema,
	type RangeCompressionTransport,
	ctreeRangeCompactData,
} from "./protocol.ts";

export interface RangeCompressionTarget {
	readonly operationId: string;
	readonly startEntryId: string;
	readonly endEntryId: string;
	readonly anchorEntryId?: string;
	readonly instructions?: string;
	readonly signal?: AbortSignal;
}

export interface RangeCompressionInput extends RangeCompressionTarget {
	readonly review: boolean;
}

export interface PreparedRangeCompression {
	readonly plan: RewritePlan;
	readonly summary: string;
	readonly summaryModel: string;
	readonly operationId: string;
}

export type RangeCompressionOutcome = { status: "applied"; details: CtreeRangeCompactData } | { status: "cancelled" };

type RangePhase = "start" | "end";

type ManualPreparationResult =
	| { status: "prepared"; prepared: PreparedRangeCompression }
	| { status: "cancelled" }
	| { status: "failed"; error: string };

type RangeCompressionServiceOutcome =
	| { status: "prepared" }
	| { status: "applied"; details: CtreeRangeCompactData }
	| { status: "cancelled" }
	| { status: "missing" }
	| { status: "failed"; code: RangeCompressionFailureCode };

interface StoredRangeCompression {
	readonly request: RangeCompressionPrepareRequest;
	readonly prepared: PreparedRangeCompression;
}

interface PendingRangeCompression {
	readonly request: RangeCompressionRequest;
	readonly promise: Promise<RangeCompressionServiceOutcome>;
	readonly controller?: AbortController;
}

interface RangeSelectorProjection {
	tree: SessionTreeNode[];
	entryIds: string[];
}

class InvalidRangeCompressionRequestError extends Error {}

class RangeCompressionSessionChangedError extends Error {}

function immutablePlan(plan: RewritePlan): RewritePlan {
	return Object.freeze({
		...plan,
		selectedEntryIds: Object.freeze([...plan.selectedEntryIds]),
		continuationEntryIds: Object.freeze([...plan.continuationEntryIds]),
		selectedEntries: Object.freeze([...plan.selectedEntries]),
		continuationEntries: Object.freeze([...plan.continuationEntries]),
	});
}

function assertStableSession(ctx: ExtensionCommandContext, sessionId: string, sourceLeafId: string | null): void {
	if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== sourceLeafId) {
		throw new RangeCompressionSessionChangedError("The session changed during range compression.");
	}
	if (ctx.hasPendingMessages()) {
		throw new InvalidRangeCompressionRequestError("Range compression cannot run while messages are pending.");
	}
}

function indexTreeNodes(tree: readonly SessionTreeNode[]): Map<string, SessionTreeNode> {
	const byId = new Map<string, SessionTreeNode>();
	const pending = [...tree];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!node) continue;
		byId.set(node.entry.id, node);
		pending.push(...node.children);
	}
	return byId;
}

function buildLinearSelectorProjection(
	ctx: ExtensionCommandContext,
	entryIds: readonly string[],
): RangeSelectorProjection {
	const activeEntryIds = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
	const treeNodes = indexTreeNodes(ctx.sessionManager.getTree());
	const sourceNodes = entryIds.flatMap((entryId) => {
		if (!activeEntryIds.has(entryId)) return [];
		const node = treeNodes.get(entryId);
		return node ? [node] : [];
	});
	let child: SessionTreeNode | undefined;
	for (let index = sourceNodes.length - 1; index >= 0; index--) {
		const source = sourceNodes[index];
		if (!source) continue;
		child = {
			entry: source.entry,
			children: child ? [child] : [],
			label: source.label,
			labelTimestamp: source.labelTimestamp,
		};
	}
	return {
		tree: child ? [child] : [],
		entryIds: sourceNodes.map((node) => node.entry.id),
	};
}

function buildStartSelectorProjection(
	ctx: ExtensionCommandContext,
	candidates: readonly RangeCandidate[],
): RangeSelectorProjection {
	const entryIds = candidates.flatMap((candidate) => {
		if (candidate.protected) return [];
		const endpoint = resolveRangeEndpoint(candidates, candidate.startEntryId, "start");
		return endpoint.ok ? [endpoint.entryId] : [];
	});
	return buildLinearSelectorProjection(ctx, entryIds);
}

function buildEndSelectorProjection(
	ctx: ExtensionCommandContext,
	candidates: readonly RangeCandidate[],
	startCandidateIndex: number,
): RangeSelectorProjection {
	const entryIds: string[] = [];
	for (let index = startCandidateIndex; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (!candidate || candidate.protected) break;
		const endpoint = resolveRangeEndpoint(candidates, candidate.endEntryId, "end");
		if (!endpoint.ok) break;
		entryIds.push(endpoint.entryId);
	}
	return buildLinearSelectorProjection(ctx, entryIds);
}

async function selectNativeEntry(
	ctx: ExtensionCommandContext,
	phase: RangePhase,
	projection: RangeSelectorProjection,
	initialSelectedId: string,
): Promise<string | undefined> {
	ctx.ui.notify(
		phase === "start" ? "Select the first entry of the range" : "Select the last entry of the range",
		"info",
	);
	return ctx.ui.custom<string | undefined>(
		(
			tui: { terminal: { rows: number } },
			_theme: unknown,
			_keybindings: unknown,
			done: (entryId: string | undefined) => void,
		) =>
			new TreeSelectorComponent(
				projection.tree,
				projection.entryIds.at(-1) ?? null,
				tui.terminal.rows,
				(entryId) => done(entryId),
				() => done(undefined),
				undefined,
				initialSelectedId,
				"default",
			),
	);
}

export function renderRangeTail(plan: RewritePlan, approvedSummary: string): string {
	const summary = approvedSummary.trim();
	if (!summary) throw new Error("approved range summary is empty");
	const header = `[ctree/range-compact: summarized ${plan.selectedEntryIds.length} entries, ~${fmtTokens(
		plan.selectedEstTokens,
	)} tokens, source ${sourceSha8(plan)}. Originals preserved at leaf ${plan.sourceLeafId}.]`;
	const parts = [header, summary];
	if (plan.continuationSerialized.trim()) {
		parts.push("[unchanged continuation after compressed range]", plan.continuationSerialized);
	}
	return `${parts.join("\n\n")}\n`;
}

function compressionDetails(
	plan: RewritePlan,
	summary: string,
	summaryModel: string,
	operationId: string,
): CtreeRangeCompactData {
	const summaryEstTokens = estimateTextTokens(summary);
	return {
		v: 1,
		operationId,
		sourceLeafId: plan.sourceLeafId,
		anchorId: plan.anchorId,
		startEntryId: plan.startEntryId,
		endEntryId: plan.endEntryId,
		selectedEntryIds: [...plan.selectedEntryIds],
		selectedEstTokens: plan.selectedEstTokens,
		summaryEstTokens,
		reclaimedEstTokens: plan.selectedEstTokens - summaryEstTokens,
		summaryModel,
		sourceSha8: sourceSha8(plan),
	};
}

export async function prepareRangeCompression(
	ctx: ExtensionCommandContext,
	target: RangeCompressionTarget,
): Promise<PreparedRangeCompression> {
	const sessionId = ctx.sessionManager.getSessionId();
	const sourceLeafId = ctx.sessionManager.getLeafId();
	target.signal?.throwIfAborted();
	await ctx.waitForIdle();
	target.signal?.throwIfAborted();
	assertStableSession(ctx, sessionId, sourceLeafId);

	const model = ctx.model;
	if (!model) throw new InvalidRangeCompressionRequestError("No current model is available for range compression.");
	const snapshot = snapshotSession(ctx.sessionManager);
	let plan: RewritePlan;
	try {
		plan = prepareRewrite(snapshot, target.startEntryId, target.endEntryId, {
			anchorId: target.anchorEntryId,
		});
	} catch (error) {
		throw new InvalidRangeCompressionRequestError(error instanceof Error ? error.message : String(error));
	}
	const summary = (await draftRangeSummary(realDraft, ctx, plan.source, target.instructions, target.signal)).trim();
	if (!summary) throw new Error("The model returned an empty range summary.");
	target.signal?.throwIfAborted();
	assertStableSession(ctx, sessionId, sourceLeafId);
	let validatedPlan: RewritePlan;
	try {
		validatedPlan = immutablePlan(revalidateRewrite(ctx, plan));
	} catch (error) {
		throw new RangeCompressionSessionChangedError(error instanceof Error ? error.message : String(error));
	}
	return Object.freeze({
		plan: validatedPlan,
		summary,
		summaryModel: `${model.provider}/${model.id}`,
		operationId: target.operationId,
	});
}

export async function reviewRangeCompression(
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<PreparedRangeCompression | undefined> {
	const summary = (await ctx.ui.editor("Review selected range summary", prepared.summary))?.trim();
	if (!summary) return undefined;
	return Object.freeze({ ...prepared, summary });
}

export async function applyPreparedRangeCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<CtreeRangeCompactData | undefined> {
	await ctx.waitForIdle();
	if (ctx.hasPendingMessages()) {
		throw new InvalidRangeCompressionRequestError("Range compression cannot run while messages are pending.");
	}
	let plan: RewritePlan;
	try {
		plan = revalidateRewrite(ctx, prepared.plan);
	} catch (error) {
		throw new RangeCompressionSessionChangedError(error instanceof Error ? error.message : String(error));
	}
	const details = compressionDetails(plan, prepared.summary, prepared.summaryModel, prepared.operationId);
	const result = await applyRewrite(pi, ctx, plan, {
		messages: [
			{
				customType: CTREE_RANGE_TAIL,
				content: renderRangeTail(plan, prepared.summary),
				display: true,
				details,
			},
		],
		marker: { customType: CTREE_RANGE_COMPACT, data: details },
	});
	return result.applied ? details : undefined;
}

export async function compressRange(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	input: RangeCompressionInput,
): Promise<RangeCompressionOutcome> {
	const prepared = await prepareRangeCompression(ctx, input);
	const approved = input.review ? await reviewRangeCompression(ctx, prepared) : prepared;
	if (!approved) return { status: "cancelled" };
	const details = await applyPreparedRangeCompression(pi, ctx, approved);
	return details ? { status: "applied", details } : { status: "cancelled" };
}

function sameRangeCompressionRequest(left: RangeCompressionRequest, right: RangeCompressionRequest): boolean {
	const { requestId: _leftRequestId, ...leftRequest } = left;
	const { requestId: _rightRequestId, ...rightRequest } = right;
	return isDeepStrictEqual(leftRequest, rightRequest);
}

function appliedRangeCompression(ctx: ExtensionCommandContext, operationId: string): CtreeRangeCompactData | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		const details = ctreeRangeCompactData(entry);
		if (details?.operationId === operationId) return structuredClone(details);
	}
	return undefined;
}

function isRangeCompressionContext(value: unknown): value is ExtensionCommandContext {
	if (!value || typeof value !== "object") return false;
	const context = value as Partial<ExtensionCommandContext>;
	return (
		typeof context.sessionManager?.getSessionId === "function" &&
		typeof context.waitForIdle === "function" &&
		typeof context.navigateTree === "function"
	);
}

export function registerRangeCompressionService(pi: ExtensionAPI): void {
	const prepared = new Map<string, StoredRangeCompression>();
	const pending = new Map<string, PendingRangeCompression>();
	const cancelled = new Map<string, string>();
	const mutating = new Set<string>();

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		for (const [key, job] of pending) {
			if (job.request.sessionId !== sessionId) continue;
			job.controller?.abort();
			pending.delete(key);
		}
		for (const [key, value] of prepared) {
			if (value.request.sessionId === sessionId) prepared.delete(key);
		}
		for (const [key, value] of cancelled) {
			if (value === sessionId) cancelled.delete(key);
		}
		mutating.delete(sessionId);
	});

	async function execute(
		request: RangeCompressionRequest,
		ctx: ExtensionCommandContext,
		key: string,
		controller?: AbortController,
	): Promise<RangeCompressionServiceOutcome> {
		if (ctx.sessionManager.getSessionId() !== request.sessionId) {
			return { status: "failed", code: "session_changed" };
		}
		const applied = appliedRangeCompression(ctx, request.operationId);
		if (applied) return { status: "applied", details: applied };

		if (request.action === "cancel") {
			if (mutating.has(request.sessionId)) return { status: "failed", code: "busy" };
			pending.get(key)?.controller?.abort();
			pending.delete(key);
			prepared.delete(key);
			cancelled.set(key, request.sessionId);
			return { status: "cancelled" };
		}
		if (cancelled.has(key)) return { status: "cancelled" };

		const saved = prepared.get(key);
		if (request.action === "status") return { status: saved ? "prepared" : "missing" };

		if (request.action === "prepare") {
			if (saved) {
				return sameRangeCompressionRequest(saved.request, request)
					? { status: "prepared" }
					: { status: "failed", code: "operation_conflict" };
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.model) {
				return { status: "failed", code: "invalid_request" };
			}
			try {
				const value = await prepareRangeCompression(ctx, {
					operationId: request.operationId,
					startEntryId: request.startEntryId,
					endEntryId: request.endEntryId,
					anchorEntryId: request.anchorEntryId,
					instructions: request.instructions,
					signal: controller?.signal,
				});
				if (controller?.signal.aborted || cancelled.has(key)) return { status: "cancelled" };
				const approved = request.review ? await reviewRangeCompression(ctx, value) : value;
				if (controller?.signal.aborted || cancelled.has(key)) return { status: "cancelled" };
				if (!approved) {
					cancelled.set(key, request.sessionId);
					return { status: "cancelled" };
				}
				if (
					ctx.sessionManager.getSessionId() !== request.sessionId ||
					ctx.sessionManager.getLeafId() !== approved.plan.sourceLeafId
				) {
					return { status: "failed", code: "session_changed" };
				}
				prepared.set(key, { request: structuredClone(request), prepared: approved });
				return { status: "prepared" };
			} catch (error) {
				if (controller?.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
					return { status: "cancelled" };
				}
				if (
					error instanceof RangeCompressionSessionChangedError ||
					ctx.sessionManager.getSessionId() !== request.sessionId
				) {
					return { status: "failed", code: "session_changed" };
				}
				return error instanceof InvalidRangeCompressionRequestError
					? { status: "failed", code: "invalid_request" }
					: { status: "failed", code: "compression_failed" };
			}
		}

		if (!saved) return { status: "failed", code: "not_prepared" };
		if (mutating.has(request.sessionId)) return { status: "failed", code: "busy" };
		mutating.add(request.sessionId);
		try {
			const details = await applyPreparedRangeCompression(pi, ctx, saved.prepared);
			if (!details) {
				prepared.delete(key);
				cancelled.set(key, request.sessionId);
				return { status: "cancelled" };
			}
			prepared.delete(key);
			return { status: "applied", details };
		} catch (error) {
			if (
				error instanceof RangeCompressionSessionChangedError ||
				ctx.sessionManager.getSessionId() !== request.sessionId
			) {
				return { status: "failed", code: "session_changed" };
			}
			return error instanceof InvalidRangeCompressionRequestError
				? { status: "failed", code: "invalid_request" }
				: { status: "failed", code: "compression_failed" };
		} finally {
			mutating.delete(request.sessionId);
		}
	}

	pi.events.on(RANGE_COMPRESSION_REQUEST, async (value: unknown) => {
		const transport = value as Partial<RangeCompressionTransport> | undefined;
		if (!transport || !Value.Check(RangeCompressionRequestSchema, transport.request)) return;
		const request = transport.request;
		const key = `${request.sessionId}:${request.operationId}`;
		let outcome: RangeCompressionServiceOutcome;
		try {
			if (!isRangeCompressionContext(transport.context)) {
				outcome = { status: "failed", code: "session_changed" };
			} else {
				const flight = pending.get(key);
				if (flight && request.action !== "cancel") {
					if (sameRangeCompressionRequest(flight.request, request)) {
						outcome = await flight.promise;
					} else if (flight.request.action === "prepare" && request.action === "prepare") {
						outcome = { status: "failed", code: "operation_conflict" };
					} else {
						outcome = { status: "failed", code: "busy" };
					}
				} else {
					const controller = request.action === "prepare" ? new AbortController() : undefined;
					const job: PendingRangeCompression = {
						request,
						controller,
						promise: execute(request, transport.context, key, controller),
					};
					if (request.action !== "cancel") pending.set(key, job);
					try {
						outcome = await job.promise;
					} finally {
						if (pending.get(key) === job) pending.delete(key);
					}
				}
			}
		} catch {
			outcome = { status: "failed", code: "compression_failed" };
		}
		const result = {
			v: 1,
			requestId: request.requestId,
			sessionId: request.sessionId,
			operationId: request.operationId,
			...outcome,
		} satisfies RangeCompressionResult;
		if (Value.Check(RangeCompressionResultSchema, result)) pi.events.emit(RANGE_COMPRESSION_RESULT, result);
	});
}

async function prepareWithLoader(
	ctx: ExtensionCommandContext,
	target: Omit<RangeCompressionTarget, "signal">,
	summaryModel: string,
	preview: RewritePlan,
): Promise<PreparedRangeCompression | undefined> {
	const result = await ctx.ui.custom<ManualPreparationResult>(
		(tui, theme, _keybindings, done) => {
			const rangeDetails = `summary model ${summaryModel} · ${preview.selectedEntryIds.length} selected entries · ~${fmtTokens(preview.selectedEstTokens)} source tokens`;
			const loader = new BorderedLoader(tui, theme, `Drafting range summary · ${rangeDetails}`);
			let finished = false;
			const finish = (value: ManualPreparationResult): void => {
				if (finished) return;
				finished = true;
				done(value);
			};
			loader.onAbort = () => finish({ status: "cancelled" });
			void prepareRangeCompression(ctx, { ...target, signal: loader.signal }).then(
				(prepared) => finish({ status: "prepared", prepared }),
				(error: unknown) =>
					finish(
						loader.signal.aborted
							? { status: "cancelled" }
							: { status: "failed", error: error instanceof Error ? error.message : String(error) },
					),
			);
			return loader;
		},
		{ overlay: false },
	);
	if (result.status === "failed") {
		ctx.ui.notify(`range summary failed: ${result.error} (nothing written)`, "error");
		return undefined;
	}
	if (result.status === "cancelled") {
		ctx.ui.notify("range compression cancelled — nothing written", "info");
		return undefined;
	}
	return result.prepared;
}

export async function rangeCompressHandler(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("range compression selection requires Pi's interactive TUI", "warning");
		return;
	}
	const instructions = args.trim() || undefined;
	await ctx.waitForIdle();
	if (ctx.hasPendingMessages()) {
		ctx.ui.notify("range compression cannot start while messages are pending", "warning");
		return;
	}
	const snapshot = snapshotSession(ctx.sessionManager);
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !ctx.sessionManager.getEntry(sourceLeafId)) {
		ctx.ui.notify("empty session — nothing to compress", "warning");
		return;
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("no current model is available for the range summary", "error");
		return;
	}
	const summaryModel = `${model.provider}/${model.id}`;
	const candidates = rangeCandidates(snapshot);
	const startProjection = buildStartSelectorProjection(ctx, candidates);
	const firstInitialId = startProjection.entryIds.at(-1);
	if (!firstInitialId) {
		ctx.ui.notify("no legal active-context range starts are available", "warning");
		return;
	}

	const firstEntryId = await selectNativeEntry(ctx, "start", startProjection, firstInitialId);
	if (firstEntryId === undefined) return;
	if (!startProjection.entryIds.includes(firstEntryId)) {
		ctx.ui.notify("the selected range start is not available; run /compress again", "warning");
		return;
	}
	if (ctx.sessionManager.getSessionId() !== snapshot.sessionId || ctx.sessionManager.getLeafId() !== sourceLeafId) {
		ctx.ui.notify("the session changed while the range selector was open; run /compress again", "warning");
		return;
	}

	const startCandidateIndex = candidates.findIndex(
		(candidate) => !candidate.protected && candidate.startEntryId === firstEntryId,
	);
	if (startCandidateIndex === -1) {
		ctx.ui.notify("the selected range start is no longer valid; run /compress again", "warning");
		return;
	}
	const endProjection = buildEndSelectorProjection(ctx, candidates, startCandidateIndex);
	const secondInitialId = endProjection.entryIds[0];
	if (!secondInitialId) {
		ctx.ui.notify("no legal range ends are available after the selected start", "warning");
		return;
	}

	const endEntryId = await selectNativeEntry(ctx, "end", endProjection, secondInitialId);
	if (endEntryId === undefined) return;
	if (!endProjection.entryIds.includes(endEntryId)) {
		ctx.ui.notify("the selected range end is not available; run /compress again", "warning");
		return;
	}

	let preview: RewritePlan;
	try {
		const fresh = snapshotSession(ctx.sessionManager);
		if (fresh.sessionId !== snapshot.sessionId || fresh.leafId !== sourceLeafId) {
			throw new Error("the session changed while the range selector was open");
		}
		preview = prepareRewrite(fresh, firstEntryId, endEntryId);
	} catch (error) {
		ctx.ui.notify(`Invalid range: ${(error as Error).message}. Run /compress again.`, "warning");
		return;
	}
	const startEntry = ctx.sessionManager.getEntry(preview.startEntryId);
	const endEntry = ctx.sessionManager.getEntry(preview.endEntryId);
	const startLabel = startEntry
		? (serializeEntry(startEntry)?.split("\n", 1)[0] ?? startEntry.type)
		: preview.startEntryId;
	const endLabel = endEntry ? (serializeEntry(endEntry)?.split("\n", 1)[0] ?? endEntry.type) : preview.endEntryId;
	const confirmed = await ctx.ui.confirm(
		"Compress selected range",
		[
			`Start: ${preview.startEntryId} · ${startLabel}`,
			`End: ${preview.endEntryId} · ${endLabel}`,
			`${preview.selectedEntryIds.length} entries · ~${fmtTokens(preview.selectedEstTokens)} tokens`,
			`Summary model: ${summaryModel}`,
			"The generated summary will open for required review.",
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("range compression cancelled — nothing written", "info");
		return;
	}
	if (
		ctx.sessionManager.getSessionId() !== snapshot.sessionId ||
		ctx.sessionManager.getLeafId() !== sourceLeafId ||
		`${ctx.model?.provider}/${ctx.model?.id}` !== summaryModel
	) {
		ctx.ui.notify("the session or model changed during confirmation; run /compress again", "warning");
		return;
	}

	const operationId = randomUUID();
	const prepared = await prepareWithLoader(
		ctx,
		{
			operationId,
			startEntryId: preview.startEntryId,
			endEntryId: preview.endEntryId,
			anchorEntryId: preview.anchorId,
			instructions,
		},
		summaryModel,
		preview,
	);
	if (!prepared) return;
	const approved = await reviewRangeCompression(ctx, prepared);
	if (!approved) {
		ctx.ui.notify("range compression cancelled during summary review — nothing written", "info");
		return;
	}
	try {
		const details = await applyPreparedRangeCompression(pi, ctx, approved);
		if (!details) {
			ctx.ui.notify("range compression cancelled during navigation — nothing written", "warning");
			return;
		}
		refreshAmbient(ctx);
		ctx.ui.notify(
			`compressed range: selected ~${fmtTokens(details.selectedEstTokens)} · summary ~${fmtTokens(details.summaryEstTokens)} · reclaimed ~${fmtTokens(details.reclaimedEstTokens)} tokens · originals kept at ${details.sourceLeafId}`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`selected range is no longer valid: ${(error as Error).message} (nothing written)`, "warning");
	}
}

export function registerRangeCompress(pi: ExtensionAPI): void {
	pi.registerCommand("compress", {
		description: "pi-context-tree: select, summarize, review, and replace one active-context range",
		handler: (args, ctx) => rangeCompressHandler(pi, ctx, args),
	});
}
