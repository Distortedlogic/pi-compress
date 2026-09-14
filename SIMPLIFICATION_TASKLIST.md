# Pi Context Compress Simplification Task List

## Objective

Reduce the extension from 13 source files to about 10 source files. Remove duplicate service logic, circular imports, dead data, unnecessary copies, and stale design layers. Keep all current commands, protocols, stored-session compatibility, review steps, recovery behavior, and TUI functions.

## Required invariants

Do not start a work unit until its dependencies and acceptance gates are complete.

- [ ] Keep these package exports working:
  - `.` → `src/index.ts`
  - `./protocol` → `src/protocol.ts`
  - `./range-compression` → `src/range-compression.ts`
- [ ] Keep the existing named exports from `src/range-compression.ts`, or re-export them from that file after an internal move.
- [ ] Keep these commands and their behavior:
  - `/branch`
  - `/merge`
  - `/crop`
  - `/compress`
  - `/panel`
  - `/decisions`
  - `/undo`
- [ ] Keep `Ctrl+Q` as the panel shortcut.
- [ ] Keep all current event channels:
  - `pi-context-compress/v1/range/request`
  - `pi-context-compress/v1/range/result`
  - `pi-context-compress/v1/request`
  - `pi-context-compress/v1/result`
- [ ] Keep stored custom-type identifiers, including all `ctree/*`, `pi-context-compress/*`, and `pi-workstream/compression` values.
- [ ] Keep all protocol and details version values.
- [ ] Keep append-only mutation. Never delete or rewrite source session entries.
- [ ] Keep original source ranges recoverable at their old leaves.
- [ ] Keep source hash and session-leaf revalidation before every apply operation.
- [ ] Keep assistant tool-call groups and their tool results atomic.
- [ ] Keep decision records, structural summaries, metadata, incomplete turns, and unsafe tool-result groups protected from range selection.
- [ ] Keep required human review for interactive range compression and the current review option for protocol requests.
- [ ] Keep idempotent prepare, status, apply, and cancel behavior.
- [ ] Keep current failure codes and their meanings.
- [ ] Keep model restoration after branch merge or discard.
- [ ] Keep non-TUI behavior for commands that currently support it.
- [ ] Keep existing old-session parsing behavior.

## Target source layout

```text
src/
├── index.ts
├── protocol.ts
├── context.ts
├── rewrite.ts
├── draft.ts
├── ambient.ts
├── branches.ts
├── crop.ts
├── panel.ts
└── range-compression.ts
```

Target responsibilities:

- `index.ts`: Extension registration only.
- `protocol.ts`: Public channels, stored-data schemas, wire schemas, and parsing helpers.
- `context.ts`: Read-only session snapshots, fork projections, token estimates, serialization, and consumer totals.
- `rewrite.ts`: Safe range candidates, rewrite plans, revalidation, and append-only apply logic.
- `draft.ts`: Model lookup and nested model calls for decisions and summaries.
- `ambient.ts`: Context gauge, status, title, trend, and warning state.
- `branches.ts`: Branch, merge, decision, export, model completion, and undo commands.
- `crop.ts`: Crop candidates, crop plans, reconstruction, and crop application.
- `panel.ts`: TUI components and panel-related command orchestration.
- `range-compression.ts`: Manual range compression, the shared operation coordinator, and both protocol adapters.

Expected dependency direction:

```text
protocol
   ↓
context
   ↓
rewrite

ambient → context
draft   → external Pi APIs
branches → protocol, context, draft, ambient
crop     → protocol, context, rewrite, ambient
panel    → context, branches, crop, ambient
range-compression → protocol, context, rewrite, draft, ambient
index    → registration modules
```

No module below `index.ts` may import `index.ts`. `ambient.ts` must not import `branches.ts`, `crop.ts`, `panel.ts`, or `range-compression.ts`.

---

## WU-00 — Record the baseline and public surface

**Depends on:** None

**Files:** `package.json`, existing tests, current source files

