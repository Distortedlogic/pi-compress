# Lean Source Refactor Task List

## Goal

Move all TypeScript code into one root `src/` tree. Reduce source files, test files, copied Pi code, and custom utility code without a loss of commands, protocol compatibility, session recovery, TUI behavior, RPC behavior, or append-only safety.

## Fixed contracts

Do not change these contracts during the refactor:

- Commands: `/branch`, `/merge`, `/crop`, `/compress`, `/panel`, `/decisions`, and `/undo`.
- Shortcut: `Ctrl+Q`.
- Merge modes: squash, no-LLM, discard, and tournament.
- Crop modes: result, whole turn, top, auto, apply, and dry run.
- Public exports: `.` and `./protocol`.
- Event channels: `pi-context-compress/v1/request` and `pi-context-compress/v1/result`.
- Durable custom types: all current `ctree/*`, `pi-context-compress/*`, and accepted legacy `pi-workstream/compression` values.
- Existing schema versions and old session readability.
- Append order, source hashes, human review gates, stale-session checks, and `summarize: false` navigation.
- TUI, RPC, print, and headless command paths.

## Target layout

```text
src/
  index.ts
  protocol.ts
  session.ts
  branches.ts
  compression.ts
  batch.ts
  panel.ts
  prompts.ts
  __tests__/
    protocol.test.ts
    compression.test.ts
    extension.test.ts
```

| Target file | Current code to absorb or replace |
| --- | --- |
| `src/index.ts` | `packages/extension/src/index.ts` and registration only |
| `src/protocol.ts` | Batch protocol plus TypeBox schemas for all durable extension data |
| `src/session.ts` | Required parts of core types, tree queries, estimation, consumers, and serialization; replace copied Pi behavior with public Pi APIs |
| `src/branches.ts` | Branch, state, merge, undo, decision record, and decision export code |
| `src/compression.ts` | Crop planning, range planning, range command, crop command, and shared rewrite engine |
| `src/batch.ts` | Batch service and batch-specific coordination |
| `src/panel.ts` | Panel model, panel component, ambient status, gauge, theme use, and decision renderer |
| `src/prompts.ts` | Decision and range prompts, model calls, output checks, and size checks |

## Ordered work units

### WU-01 — Freeze behavior and establish the baseline

**Depends on:** none

- [x] Run `npm test` and `npm run check`; record all existing failures before edits.
- [x] Map every fixed contract above to at least one existing test or smoke check.
- [x] Record the current package output with `npm pack --dry-run`.
- [x] Record one TUI load check and one RPC load check for the current extension.
- [x] Identify tracked work that is outside this refactor and do not modify it.

#### Baseline record

- `npm test`: passed; 27 files passed, 1 file skipped, 212 tests passed, and 3 tests skipped.
- `npm run check`: passed; TypeScript passed and Biome checked 72 files with no fixes.
- `npm pack --dry-run`: passed; 37 files, 52.4 kB packed, 178.2 kB unpacked, SHA-1 `b8f833b91fb1a69895fd2bc385d92b773dad27c0`. The package contains `PROTOCOL.md`, the empty `README.md`, `package.json`, and the production TypeScript under `packages/core/src`, `packages/extension/src`, and `packages/tui/src`.
- Public export smoke: passed; both `pi-context-compress` and `pi-context-compress/protocol` loaded, and the protocol export included both event-channel constants.
- RPC load smoke: `packages/extension/test/rpc-smoke.test.ts` passed, 1 test and 0 failures.
- Real TUI load check: `packages/extension/test/golden/tui-pty.test.ts` was found but all 3 tests skipped because this machine has no `expect` executable. The available fallback, `packages/tui/test/panel.test.ts`, passed 12 tests, including the headless TUI mount, render, width, and input smoke. The real PTY test remains the final TUI load verification path.
- Worktree baseline: no tracked changes. Untracked `TREE.txt` is outside this refactor and was not modified.

