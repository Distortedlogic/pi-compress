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
import { draftRangeSummary, realDraft } from "./extension/draft.ts";
import {
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CompressionRequest,
	type CtreeRangeCompactData,
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	type RangeCompressionFailureCode,
	type RangeCompressionRequest,
	RangeCompressionRequestSchema,
	type RangeCompressionResult,
	RangeCompressionResultSchema,
	type RangeCompressionTransport,
	ctreeRangeCompactData,
} from "./protocol.ts";
import {
	type RangeCandidate,
	type RewritePlan,
	applyRewrite,
	prepareRewrite,
	rangeCandidates,
	revalidateRewrite,
	sourceSha8,
} from "./rewrite.ts";

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

type NormalizedCompressionRequest =
	| { readonly kind: "range"; readonly request: RangeCompressionRequest }
	| { readonly kind: "batch"; readonly request: CompressionRequest };

type NormalizedRangeCompressionRequest = Extract<NormalizedCompressionRequest, { kind: "range" }>;

interface PreparingCompressionOperation {
	readonly phase: "preparing";
	readonly token: symbol;
	readonly request: NormalizedRangeCompressionRequest;
	readonly promise: Promise<RangeCompressionServiceOutcome>;
	readonly controller: AbortController;
}

interface PreparedCompressionOperation {
	readonly phase: "prepared";
	readonly request: NormalizedRangeCompressionRequest;
	readonly prepared: PreparedRangeCompression;
}

interface ApplyingCompressionOperation {
	readonly phase: "applying";
	readonly token: symbol;
	readonly request: NormalizedRangeCompressionRequest;
	readonly promise: Promise<RangeCompressionServiceOutcome>;
}

interface CancelledCompressionOperation {
	readonly phase: "cancelled";
	readonly request: NormalizedRangeCompressionRequest;
}

type CompressionOperationState =
	| PreparingCompressionOperation
	| PreparedCompressionOperation
	| ApplyingCompressionOperation
	| CancelledCompressionOperation;

interface RangeSelectorProjection {
	tree: SessionTreeNode[];
	entryIds: string[];
}

class InvalidRangeCompressionRequestError extends Error {}

class RangeCompressionSessionChangedError extends Error {}

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
	const entryIds = candidates.filter((candidate) => !candidate.protected).map((candidate) => candidate.startEntryId);
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
		entryIds.push(candidate.endEntryId);
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
		validatedPlan = revalidateRewrite(ctx, plan);
	} catch (error) {
		throw new RangeCompressionSessionChangedError(error instanceof Error ? error.message : String(error));
	}
	return {
		plan: validatedPlan,
		summary,
		summaryModel: `${model.provider}/${model.id}`,
		operationId: target.operationId,
	};
}

