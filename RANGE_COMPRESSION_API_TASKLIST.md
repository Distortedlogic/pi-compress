# Range Compression API Task List

## Fixed outcomes

- Put all existing tests in the root `tests/` directory.
- Keep one range-compression implementation for `/compress`, batch compression, direct callers, and event-bus callers.
- Use Pi public APIs for session access, model calls, tree navigation, TUI selection, loading UI, and context usage.
- Show only the active, compressible path in the manual range selectors.
- Keep all session changes append-only.
- Keep the existing `ctree/*` durable names and batch protocol names compatible.
- Require `ExtensionCommandContext` for every operation that can navigate the session tree.
- Review manual `/compress` summaries by default. Require automated callers to set `review: false` explicitly.
- Do not import Pi private source paths or modify Pi session JSONL files directly.

## Work unit 1 — Move and establish the test suite

- [x] Run `npm test`, `npm run check`, and `npm run knip` before source changes. Record any existing failure.
- [x] Create the root `tests/` directory.
- [x] Move `src/__tests__/compression.test.ts` to `tests/compression.test.ts`.
- [x] Move `src/__tests__/extension.test.ts` to `tests/extension.test.ts`.
- [x] Move `src/__tests__/protocol.test.ts` to `tests/protocol.test.ts`.
- [x] Change test imports from `../...` to `../src/...`.
- [x] Change `tsconfig.json` `include` to `['src/**/*.ts', 'tests/**/*.ts']`.
- [x] Change the Knip entry pattern in `package.json` to `tests/**/*.test.ts`.
- [x] Remove `!src/**/*.test.ts` and `!src/__tests__/**` from `package.json` because tests no longer exist under `src`.
- [x] Run the three validation commands again before range-compression refactoring.

**Completion gate:** The moved suite has the same results as the baseline, TypeScript checks the tests, and `src/__tests__` no longer exists.

## Work unit 2 — Extract the shared range-rewrite core

- [x] Create `src/core/range-rewrite.ts` for the actual shared rewrite implementation.
- [x] Move `RangeCandidate`, `RewritePlan`, `PrepareRewriteOptions`, `RewriteOutput`, and `ApplyRewriteResult` into this module.
- [x] Move `rangeCandidates`, `candidateByEntryId`, `resolveRangeEndpoint`, `prepareRewrite`, `revalidateRewrite`, `applyRewrite`, and `sourceSha8` into this module.
- [x] Keep source hashing, source-leaf checks, session-ID checks, selected-ID checks, continuation-ID checks, and final revalidation in this module.
- [x] Make complete assistant tool calls and their contiguous tool results one atomic candidate.
- [x] Mark all context-inert session metadata as protected boundaries. This includes `custom`, `model_change`, `thinking_level_change`, `label`, and `session_info` entries.
- [x] Keep compaction entries, branch summaries, decision records, incomplete user turns, incomplete tool groups, orphan tool results, and entries without a preceding anchor protected.
- [x] Make a selected range invalid when it starts, ends, or crosses a protected candidate.
- [x] Update crop planning and batch planning to import this core instead of keeping range safety in `src/compression.ts`.
- [x] Leave crop-specific planning and rendering in `src/compression.ts`.

**Completion gate:** Crop, manual range compression, and batch compression use the same candidate, plan, hash, revalidation, and append-only apply code.

## Work unit 3 — Remove local replacements for Pi public APIs

- [x] Remove `src/core/types.ts`.
- [x] Import `SessionEntry`, `SessionMessageEntry`, and other session types directly from `@earendil-works/pi-coding-agent`.
- [x] Use the `type` discriminant directly for message and custom-message narrowing.
- [x] Remove `textOfContent` from `src/core/serialize.ts`.
- [x] Call Pi AI `contentText(content, '\n')` directly at each text extraction site.
- [x] Keep `snapshotSession` because it creates one immutable view from Pi's read-only session APIs.
- [x] Use `ctx.getContextUsage()` for the canonical total context value.
- [x] Keep local per-entry estimates only for range previews, crop previews, and consumer attribution because Pi does not expose a public per-entry estimator.
- [x] Replace checks for the existence of `ctx.ui.custom` with `ctx.mode === 'tui'` checks.
- [x] Keep all Pi imports on documented package entry points.

**Completion gate:** The extension has no thin type or text wrappers and no local implementation of behavior that Pi exposes publicly.

## Work unit 4 — Build the active-range selector projection

- [x] Build selector input from `ctx.sessionManager.buildContextEntries()`.
- [x] Index labels and entry data from `ctx.sessionManager.getTree()`.
- [x] Build a temporary linear `SessionTreeNode[]` projection in active-context order.
- [x] Do not call `branch()`, `navigateTree()`, `appendEntry()`, or `sendMessage()` while either selector is open.
- [x] For the first selector, include one node for each legal range start and use its atomic candidate `startEntryId`.
- [x] After start selection, find its candidate index.
- [x] For the second selector, include one node for each legal end from the selected start through the candidate before the first protected boundary.
- [x] Use each end candidate's `endEntryId` in the second selector.
- [x] Exclude inactive branches, pre-compaction entries outside active context, protected entries, and entries that cannot produce a valid endpoint.
- [x] Use Pi's `TreeSelectorComponent` to render both projections.
- [x] Preserve native labels in the temporary nodes.
- [x] Rebuild and validate the `RewritePlan` after the second selection.