#### Fixed-contract verification map

| Contract | Existing verification path |
| --- | --- |
| `/branch`, `/merge`, `/crop`, `/compress`, `/panel`, `/decisions`, `/undo` | Registration: `packages/extension/test/index.test.ts`. Behavior: `branch.test.ts`, `merge.test.ts`, `crop.test.ts`, `panel-cmd.test.ts`, and `undo.test.ts`. |
| `Ctrl+Q` | `packages/extension/test/panel-cmd.test.ts` checks the exact shortcut and opens the panel. |
| Merge squash, discard, and tournament | `packages/extension/test/merge.test.ts` and `packages/extension/test/golden/golden-scenarios.test.ts`. |
| Merge no-LLM | The manual-template path is covered by the drafting-failure fallback in `packages/extension/test/merge.test.ts`; there is no direct `--no-llm` case, so WU-09 must retain or add one. |
| Crop result, whole turn, top, auto, apply, and dry run | `packages/core/test/crop.test.ts`, `packages/core/test/turns.test.ts`, `packages/extension/test/crop.test.ts`, and the TUI PTY crop cases. |
| Public exports `.` and `./protocol` | The public export smoke above and `package.json`; protocol behavior is also used by `packages/extension/test/index.test.ts`. |
| Request and result event channels | `packages/extension/test/index.test.ts` covers prepare, apply, cancel, conflicts, and session changes through the independent compression interface. |
| Durable `ctree/*` and `pi-context-compress/*` values | Golden session tests, crop/range/undo tests, and protocol interface tests inspect the persisted custom types and append-only recovery data. |
| Accepted legacy `pi-workstream/compression` | Compatibility branches exist in `packages/extension/src/batch-range.ts` and `packages/extension/src/undo.ts`; there is no direct legacy fixture, so WU-09 must add one. |
| Existing schema versions and old sessions | `packages/core/test/jsonl.test.ts`, `packages/core/test/fixtures.test.ts`, and `fixtures/legacy-v1.jsonl`. |
| Append order and recovery | `merge.test.ts`, `crop.test.ts`, `golden-scenarios.test.ts`, and `undo.test.ts` check decision-before-close, tail-before-marker, original preservation, and undo targets. |
| Source hashes | `packages/core/test/crop.test.ts` checks the stable selected-source hash; extension compression tests reject changed source and metadata. |
| Human review gates and stale-session checks | `merge.test.ts`, `crop.test.ts`, and `index.test.ts` check cancellation, empty review, changed leaf/session, and no writes on failure. |
| `summarize: false` navigation | Explicit assertions exist in `merge.test.ts`, `crop.test.ts`, `panel-cmd.test.ts`, and `undo.test.ts`; golden tests also reject extra branch summaries. |
| TUI, RPC, print, and headless paths | TUI PTY and fallback results are recorded above; `rpc-smoke.test.ts` covers RPC load; `crop.test.ts` covers headless auto-apply; `panel-cmd.test.ts` covers no-TUI decision listing. A direct print-process smoke is not present and must be included in WU-09 or WU-12. |

**Gate**

- [x] The baseline is known, and each user-visible behavior has a verification path.

### WU-02 — Put all code under root `src/`

**Depends on:** WU-01

- [x] Move production TypeScript from `packages/core/src`, `packages/extension/src`, and `packages/tui/src` into `src/`.
- [x] Move all retained test TypeScript into `src/__tests__/`.
- [x] Move `fixtures/generate.ts` into `src/__tests__/` only if it remains necessary; otherwise delete it after fixture replacement.
- [x] Keep non-code fixtures under `src/__tests__/fixtures/` only when an inline fixture is not clear enough.
- [x] Update `package.json`:
  - [x] Set `exports["."]` to `./src/index.ts`.
  - [x] Set `exports["./protocol"]` to `./src/protocol.ts`.
  - [x] Set `pi.extensions` to `./src/index.ts`.
  - [x] Package runtime `src` files and exclude `src/**/*.test.ts` and `src/__tests__/**`.