export async function reviewRangeCompression(
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<PreparedRangeCompression | undefined> {
	const summary = (await ctx.ui.editor("Review selected range summary", prepared.summary))?.trim();
	if (!summary) return undefined;
	return { ...prepared, summary };
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
	const applied = await applyRewrite(pi, ctx, plan, {
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
	return applied ? details : undefined;
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

function normalizeRangeCompressionRequest(request: RangeCompressionRequest): NormalizedRangeCompressionRequest {
	return { kind: "range", request };
}

function compressionOperationKey(request: NormalizedCompressionRequest): string {
	return `${request.kind}:${request.request.sessionId}:${request.request.operationId}`;
}

function comparableCompressionRequest(request: NormalizedCompressionRequest): unknown {
	const { requestId: _requestId, ...value } = request.request;
	return { kind: request.kind, request: value };
}

function sameCompressionRequest(left: NormalizedCompressionRequest, right: NormalizedCompressionRequest): boolean {
	return isDeepStrictEqual(comparableCompressionRequest(left), comparableCompressionRequest(right));
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

class CompressionOperationCoordinator {
	private readonly operations = new Map<string, CompressionOperationState>();

	constructor(private readonly pi: ExtensionAPI) {}

	clearSession(sessionId: string): void {
		for (const [key, state] of this.operations) {
			if (state.request.request.sessionId !== sessionId) continue;
			if (state.phase === "preparing") state.controller.abort();
			this.operations.delete(key);
		}
	}

	async executeRange(
		request: RangeCompressionRequest,
		ctx: ExtensionCommandContext,
	): Promise<RangeCompressionServiceOutcome> {
		if (ctx.sessionManager.getSessionId() !== request.sessionId) {
			return { status: "failed", code: "session_changed" };
		}
		const applied = appliedRangeCompression(ctx, request.operationId);
		if (applied) return { status: "applied", details: applied };

		const normalized = normalizeRangeCompressionRequest(request);
		const key = compressionOperationKey(normalized);
		const state = this.operations.get(key);

		if (request.action === "cancel") {
			if (this.hasApplyingOperation(request.sessionId)) return { status: "failed", code: "busy" };
			if (state?.phase === "preparing") state.controller.abort();
			this.operations.set(key, { phase: "cancelled", request: normalized });
			return { status: "cancelled" };
		}
		if (state?.phase === "cancelled") return { status: "cancelled" };

		if (state?.phase === "preparing" || state?.phase === "applying") {
			if (sameCompressionRequest(state.request, normalized)) return state.promise;
			if (state.phase === "preparing" && state.request.request.action === "prepare" && request.action === "prepare") {
				return { status: "failed", code: "operation_conflict" };
			}
			return { status: "failed", code: "busy" };
		}

		if (request.action === "status") return { status: state?.phase === "prepared" ? "prepared" : "missing" };

		if (request.action === "prepare") {
			if (state?.phase === "prepared") {
				return sameCompressionRequest(state.request, normalized)
					? { status: "prepared" }
					: { status: "failed", code: "operation_conflict" };
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.model) {
				return { status: "failed", code: "invalid_request" };
			}
			return this.startRangePreparation(request, ctx, key);
		}

		if (state?.phase !== "prepared") return { status: "failed", code: "not_prepared" };
		if (this.hasApplyingOperation(request.sessionId)) return { status: "failed", code: "busy" };
		return this.startRangeApply(request, ctx, key, state);
	}

	private hasApplyingOperation(sessionId: string): boolean {
		for (const state of this.operations.values()) {
			if (state.phase === "applying" && state.request.request.sessionId === sessionId) return true;
		}
		return false;
	}

	private isCurrentOperation(key: string, phase: "preparing" | "applying", token: symbol): boolean {
		const state = this.operations.get(key);
		return state?.phase === phase && state.token === token;
	}

	private startRangePreparation(
		request: Extract<RangeCompressionRequest, { action: "prepare" }>,
		ctx: ExtensionCommandContext,
		key: string,
	): Promise<RangeCompressionServiceOutcome> {
		const normalized = normalizeRangeCompressionRequest(request);
		const controller = new AbortController();
		const token = Symbol();
		const promise = (async (): Promise<RangeCompressionServiceOutcome> => {
			await Promise.resolve();
			try {
				const value = await prepareRangeCompression(ctx, {
					operationId: request.operationId,
					startEntryId: request.startEntryId,
					endEntryId: request.endEntryId,
					anchorEntryId: request.anchorEntryId,
					instructions: request.instructions,
					signal: controller.signal,
				});
				if (controller.signal.aborted || !this.isCurrentOperation(key, "preparing", token)) {
					return { status: "cancelled" };
				}
				const approved = request.review ? await reviewRangeCompression(ctx, value) : value;
				if (controller.signal.aborted || !this.isCurrentOperation(key, "preparing", token)) {
					return { status: "cancelled" };
				}
				if (!approved) {
					this.operations.set(key, { phase: "cancelled", request: normalized });
					return { status: "cancelled" };
				}
				if (
					ctx.sessionManager.getSessionId() !== request.sessionId ||
					ctx.sessionManager.getLeafId() !== approved.plan.sourceLeafId
				) {
					this.operations.delete(key);
					return { status: "failed", code: "session_changed" };
				}
				this.operations.set(key, {
					phase: "prepared",
					request: normalizeRangeCompressionRequest(structuredClone(request)),
					prepared: approved,
				});
				return { status: "prepared" };
			} catch (error) {
				const isCurrent = this.isCurrentOperation(key, "preparing", token);
				if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
					if (isCurrent) this.operations.set(key, { phase: "cancelled", request: normalized });
					return { status: "cancelled" };
				}
				if (isCurrent) this.operations.delete(key);
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
		})();
		const preparing: PreparingCompressionOperation = {
			phase: "preparing",
			token,
			request: normalized,
			promise,
			controller,
		};
		this.operations.set(key, preparing);
		return promise;
	}

	private startRangeApply(
		request: Extract<RangeCompressionRequest, { action: "apply" }>,
		ctx: ExtensionCommandContext,
		key: string,
		prepared: PreparedCompressionOperation,
	): Promise<RangeCompressionServiceOutcome> {
		const normalized = normalizeRangeCompressionRequest(request);
		const token = Symbol();
		const promise = (async (): Promise<RangeCompressionServiceOutcome> => {
			await Promise.resolve();
			try {
				const details = await applyPreparedRangeCompression(this.pi, ctx, prepared.prepared);
				if (!details) {
					if (this.isCurrentOperation(key, "applying", token)) {
						this.operations.set(key, { phase: "cancelled", request: normalized });
					}
					return { status: "cancelled" };
				}
				if (this.isCurrentOperation(key, "applying", token)) this.operations.delete(key);
				return { status: "applied", details };
			} catch (error) {
				if (this.isCurrentOperation(key, "applying", token)) this.operations.set(key, prepared);
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
		})();
		const applying: ApplyingCompressionOperation = { phase: "applying", token, request: normalized, promise };
		this.operations.set(key, applying);
		return promise;
	}
}

export function registerRangeCompressionService(pi: ExtensionAPI): void {
	const coordinator = new CompressionOperationCoordinator(pi);

	pi.on("session_shutdown", (_event, ctx) => {
		coordinator.clearSession(ctx.sessionManager.getSessionId());
	});

	pi.events.on(RANGE_COMPRESSION_REQUEST, async (value: unknown) => {
		const transport = value as Partial<RangeCompressionTransport> | undefined;
		if (!transport || !Value.Check(RangeCompressionRequestSchema, transport.request)) return;
		const request = transport.request;
		let outcome: RangeCompressionServiceOutcome;
		try {
			outcome = isRangeCompressionContext(transport.context)
				? await coordinator.executeRange(request, transport.context)
				: { status: "failed", code: "session_changed" };
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