**Completion gate:** Every node shown by either selector is valid for that phase, and the selectors never show inactive branches.

## Work unit 5 — Implement the reusable direct API

- [x] Create `src/range-compression.ts` as the real high-level range-compression implementation.
- [x] Define and export `RangeCompressionTarget` with these fields: `operationId`, `startEntryId`, `endEntryId`, optional `anchorEntryId`, optional `instructions`, and optional `signal`.
- [x] Define and export `RangeCompressionInput` as `RangeCompressionTarget` plus the required `review` boolean.
- [x] Define and export `PreparedRangeCompression` with the immutable rewrite plan, current summary text, summary model, and operation ID.
- [x] Define and export `RangeCompressionOutcome` as `{ status: 'applied'; details: CtreeRangeCompactData } | { status: 'cancelled' }`.
- [x] Implement and export `prepareRangeCompression(ctx, target): Promise<PreparedRangeCompression>`.
- [x] Make `prepareRangeCompression` wait for idle state and reject pending messages, a changed session, an invalid range, and a missing current model.
- [x] Draft with the current model through `ctx.modelRegistry.complete()`.
- [x] Pass the supplied abort signal to the model call.
- [x] Implement and export `reviewRangeCompression(ctx, prepared): Promise<PreparedRangeCompression | undefined>`.
- [x] Make `reviewRangeCompression` return an updated immutable value after approval and `undefined` when the editor closes or returns empty text.
- [x] Implement and export `applyPreparedRangeCompression(pi, ctx, prepared): Promise<CtreeRangeCompactData | undefined>`.
- [x] Revalidate immediately before navigation and return `undefined` when navigation is cancelled.
- [x] Apply the standard range summary as `CTREE_RANGE_TAIL`, then append `CTREE_RANGE_COMPACT`.
- [x] Include `operationId` in `CtreeRangeCompactData` as an optional backward-compatible stored field.
- [x] Implement and export `compressRange(pi, ctx, input)` as the complete orchestration, not as a forwarding wrapper.
- [x] Make `compressRange` prepare, conditionally review, and apply in that order.
- [x] Return `{ status: 'cancelled' }` without writes after review or navigation cancellation. Return `{ status: 'applied', details }` after success.

**Completion gate:** Another extension can import one function and perform safe automated range compression with `review: false`.

## Work unit 6 — Rebuild the manual `/compress` flow on the shared API

- [ ] Move `registerRangeCompress` and the manual range UI from `src/compression.ts` to `src/range-compression.ts`.
- [ ] Require TUI mode before opening the range selectors.
- [ ] Select the start and end through the filtered native projections from work unit 4.
- [ ] Show one confirmation with the normalized start, normalized end, entry count, estimated source tokens, and current summary model.
- [ ] Generate the operation UUID before drafting.
- [ ] Use Pi's `BorderedLoader` only while `prepareRangeCompression` drafts the summary.
- [ ] Pass the loader signal to `prepareRangeCompression` and close the loader when preparation settles.
- [ ] Call `reviewRangeCompression` after the loader closes.
- [ ] Keep this editor review mandatory for `/compress`.
- [ ] Call `applyPreparedRangeCompression` only after the editor returns non-empty approved text.
- [ ] Do not copy logic from the public phase functions into the command handler.
- [ ] Refresh the ambient context display after success.
- [ ] Report cancellation without writing a tail or marker.

**Completion gate:** `/compress` shows only legal active-path choices, reviews the summary, and uses the same engine as automated callers.

## Work unit 7 — Add the generic inter-extension protocol

- [ ] Add `RANGE_COMPRESSION_REQUEST = 'pi-context-compress/v1/range/request'` to `src/protocol.ts`.
- [ ] Add `RANGE_COMPRESSION_RESULT = 'pi-context-compress/v1/range/result'` to `src/protocol.ts`.
- [ ] Add an exact TypeBox `RangeCompressionRequestSchema` as a discriminated union.
- [ ] Define `prepare` requests with required `requestId`, `sessionId`, `operationId`, `startEntryId`, `endEntryId`, and `review`; allow only optional `anchorEntryId` and `instructions` in addition.
- [ ] Define exact `apply`, `cancel`, and `status` requests with required `requestId`, `sessionId`, and `operationId`.
- [ ] Add an exact `RangeCompressionResultSchema` with statuses `prepared`, `applied`, `cancelled`, `missing`, and `failed`.
- [ ] Use failure codes `invalid_request`, `operation_conflict`, `session_changed`, `compression_failed`, `not_prepared`, and `busy`.
- [ ] Include `CtreeRangeCompactData` only on an applied result.
- [ ] Export all request, result, status, code, and transport types through `./protocol`.
- [ ] Define the in-process transport as `{ request, context }`, where `context` is an `ExtensionCommandContext` and is not part of the serializable schema.
- [ ] Implement `registerRangeCompressionService(pi)` in `src/range-compression.ts`.
- [ ] Key prepared work by `sessionId:operationId`.
- [ ] Compare repeat requests without `requestId` and return `operation_conflict` for different data under the same operation key.
- [ ] Return the prior outcome for an identical in-flight request.
- [ ] Keep one mutation lock per session and return `busy` for concurrent mutation.
- [ ] Keep one `AbortController` per pending preparation and abort it on `cancel` or `session_shutdown`.
- [ ] Remove prepared and pending state during `session_shutdown`.
- [ ] Emit exactly one validated result for each validated request.
- [ ] Register the service from `src/index.ts`.