- [x] Update `tsconfig.json` to include `src/**/*.ts` only.
- [x] Remove the `#core`, `#core/testkit`, and `#tui` import aliases.
- [x] Use direct relative imports.
- [x] Keep this unit structural. Do not change behavior in the same edits.

**Gate**

- [x] No TypeScript code remains in `packages/` or `fixtures/`.
- [x] The baseline tests and checks still pass.

### WU-03 — Replace copied Pi infrastructure with public Pi APIs

**Depends on:** WU-02

- [x] Delete the copied Pi message and session interfaces.
- [x] Import public Pi types, or derive an entry type from `sessionManager.getEntries()` when no direct export exists.
- [x] Delete `adapter.ts`; use `ExtensionAPI`, `ExtensionContext`, and `ExtensionCommandContext` directly.
- [x] Delete `ctx-cache.ts`; never store a Pi context after an event or command ends.
- [x] Cache only plain model reference strings for command completion.
- [x] Replace custom live-session tree and context reconstruction with:
  - [x] `getBranch()` for ancestry and active-path work.
  - [x] `buildContextEntries()` for the compaction-aware active context.
  - [x] `getTree()` for display and selection.
  - [x] `getEntry()` and `getLeafId()` for validation.
- [x] Use Pi AI `contentText` for normal content extraction.
- [x] Keep one local serializer only for extension summary prompts and source hashes.
- [x] Keep one local per-entry `chars / 4` estimator because Pi does not expose a provider-neutral per-entry count.
- [x] Use `ctx.getContextUsage()` whenever Pi has a real total.
- [x] Remove `forest.ts`, the standalone JSONL reader, the custom test session builder, and their tests unless a declared public entry point or documented command uses them.
- [x] If offline reading is a required public feature, use `SessionManager.inMemory()` and `SessionManager.listAll()` in one `src/session.ts` path instead of maintaining a second session model.

**Gate**

- [x] Live extension code has no copied Pi session model and no retained stale context.
- [x] Existing sessions, including compacted and branched sessions, still load.

### WU-04 — Make schemas the single source for durable data

**Depends on:** WU-03

- [x] Move all protocol constants and persisted payload schemas to `src/protocol.ts`.
- [x] Keep exact schemas for external request and result messages.
- [x] Use forward-compatible schemas for stored `ctree/*` entries where additive fields are valid.
- [x] Generate TypeScript types with `Static<typeof Schema>`.
- [x] Replace manual `v === 1` checks and unsafe payload casts with `Value.Check`.
- [x] Keep readers for every current durable type and the accepted legacy compression type.
- [x] Do not rename stored custom types to match display names.

**Gate**

- [x] Each external or persisted boundary validates `unknown` data before use.
- [x] `./protocol` remains source compatible.

### WU-05 — Create one append-only rewrite engine

**Depends on:** WU-04

- [x] Define one internal rewrite plan with:
  - [x] Source leaf ID and anchor ID.
  - [x] Ordered selected entry IDs.
  - [x] Ordered continuation entry IDs.
  - [x] Complete serialized source.
  - [x] Full SHA-256 source hash; derive an eight-character value only for display compatibility.
- [x] Keep an assistant tool call and all matching contiguous tool results in one atomic range group.
- [x] Reject a root range, an incomplete current turn, structural summaries, decision records, incomplete tool groups, and orphan tool results.
- [x] Implement one preparation function and one revalidation function.
- [x] Implement one apply operation with this order:
  1. [x] Wait for idle.
  2. [x] Check session ID, source leaf, selected IDs, and source hash.
  3. [x] Navigate to the anchor with `summarize: false`.
  4. [x] Append replacement custom messages in required order with `triggerTurn: false`.
  5. [x] Append the operation marker last.
- [x] Return before the first write on every validation or review failure.
- [x] Keep operation-specific details outside the shared engine.

**Gate**