- [ ] Run `npm test`, `npm run check`, and `npm run knip` before source changes.
- [ ] Record all baseline failures. Do not hide a baseline failure by changing an unrelated test.
- [ ] Record the current command names, descriptions, shortcut, event channels, package exports, and stored custom-type values.
- [ ] Record all named exports from `src/protocol.ts` and `src/range-compression.ts`.
- [ ] Record representative valid and invalid values for each public TypeBox wire schema.
- [ ] Record representative stored entries for these parsers:
  - `ctreeForkData()`
  - `ctreeCloseData()`
  - `ctreeCropData()`
  - `ctreeDecisionDetails()`
  - `ctreeRangeCompactData()`
  - `compressionDetails()`
  - `compressionTailDetails()`
- [ ] Correct the Knip entry list after the first baseline run:

```json
"entry": [
  "src/index.ts",
  "src/protocol.ts",
  "src/range-compression.ts",
  "tests/**/*.test.ts"
]
```

- [ ] Run Knip again and save its new result as the valid pruning baseline.

### Acceptance gate

- [ ] Baseline results are known.
- [ ] Public exports and compatibility identifiers are listed in an existing test or review checklist.
- [ ] Knip recognizes the extension and package entry points.
- [ ] No implementation behavior changed.

---

## WU-01 — Lock behavior with existing tests

**Depends on:** WU-00

**Files:** Existing test files only

Add cases to the current test suites. Do not create a second test harness.

- [x] Lock range-candidate protection for:
  - Root entries with no anchor.
  - Incomplete user turns.
  - Complete assistant tool-call groups.
  - Incomplete or mismatched tool-call groups.
  - Standalone tool results.
  - Decision records.
  - Branch summaries and compaction summaries.
  - Context-inert metadata.
- [x] Lock rewrite planning for selected IDs, continuation IDs, source serialization, token estimates, and source hashes.
- [x] Lock rewrite revalidation for session changes, leaf changes, missing anchors, selected-source changes, and continuation changes.
- [x] Lock append-only apply behavior and cancelled navigation behavior.
- [x] Lock normal range protocol behavior:
  - Prepare.
  - Duplicate prepare with a different `requestId`.
  - Conflicting prepare.
  - Status before and after preparation.
  - Apply before prepare.
  - Apply after prepare.
  - Repeated apply after the marker exists.
  - Cancel while absent, preparing, prepared, and applying.
  - Busy and session-change results.
- [x] Lock batch protocol behavior for the same state transitions.
- [x] Lock the distinct output entries for normal range compression and batch compression.
- [x] Lock parsing of legacy `pi-workstream/compression` entries.
- [x] Lock `/compress` review requirements and non-TUI rejection.
- [x] Lock `/crop` protected-result override behavior.
- [x] Lock `Ctrl+Q` panel opening behavior.

### Acceptance gate

- [x] All baseline behavior has test coverage in the existing suites.
- [x] `npm test` passes, apart from a previously recorded baseline failure.
- [x] No production source changed in this work unit.

---

## WU-02 — Remove the draft and branch import cycle

**Depends on:** WU-01

**Files:** `src/branches.ts`, `src/extension/draft.ts`, `src/index.ts`, related existing tests

- [ ] Move `modelKey()` and `resolveModel()` from `branches.ts` to the draft module.
- [ ] Import `Model` directly from `@earendil-works/pi-ai` in the draft module.
- [ ] Delete the `ModelLike` alias.
- [ ] Change `branches.ts` to import model helpers from the draft module.
- [ ] Confirm that the draft module no longer imports `branches.ts`.
- [ ] Replace the one-field `Deps` interface with direct `DraftFn` parameters.
- [ ] Change `registerMerge()`, `mergeHandler()`, `registerPanel()`, and panel execution code to receive `DraftFn` directly.
- [ ] Delete `const deps: Deps = { draft: realDraft }` from `index.ts`.
- [ ] Replace manual response block filtering in `realDraft()` with `contentText(response.content, "\n")`.
- [ ] Use `ctx.model.contextWindow` directly in the range-size check.
- [ ] Keep the explicit invalid or zero context-window error.