**Completion gate:** A separately loaded extension can prepare, inspect status, apply, cancel, and correlate automated compression through `pi.events` without private Pi access.

## Work unit 8 — Preserve the batch compatibility adapter

- [ ] Keep `COMPRESSION_REQUEST`, `COMPRESSION_RESULT`, `COMPRESSION_ENTRY`, `QUEUED_TASK_TAIL`, `COMPRESSION_TAIL`, and `LEGACY_COMPRESSION_ENTRY` unchanged.
- [ ] Keep `CompressionRequestSchema`, `CompressionResultSchema`, and `CompressionDetailsSchema` compatible.
- [ ] Change `src/batch.ts` to import range planning, drafting, revalidation, and application from the shared range modules.
- [ ] Keep batch-specific queued-task discovery, batch revision data, two-tail output, and marker details in `src/batch.ts`.
- [ ] Remove every duplicate range-safety rule from `src/batch.ts`.
- [ ] Keep prepare, status, apply, replay, cancel, conflict, busy, and session-change behavior unchanged.

**Completion gate:** Existing batch callers require no changes and execute through the same range core as `/compress` and the generic API.

## Work unit 9 — Publish and document the capability

- [ ] Add `"./range-compression": "./src/range-compression.ts"` to `package.json` exports.
- [ ] Keep `".": "./src/index.ts"` and `"./protocol": "./src/protocol.ts"` unchanged.
- [ ] Confirm that the `files` list packages `src/range-compression.ts` and excludes root tests.
- [ ] Update `README.md` with the manual `/compress` sequence and append-only recovery behavior.
- [ ] Add a direct API example that imports `compressRange` from `pi-context-compress/range-compression` and passes `review: false`.
- [ ] Update `PROTOCOL.md` with the generic request and result channels.
- [ ] Add an event-bus example that subscribes to the result channel before it emits `{ request, context: ctx }`.
- [ ] State that event transport is in-process and that tree mutation requires a command context.
- [ ] State that normal event handlers must queue or invoke their own command before they can supply a command context.
- [ ] Document operation idempotency, cancellation, protected boundaries, final revalidation, and error codes.
- [ ] State that Pi's native `ctx.compact()` remains whole-context compaction and is not used for selected-range compression.

**Completion gate:** Package users can find and use both supported integration paths without reading source code.

## Work unit 10 — Extend the existing tests

- [ ] Update `tests/compression.test.ts` for the extracted module imports.
- [ ] Add cases to `tests/compression.test.ts` for every protected metadata and structural boundary.
- [ ] Add a case that proves the first selector contains only legal starts.
- [ ] Add cases that prove the second selector contains only legal ends for the chosen start and stops before the first protected boundary.
- [ ] Add a branched-session case that proves inactive branches are absent from both selector projections.
- [ ] Keep tests for complete parallel tool-call groups, continuation order, source hashes, stale plans, and append-only recovery.
- [ ] Add direct API cases for reviewed success, automated success, review cancellation, empty summary, abort, stale leaf, changed session, pending messages, and model failure.
- [ ] Update `tests/protocol.test.ts` with exact generic request and result schema cases.
- [ ] Add generic service cases for prepare, status, apply, replay, cancel, missing, conflict, busy, and session shutdown.
- [ ] Update `tests/extension.test.ts` to check generic service registration and the `./range-compression` package export.
- [ ] Keep the existing RPC extension-load test.
- [ ] Do not create another test suite file.

**Completion gate:** Existing behavior stays covered, and each new public contract has success, cancellation, conflict, and stale-state coverage.

## Work unit 11 — Final cleanup and validation

- [ ] Remove dead imports, obsolete range code, stale comments, and old source-test paths.
- [ ] Confirm that no manual compression path can write before summary approval.
- [ ] Confirm that no automated path defaults silently to no review.
- [ ] Confirm that all rewrite paths call `ctx.navigateTree(..., { summarize: false })` and never edit session files.
- [ ] Confirm that all external payloads pass TypeBox validation before use and before emission.
- [ ] Run `npm run format`.
- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `npm run knip`.
- [ ] Run `npm pack --dry-run` and confirm that `tests/` is absent and all three public entry points are present.
- [ ] Review `git diff --check` and the final diff.
- [ ] Commit only the completed implementation with a minimal, accurate message.

**Final acceptance:** All validation commands pass. Manual and automated range compression share one implementation. Manual selection shows only legal entries on the active context path. Other extensions can use the direct package API or the generic Pi event protocol.