- [x] Crop, selected-range compression, and batch compression can use the same plan, validation, and apply rules.

### WU-06 — Consolidate branch and decision features

**Depends on:** WU-05

- [ ] Merge branch state, branch extraction, merge, undo, decision rendering, and decision export into `src/branches.ts`.
- [ ] Use `yargs-parser` for merge and decision command arguments.
- [ ] Preserve duplicate-name checks and optional branch-model selection.
- [ ] Preserve plain string model completion without retaining the event context.
- [ ] Preserve all merge modes and the mandatory edit or confirm gate.
- [ ] Preserve decision-before-close append order.
- [ ] Preserve tournament sibling closure and epitaphs.
- [ ] Preserve trunk-model restoration and warning behavior.
- [ ] Preserve append-only undo targets for branch, close, crop, selected range, and batch compression.
- [ ] Render decision cards with Pi TUI `Text` or `Markdown`; remove the separate decision-card module.

**Gate**

- [ ] Branch, merge, discard, tournament, decision export, model restore, and undo match the baseline.

### WU-07 — Consolidate crop, range, and batch compression

**Depends on:** WU-05

- [ ] Merge crop planning, crop command handling, range planning, and range command handling into `src/compression.ts`.
- [ ] Use `yargs-parser` for crop flags and repeated `--keep` values.
- [ ] Use `minimatch` for tool and primary-argument keep patterns; delete the custom glob-to-regex function.
- [ ] Preserve latest-result double marking, automatic selection, whole-turn removal, top selection, dry run, and headless apply.
- [ ] Preserve full selected source for summary generation; do not add per-entry truncation to selected-range compression.
- [ ] Preserve stale-leaf, changed-ID, and changed-hash rejection.
- [ ] Move batch coordination to `src/batch.ts` and reuse the shared rewrite engine.
- [ ] Do not keep a session-context map in the batch service. Validate the fresh command context supplied for each in-process request.
- [ ] Preserve prepare, apply, cancel, status, busy, conflict, missing, failed, and idempotent replay results.
- [ ] Preserve queued-task-before-summary-before-marker order.
- [ ] Keep prepared state as plain request, plan, and summary data only.

**Gate**

- [ ] All three compression paths use one range safety implementation.
- [ ] RPC and event-bus batch behavior match the baseline.

### WU-08 — Replace hand-built TUI plumbing with Pi components

**Depends on:** WU-06 and WU-07

- [ ] Merge panel state, rendering, ambient status, gauge, and message rendering into `src/panel.ts`.
- [ ] Use the theme passed by Pi; delete the custom theme interface and Chalk default theme.
- [ ] Use `TreeSelectorComponent` for tree and range entry selection.
- [ ] Use `SettingsList` for crop marks and protected values.
- [ ] Use `SelectList` for consumer and decision lists.
- [ ] Use `BorderedLoader` for cancellable summary work.
- [ ] Use `Text`, `Container`, and `Markdown` for remaining display content.
- [ ] Keep one small panel controller for view changes, folds, feature keys, and returned actions.
- [ ] Preserve tree, crop, whole-turn, consumers, decisions, and inspect views.
- [ ] Preserve width limits, scrolling, read-only mode, notifications, and all current keys.
- [ ] Keep the small 5%, 15%, and 40% context gauge because these thresholds are extension behavior.
- [ ] Preserve the red-band warning, compaction warning, trend marker, status, title, and above-editor gauge.

**Gate**

- [ ] The panel works in the Pi TUI and remains safe in RPC, print, and no-UI modes.
- [ ] No custom ANSI theme or custom list navigation remains when Pi supplies it.

### WU-09 — Consolidate the tests

**Depends on:** WU-06, WU-07, and WU-08