### Acceptance gate

- [ ] There is no `branches.ts` ↔ draft-module cycle.
- [ ] Fake draft functions still work in existing tests.
- [ ] Decision and range prompts are unchanged.
- [ ] `npm test` and `npm run check` pass.

---

## WU-03 — Consolidate read-only context analysis

**Depends on:** WU-02

**Files:** `src/session.ts`, `src/core/estimate.ts`, `src/core/serialize.ts`, `src/core/consumers.ts`, `src/branches.ts`, consumers of those modules

- [ ] Create `src/context.ts`.
- [ ] Move session snapshot types and functions from `src/session.ts` into `src/context.ts`.
- [ ] Move token estimation and gauge band functions from `src/core/estimate.ts` into `src/context.ts`.
- [ ] Move entry serialization from `src/core/serialize.ts` into `src/context.ts`.
- [ ] Move consumer aggregation from `src/core/consumers.ts` into `src/context.ts`.
- [ ] Move these read-only branch projections from `branches.ts` into `context.ts`:
  - `ForkStatus`
  - `ForkInfo`
  - `SessionState`
  - `extractForks()`
  - `nearestOpenFork()`
  - `decisionsOnPath()`
  - `deriveState()`
- [ ] Reduce `ForkInfo` to the fields used by runtime behavior:

```ts
interface ForkInfo {
  entryId: string;
  data: CtreeForkData;
  status: ForkStatus;
}
```

- [ ] Delete `ForkPresentation`.
- [ ] Delete the unused `entry`, `close`, `presentation`, `onCurrentPath`, and `depth` calculations.
- [ ] Replace deep clones in `snapshotSession()` with the arrays and defensive tree returned by `ReadonlySessionManager`.
- [ ] Keep rewrite safety through copied ID arrays, serialized source, the source hash, session ID checks, and leaf checks.
- [ ] Update all source and existing test imports in one change.
- [ ] Delete these old files after all imports move:
  - `src/session.ts`
  - `src/core/estimate.ts`
  - `src/core/serialize.ts`
  - `src/core/consumers.ts`
- [ ] Remove `src/core/` only after `range-rewrite.ts` moves in WU-06.

### Acceptance gate

- [ ] Context snapshots do not deep-copy large message and tool-result bodies.
- [ ] Fork status, current-fork selection, token estimates, serialization, and consumer totals are unchanged.
- [ ] No deleted module remains in an import.
- [ ] `npm test`, `npm run check`, and `npm run knip` pass.

---

## WU-04 — Extract ambient UI state and remove panel cycles

**Depends on:** WU-03

**Files:** `src/panel.ts`, `src/branches.ts`, `src/compression.ts`, `src/range-compression.ts`, new `src/ambient.ts`

- [ ] Create `src/ambient.ts`.
- [ ] Move these items from `panel.ts` to `ambient.ts`:
  - Gauge input type.
  - Gauge band styling.
  - `renderGauge()`.
  - Ambient trend state.
  - `resetAmbient()`.
  - `trendMarker()`.
  - `nudgeOnRed()`.
  - `refreshAmbient()`.
  - `registerAmbient()`.
- [ ] Make `ambient.ts` read fork state from `context.ts`, not from `branches.ts`.
- [ ] Remove the unused `ExtensionAPI` parameter from `refreshAmbient()`.
- [ ] Update all calls to use `refreshAmbient(ctx)`.
- [ ] Reset `warnedRed` in `resetAmbient()`.
- [ ] Remove the dead estimated-versus-exact trend state:
  - Delete `lastEstimated`.
  - Delete the `estimated` argument from `trendMarker()`.
  - Delete known-token label branches that can never receive estimated tokens.
- [ ] Keep the unknown post-compaction display when context tokens are `null`.
- [ ] Make `panel.ts` import `renderGauge()` from `ambient.ts`.
- [ ] Make branch, crop, and range modules import `refreshAmbient()` from `ambient.ts`.
- [ ] Confirm that `ambient.ts` imports no mutation or panel module.

### Acceptance gate

- [ ] `branches.ts` no longer imports `panel.ts`.
- [ ] `range-compression.ts` no longer imports ambient functions from `panel.ts`.
- [ ] Gauge labels, warning thresholds, footer status, and title behavior remain available.
- [ ] A new session can show the red warning again because all ambient state resets.
- [ ] `npm test` and `npm run check` pass.

---

## WU-05 — Establish a one-way crop and panel boundary

**Depends on:** WU-04

**Files:** `src/compression.ts`, `src/panel.ts`, `src/index.ts`, related existing tests

- [ ] Rename `src/compression.ts` to `src/crop.ts` with Git-aware file movement.
- [ ] Keep these domain operations in `crop.ts`:
  - Candidate discovery.
  - Automatic selection.
  - Crop planning.
  - Whole-turn planning.
  - Reconstruction rendering.
  - Crop rewrite application.
- [ ] Move command and panel orchestration to `panel.ts`:
  - Crop argument parsing.
  - Dry-run notification.
  - `/crop` command handler.
  - `/crop` command registration.
  - Dynamic panel opening.
- [ ] Remove the dynamic `import("./panel.ts")` call.
- [ ] Make `panel.ts` import crop domain operations from `crop.ts`.
- [ ] Confirm that `crop.ts` does not import `panel.ts`.
- [ ] Update `index.ts` to import crop registration from its new owner.
- [ ] Preserve all `/crop` flag behavior:
  - `--top`
  - `--auto`
  - `--apply`
  - `--dry-run`
  - `--min-tokens`
  - `--older-than`
  - `--keep`

### Acceptance gate

- [ ] There is no `crop.ts` ↔ `panel.ts` cycle.
- [ ] `/crop` has the same argument and review behavior.
- [ ] Crop planning can run without importing TUI orchestration.
- [ ] `npm test` and `npm run check` pass.

---

## WU-06 — Reduce and stabilize the rewrite core

**Depends on:** WU-03, WU-05

**Files:** `src/core/range-rewrite.ts`, new `src/rewrite.ts`, `src/crop.ts`, `src/range-compression.ts`, `src/batch.ts`, related existing tests

- [ ] Move `src/core/range-rewrite.ts` to `src/rewrite.ts`.
- [ ] Delete `src/core/` after no files remain in it.
- [ ] Remove these unused or duplicate `RangeCandidate` fields:
  - `id`
  - `selectable`
  - `estTokens`
- [ ] Use `startEntryId` in protected-range error messages.
- [ ] Delete `RangeEndpointResult` and `resolveRangeEndpoint()`.
- [ ] Build selector projections directly from unprotected candidate `startEntryId` and `endEntryId` values.
- [ ] Remove `continuationEntries` from `RewritePlan`.
- [ ] Keep `continuationEntryIds` and `continuationSerialized`.
- [ ] Delete `immutablePlan()` from range compression.
- [ ] Keep compile-time read-only plan fields and runtime revalidation.
- [ ] Change `applyRewrite()` to return `Promise<boolean>`.
- [ ] Delete `ApplyRewriteResult`.
- [ ] Update all callers to test the returned Boolean.
- [ ] Remove `CropPlan.marked` and its assignments.
- [ ] Add one crop-specific helper for shared marked-range boundary setup used by `planCrop()` and `planRemoveTurns()`.
- [ ] Do not create a general selection framework.
- [ ] Inline the thin `branch(ctx)` and `isAssistantMessage()` helpers in batch preparation.

### Acceptance gate

- [ ] Rewrite plans contain only data used by apply, revalidation, protocol details, summary drafting, or crop reconstruction.
- [ ] Tool-call atomicity and all protected-entry rules remain unchanged.
- [ ] All apply callers handle cancelled navigation correctly.
- [ ] Source and continuation change tests still fail safely.
- [ ] `npm test`, `npm run check`, and `npm run knip` pass.