- [ ] Build `src/__tests__/protocol.test.ts` from current protocol, legacy-data, and schema tests.
- [ ] Build `src/__tests__/compression.test.ts` from current crop, turn, range, tree-safety, hash, performance, and batch tests.
- [ ] Build `src/__tests__/extension.test.ts` from branch, merge, undo, ambient, panel, golden, RPC, and TUI tests.
- [ ] Use `SessionManager.inMemory()` instead of `testkit.ts` and large fake session infrastructure.
- [ ] Convert repeated cases to table-driven tests.
- [ ] Keep normalized inline expected entry sequences for squash, discard, crop, and tournament; delete separate golden JSONL files and normalizers.
- [ ] Keep one RPC smoke case and one TUI width and input smoke case.
- [ ] Keep tests for extension policy and integration. Delete tests for Pi, TypeBox, `yargs-parser`, `minimatch`, and removed helper implementations.
- [ ] Delete obsolete test helpers, generated fixtures, and duplicate suites only after their replacement cases pass.

**Gate**

- [ ] The final three test files cover every fixed contract.
- [ ] No test checks deleted implementation details.

### WU-10 — Normalize dependencies and package configuration

**Depends on:** WU-09

- [ ] Remove `chalk`.
- [ ] Add direct runtime dependencies for `yargs-parser` and `minimatch`.
- [ ] Put Pi-hosted packages and `typebox` in `peerDependencies` with `"*"` ranges, as required by Pi package rules.
- [ ] Keep exact Pi and TypeBox versions in `devDependencies` for repeatable local checks.
- [ ] Add `knip` as a development dependency and configure `src/index.ts`, `src/protocol.ts`, and retained tests as entry points.
- [ ] Remove `@xterm/headless` if the final TUI smoke case no longer imports it.
- [ ] Update `package-lock.json` through npm. Do not edit lock data by hand.
- [ ] Remove empty directories, barrels, unused exports, aliases, and dead dependencies reported by Knip.
- [ ] Keep `private: true` unless publication is a separate approved task.

**Gate**

- [ ] `npx knip` reports no unapproved unused files, exports, or dependencies.
- [ ] Production code imports only declared runtime or peer dependencies.

### WU-11 — Update names and documentation without changing stored data

**Depends on:** WU-10

- [ ] Use `pi-context-compress` in current code comments, UI labels, package text, and documentation.
- [ ] Keep old `ctree/*` names only where they are durable session protocol values.
- [ ] Update `README.md` with commands, modes, safety rules, target compatibility, and the root `src/` layout.
- [ ] Update `PROTOCOL.md` for retained channels, schemas, idempotency, append order, and compatibility aliases.
- [ ] Remove stale references to old package paths and `pi-context-tree` where they are not protocol compatibility names.
- [ ] Keep license and origin records unchanged unless a moved path must be corrected.

**Gate**

- [ ] Documentation describes the implemented behavior and contains no old source paths.

### WU-12 — Final verification and commit

**Depends on:** WU-11

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `npx knip`.
- [ ] Run `npm pack --dry-run` and confirm that runtime source is present and tests are absent.
- [ ] Load the extension with `pi -e ./src/index.ts` in TUI mode.
- [ ] Run the RPC smoke path.
- [ ] Verify an existing branched session, compacted session, crop undo, range undo, and batch compression replay.
- [ ] Compare all results with the WU-01 baseline.
- [ ] Confirm that no existing user changes are staged.
- [ ] Commit only the completed refactor with a minimal accurate message.

## Definition of done

- [ ] All TypeScript code is under root `src/`.
- [ ] Production code has no internal package split.
- [ ] Production TypeScript is reduced to approximately eight cohesive files.
- [ ] Tests are reduced to three behavior-focused files.
- [ ] No local copy of Pi session semantics remains.
- [ ] No stale Pi context is stored.
- [ ] Crop, range, and batch compression share one rewrite engine.
- [ ] Pi TUI components replace custom list, loader, theme, and selection code where available.
- [ ] All fixed contracts pass.
- [ ] Existing session history remains readable and recoverable.
- [ ] Checks, package inspection, TUI smoke, and RPC smoke pass.