---

## WU-07 — Deduplicate protocol schemas without changing the wire format

**Depends on:** WU-01

**Files:** `src/protocol.ts`, related existing tests

- [ ] Define one shared compression status schema for:
  - `prepared`
  - `applied`
  - `cancelled`
  - `missing`
  - `failed`
- [ ] Define one shared compression failure-code schema for:
  - `invalid_request`
  - `operation_conflict`
  - `session_changed`
  - `compression_failed`
  - `not_prepared`
  - `busy`
- [ ] Reuse these schemas in both range and batch result schemas.
- [ ] Define a shared property object for `v`, `requestId`, `sessionId`, and `operationId`.
- [ ] Use object spread to build request and result variants.
- [ ] Keep each wire schema `additionalProperties: false`.
- [ ] Remove the `stored` constant and omit `additionalProperties: true` from stored-entry schemas.
- [ ] Confirm that stored schemas still accept forward-compatible additional properties.
- [ ] Keep all exported schema, type, parser, and constant names.
- [ ] Keep status-specific required fields in the range result union.
- [ ] Do not weaken validation of required `details` or `code` fields.

### Acceptance gate

- [ ] Previously valid wire messages remain valid.
- [ ] Previously invalid extra wire fields remain invalid.
- [ ] Stored entries with unknown future fields remain valid.
- [ ] All public protocol exports remain available.
- [ ] `npm test`, `npm run check`, and `npm run knip` pass.

---

## WU-08 — Simplify panel execution and state

**Depends on:** WU-04, WU-05

**Files:** `src/panel.ts`, related existing tests

- [ ] Change `buildPanelInput(pi, ctx, ...)` to `buildPanelInput(ctx, ...)`.
- [ ] Read the session name from `ctx.sessionManager.getSessionName()`.
- [ ] Change `openPanel(pi, ctx, ...)` to `openPanel(ctx, ...)`.
- [ ] Dispatch `/panel` from the `Ctrl+Q` shortcut with:

```ts
pi.sendUserMessage("/panel", { expandPromptTemplates: true });
```

- [ ] Confirm that Pi handles the extension command without starting an LLM turn.
- [ ] Remove the shortcut-only read-only panel path.
- [ ] Delete:
  - `PanelInput.readOnly`
  - `PanelOpenOptions.readOnly`
  - `PanelHeader.readOnly`
  - `deny()`
  - Read-only guards and labels.
  - `isCommandContext()`.
  - The warning that asks the user to reopen `/panel`.
- [ ] Remove `PanelHeader` and `panelHeader()`.
- [ ] Compute the required project, session, branch, model, token, and window values directly in `render()`.
- [ ] Remove unused `pct`, `band`, and `estimated` header values.
- [ ] Use Pi's `getSettingsListTheme()` instead of the custom `settingsTheme()` function.
- [ ] Keep the custom selection theme unless the installed Pi API provides an equivalent public helper.
- [ ] Replace the 50-iteration panel loop with a loop that ends only on close or no action.
- [ ] Keep `PanelController` during the behavior changes.
- [ ] After tests pass, fold `PanelController` into `ContextPanel` only if the final diff removes code without making `ContextPanel` methods less clear. Otherwise, make `PanelController` internal and keep it.
- [ ] Keep native `TreeSelectorComponent`, `SettingsList`, `SelectList`, `BorderedLoader`, and `Markdown` use.

### Acceptance gate

- [ ] Ctrl+Q opens a fully actionable panel.
- [ ] Ctrl+Q does not submit a model prompt.
- [ ] All panel views and actions remain available.
- [ ] The panel has no arbitrary action limit.
- [ ] No read-only-only code remains unless another actual package entry uses it.
- [ ] `npm test`, `npm run check`, and `npm run knip` pass.

---

## WU-09 — Build one compression operation coordinator

**Depends on:** WU-06, WU-07

**Files:** `src/range-compression.ts`, `src/batch.ts`, related existing tests

Build one domain-specific coordinator. Do not build a reusable workflow framework.

- [ ] Define a normalized internal request with a `kind` of `range` or `batch`.
- [ ] Include `kind` in the operation key so equal session and operation IDs from different protocols cannot collide.
- [ ] Replace separate prepared, pending, cancelled, and mutating collections with one discriminated operation-state map.
- [ ] Support these states:
  - Absent.
  - Preparing with request, promise, and `AbortController`.
  - Prepared with request and prepared value.
  - Applying with request and promise.
  - Cancelled.
- [ ] Use the session marker as the source of truth for an already applied operation.
- [ ] Compare duplicate requests after removal of `requestId` only.
- [ ] Keep these transitions:
  - Duplicate matching prepare waits for or returns the same outcome.
  - Conflicting prepare returns `operation_conflict`.
  - A non-matching action during preparation or apply returns `busy`.
  - Status returns `prepared` only for prepared state.
  - Apply without prepared state returns `not_prepared`.
  - Cancel aborts preparation and removes prepared state.
  - Cancel during mutation returns `busy` and does not interrupt an append-only rewrite halfway through apply.
  - Session or leaf changes return `session_changed` where they do now.
- [ ] Pass the preparation signal through model calls.
- [ ] Delete all states for the old session on `session_shutdown`.
- [ ] Keep result emission outside the state transition so every accepted request gets one result.
- [ ] Catch unexpected errors at the adapter boundary and return `compression_failed`.
- [ ] Adapt the normal range protocol to this coordinator first.
- [ ] Keep all public range-compression function and type exports stable.

### Acceptance gate

- [ ] The range protocol passes all state-transition and cancellation tests.
- [ ] One operation cannot exist in incompatible state collections.
- [ ] A cancelled model call receives an aborted signal.
- [ ] Apply remains non-interruptible after session mutation starts.
- [ ] `npm test` and `npm run check` pass before batch migration starts.

---

## WU-10 — Adapt batch compression and remove `batch.ts`

**Depends on:** WU-09

**Files:** `src/batch.ts`, `src/range-compression.ts`, `src/index.ts`, related existing tests

- [ ] Keep a batch-specific target resolver that finds:
  - The batch marker anchor.
  - The queued task message.
  - The first assistant execution entry.
  - The last safe endpoint at or before the settled entry.
- [ ] Make batch summary preparation use the shared range preparation path.
- [ ] Keep the batch task message in the prepared batch value.
- [ ] Keep batch-specific details with `v: 2` and all current hashes, revisions, IDs, and bitmap data.
- [ ] Keep batch-specific rewrite output:
  - `QUEUED_TASK_TAIL`
  - `COMPRESSION_TAIL`
  - `COMPRESSION_ENTRY`
- [ ] Keep normal range output separate from batch output.
- [ ] Add the batch protocol adapter to the shared coordinator.
- [ ] Preserve duplicate, conflict, status, apply, cancel, busy, and session-change results.
- [ ] Use the shared cancellation controller for batch summary drafting.
- [ ] Move `registerBatchCompression()` into `range-compression.ts` or replace it with one `registerCompressionServices()` function.
- [ ] Preserve a named `registerBatchCompression()` re-export if any recorded public or test consumer needs it.
- [ ] Delete `src/batch.ts` after all imports move.

### Acceptance gate

- [ ] Both protocols use one operation coordinator.
- [ ] Both protocols retain their exact event names and result schemas.
- [ ] Batch and normal range operations cannot collide.
- [ ] Existing workstream batch clients require no change.
- [ ] `npm test`, `npm run check`, and `npm run knip` pass.

---

## WU-11 — Simplify registration and package identity

**Depends on:** WU-02, WU-05, WU-10

**Files:** `src/index.ts`, `package.json`, `README.md`, `PROTOCOL.md`, `ORIGIN.md`, user-visible source strings

- [ ] Remove the stale `src/index.ts` header that refers to `pi-context-tree`, a missing architecture file, and a fixed Pi version.
- [ ] Remove `if (api.events)` because `events` is required by `ExtensionAPI`.
- [ ] Register the unified compression services directly.
- [ ] Keep `index.ts` as registration code only.
- [ ] Use `pi-context-compress` in current user-visible titles, descriptions, notifications, and documentation.
- [ ] Keep old `ctree/*` and legacy workstream identifiers only where stored-session or protocol compatibility requires them.
- [ ] Update source paths in package exports only where a target file actually moved.
- [ ] Confirm that production dependencies remain in `dependencies` and Pi-provided packages remain in `peerDependencies`.
- [ ] Do not replace `minimatch`, `yargs-parser`, TypeBox, or Pi TUI components with custom code.
- [ ] Confirm that `files` still includes every published source and required document.

### Acceptance gate

- [ ] The package has one current user-visible identity.
- [ ] Stored sessions need no migration.
- [ ] Root, protocol, and range-compression imports still resolve.
- [ ] Extension registration contains no compatibility test that is always true.
- [ ] `npm test`, `npm run check`, and `npm run knip` pass.

---

## WU-12 — Perform final pruning and full validation

**Depends on:** WU-08, WU-11

**Files:** All touched files and existing tests

- [ ] Run Knip against the corrected package entry list.
- [ ] Remove only exports, functions, fields, imports, and types that Knip and direct source review confirm are unused.
- [ ] Remove `resetModelCompletions()` if no recorded public or existing test consumer needs it.
- [ ] Remove small pass-through helpers that do not enforce an invariant.
- [ ] Keep domain helpers that define safety or behavior boundaries.
- [ ] Confirm that no deleted path remains in source, tests, package metadata, or documentation.
- [ ] Confirm that no circular import remains in the target dependency graph.
- [ ] Format touched files with the repository formatter.
- [ ] Run:

```text
npm test
npm run typecheck
npm run lint
npm run knip
npm pack --dry-run
```

- [ ] Test extension startup in Pi.
- [ ] Test `/branch`, `/merge`, `/crop`, `/compress`, `/panel`, `/decisions`, and `/undo` in one disposable session.
- [ ] Test Ctrl+Q and confirm that it opens the actionable panel without an LLM request.
- [ ] Test range prepare, status, apply, cancel, duplicate, conflict, and repeated apply through the event bus.
- [ ] Test the same transitions through the batch event bus.
- [ ] Load a session that contains old `ctree/*` entries and a `pi-workstream/compression` marker.
- [ ] Confirm that a source range remains reachable at its original leaf after crop, range compression, and batch compression.
- [ ] Confirm that failed revalidation writes no replacement messages or marker.
- [ ] Confirm that cancel during preparation stops the nested model call.
- [ ] Confirm that no `.env`, token, credential, session file, generated package archive, or temporary output is staged.
- [ ] Review the final diff for unrelated changes.

### Final acceptance gate

- [ ] All automated checks pass.
- [ ] All required invariants at the top of this document pass.
- [ ] The final source layout has about 10 files.
- [ ] `src/core/`, `src/extension/`, and `src/batch.ts` no longer exist.
- [ ] There is one compression operation coordinator.
- [ ] There are no circular imports.
- [ ] Large context snapshots do not deep-copy message bodies several times.
- [ ] No command, protocol, TUI view, review step, recovery path, or stored-session behavior was removed.

## Expected reduction

Use these values as review targets, not as reasons to remove useful boundaries.

- [ ] Source files: 13 → about 10.
- [ ] Internal one-file directories: 2 → 0.
- [ ] Compression operation state collections: 8 → 1 operation-state map.
- [ ] Compression request execution engines: 2 → 1.
- [ ] Circular import groups: 3 → 0.
- [ ] Net function reduction: about 12–20 functions.
- [ ] Net source reduction: about 400–650 lines.
- [ ] Preserve separate files for protocol, panel presentation, drafting, mutation safety, and branch behavior even if a larger single file would reduce the raw file count further.
