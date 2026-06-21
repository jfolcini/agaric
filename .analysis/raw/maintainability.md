# Maintainability Analysis — Agaric

**Summary.** This is a deliberately well-factored, heavily-split codebase. The
nominally "largest" files are mostly test modules (`db/mod.rs` is ~99% `#[cfg(test)]`;
`projection.rs`, `loro_sync.rs` are ~2/3 tests). Production code is decomposed into
focused, single-responsibility functions. The genuine maintainability debt is
concentrated in three places: (1) the in-browser **tauri mock** is a 3.9k-line parallel
reimplementation of backend query/filter/sort logic whose *behaviour* is unguarded;
(2) the reserved-key → `blocks`-column **mapping** is hand-rolled across ~4 files (the
*membership* set is centralized + drift-tested, but the column-name mapping is not);
(3) a handful of FE components exceed the documented ~500-line decomposition threshold,
led by `BlockTree.tsx` (1067 lines), a god-component for editor/overlay orchestration.

**Counts:** CRITICAL 0 · HIGH 0 · MEDIUM 3 · LOW 3

---

### [MEDIUM] Tauri mock reimplements backend query/filter/sort/pagination logic with only presence-parity enforcement
- **Location**: `src/lib/tauri-mock/handlers.ts` (3894 lines; esp. `compareMetaRows` :343, `sortDiscriminator` :380, `encodeNextCursor` :403, `metaRowMatchesFilter` :227, `hasPropertyMatches` :272, `fbqCompare` :578, `fbqResolveValues` :603, `fbqPropertyFilterMatches` :625); guard: `scripts/check-tauri-mock-parity.mjs`
- **Evidence**: The mock hand-reimplements substantial backend semantics in TS. Comments make the parallelism explicit — e.g. `fbqPropertyFilterMatches` is documented as "mirrors the EXISTS-subquery semantics the backend emits per filter (or, for reserved keys, the direct column predicate routing)"; `encodeNextCursor`/`compareMetaRows`/`sortDiscriminator` re-encode the PageBrowser v2 cursor schema (the same compound-slot overload described in AGENTS.md "Pages view" invariant 1) that lives canonically in `src-tauri/src/commands/pages/metadata.rs`. The only automated guard, `check-tauri-mock-parity.mjs`, verifies that every IPC name in `bindings.ts` *has a handler* — its own header says so ("has a corresponding handler") — and explicitly does **not** check behavioural fidelity.
- **Problem**: Two implementations of the same filter/sort/cursor logic in two languages, kept in sync only by hand. The parity hook catches missing handlers, not divergent behaviour. A change to backend filter semantics (new operator, sort tiebreaker, cursor slot meaning) silently leaves the mock stale, so Playwright e2e tests pass against behaviour the real backend no longer has.
- **Impact**: E2e tests give false confidence; bugs in filter/sort/pagination edge cases (the exact class the cursor invariants exist to protect) escape the e2e net because the mock agrees with the *old* contract. Each new filter dimension or sort mode now requires a parallel TS edit that nothing forces.
- **Fix**: (a) Add a small set of cross-checked conformance fixtures: a JSON corpus of (input rows, filter/sort spec) → expected ordered IDs, asserted by BOTH a Rust test (real query path) and a vitest test (mock path), so divergence fails CI. Start with the highest-churn surfaces: PageBrowser sort/cursor and `run_advanced_query` (`fbq*`). (b) Where feasible, narrow the mock to dumb fixtures rather than re-deriving (e.g. precomputed sorted orders) so there is less logic to drift. Don't try to eliminate the mock — just convert "presence parity" into "behaviour parity" for the few load-bearing query surfaces.
- **Confidence**: high — the parallel logic and the presence-only guard are both explicit in code/comments.
- **Effort**: M

### [MEDIUM] Reserved-key → blocks-column mapping is hand-rolled across ~4 production files (membership is centralized, mapping is not)
- **Location**: `src-tauri/src/loro/projection.rs:206-250` (set) and `:537-565` (delete); `src-tauri/src/db/recovery.rs:~591-610`; `src-tauri/src/cache/agenda.rs:512,523`; `src-tauri/src/commands/queries.rs` and `src-tauri/src/pagination/properties.rs` (key routing). Source of truth: `src-tauri/src/op.rs:438` (`RESERVED_PROPERTY_KEYS`), `:449` (`COLUMN_BACKED_PROPERTY_KEYS`).
- **Evidence**: The *set membership* of column-backed keys is a single constant with three drift tests (`reserved_key_set_matches_db_check_constraint_589`, `reserved_key_blocks_column_covers_column_backed_set_589`, etc. in `db/mod.rs`). But the *per-key column mapping* — i.e. `todo_state→todo_state`, `priority→priority`, `due_date→due_date`, `scheduled_date→scheduled_date` (and `space→space_id` with page-group fan-out) — is re-expressed as `match payload.key.as_str()` arms in `projection.rs` twice (set + delete: lines 209-249 and 540-563), again in `recovery.rs` (which itself comments "A key added to COLUMN_BACKED_PROPERTY_KEYS without a mapping arm…"), and the column UPDATEs recur in `cache/agenda.rs`.
- **Problem**: Adding a fifth column-backed property requires editing every match site by hand. The set-membership drift test passes (the constant is updated), but a forgotten mapping arm in `projection.rs` set/delete or `recovery.rs` is caught only by the catch-all `other =>` arm returning a `Validation` error at *runtime/replay*, not at compile time. The dual-write surface that AGENTS.md already calls "non-trivial" (crud.rs + commands/mod.rs + materializer + projection + recovery) has no single mapping table.
- **Impact**: A column promotion (an explicitly-supported, if rare, operation) is error-prone: easy to update the constant + one or two sites and miss `project_*` or `recovery`, producing a key that validates as column-backed but silently fails to project on replay/undo.
- **Fix**: Introduce one mapping function in `op.rs`, e.g. `fn reserved_key_column(key: &str) -> Option<ReservedColumn>` returning an enum that knows its column name + value-kind (text vs date) + fan-out flag. Have `projection.rs` (set/delete), `recovery.rs`, and `agenda.rs` route through it. The `sqlx::query!` macros need literal SQL, so keep the per-column `UPDATE` statements, but drive *which* one runs from the single enum match — collapsing 4+ hand-rolled `match key` blocks into one. Add a test asserting every `COLUMN_BACKED_PROPERTY_KEYS` entry resolves to a mapping (compile-/test-time, not replay-time).
- **Confidence**: high — duplication and the runtime-only failure mode are both directly visible; the existing in-code comment in `recovery.rs` already worries about exactly this drift.
- **Effort**: M

### [MEDIUM] `BlockTree.tsx` (1067 lines) is a god-component coordinating editor + overlay state inline
- **Location**: `src/components/editor/BlockTree.tsx` (1067 lines, largest production .tsx); ~37 hook/effect/callback sites; inline overlay state at :222 (`historyBlockId`), :225 (`propertyDrawerBlockId`), :229-230 (query builder), :234 (`emojiPickerOpen`).
- **Evidence**: The component holds the roving-editor ref (`rovingEditorRef` :255), navigation wiring, and a growing pile of independent overlay/modal `useState` pairs (history, property drawer, query builder, emoji picker), each with its own `handleShow*` `useCallback` (:236, :240, …). AGENTS.md "Component decomposition" documents the convention: ">~500 lines are candidates for extraction" and prescribes "extract hooks first … extract presentational sub-components next … maintain backward compatibility via re-exports."
- **Problem**: Every new block-level overlay adds another `useState` + `handleShow*` + conditional JSX render here. The file already mixes three concerns: page-block data subscription, roving-editor orchestration, and modal/overlay lifecycle. This is precisely the "adding the next feature will be painful" pattern — the next picker/drawer lands in an already-1k-line file.
- **Impact**: High cognitive load to modify the editor surface; merge-conflict hotspot; the documented decomposition convention is being diverged from on the single most central editor component.
- **Fix**: Per the documented pattern: extract overlay state into a `useBlockTreeOverlays()` hook (returns `{ historyBlockId, propertyDrawerBlockId, queryBuilder, emojiPicker, openHistory, openProperties, … }`), and extract the overlay-rendering JSX into a `<BlockTreeOverlays …/>` presentational component. Keep `BlockTree` as the data + roving-editor coordinator. Re-export from the original file for compatibility. This removes ~4 state clusters and their JSX in one move.
- **Confidence**: high for the size/divergence; medium that decomposition is net-positive (this team correctly resists splitting where it worsens prop-drilling — the overlay state is genuinely independent of the editor ref, so this split should be clean).
- **Effort**: M

### [LOW] Several FE components exceed the documented ~500-line decomposition threshold
- **Location**: `src/components/common/CommandPalette.tsx` (995), `src/components/ui/sidebar.tsx` (868), `src/components/editor/BlockContextMenu.tsx` (843), `src/components/attachments/AttachmentRenderer.tsx` (822), `src/components/editor/SortableBlock.tsx` (785), `src/components/SearchPanel.tsx` (748).
- **Evidence**: All exceed the ">~500 lines are candidates for extraction" guidance in AGENTS.md. `sidebar.tsx` is a vendored shadcn primitive (lower priority). `BlockContextMenu.tsx` and `CommandPalette.tsx` are long flat lists of action definitions (cohesive but extractable).
- **Problem**: Not individually broken, but collectively they show the 500-line convention is aspirational rather than enforced — there's no lint/CI gate, so the threshold drifts upward over time.
- **Impact**: Gradual erosion of the decomposition convention; reviewers must spot it by eye.
- **Fix**: Lowest-effort win is the menu/action files: extract their action-descriptor arrays into a sibling `*.actions.ts` so the component is just rendering. Optionally add an advisory (warn-only) size check to the lint surface, since the convention is documented but unenforced. Treat `sidebar.tsx` as out of scope (vendored).
- **Confidence**: medium — line counts are exact; whether each warrants splitting is judgment.
- **Effort**: M (across files; S each)

### [LOW] Reserved-key column UPDATE shape is repeated 4× within `project_set_property_to_sql`
- **Location**: `src-tauri/src/loro/projection.rs:209-249` (set) and `:540-563` (clear-to-NULL).
- **Evidence**: Four near-identical `sqlx::query!("UPDATE blocks SET <col> = ? WHERE id = ?", value, block_id)` arms differing only by column name and which payload field (`value_text` vs `value_date`) feeds in. The clear path repeats the same four columns with `= NULL`.
- **Problem**: Mechanical repetition. Because `sqlx::query!` requires a string literal, it can't be a single parameterized statement, so the repetition is partly forced — but it compounds the mapping-duplication finding above (same arms, different file).
- **Impact**: Minor; bundled into the MEDIUM mapping-centralization fix above.
- **Fix**: Subsumed by the `reserved_key_column` enum refactor — once the column choice is data-driven, the set and clear paths each become one `match` selecting among the (still-literal) statements, with no value-field hand-routing.
- **Confidence**: high.
- **Effort**: S (folds into the MEDIUM above)

### [LOW] `db/mod.rs` (4148 lines) is an outsized test module that should be split for navigability
- **Location**: `src-tauri/src/db/mod.rs` — lines 1-13 are module wiring; 14-4148 are a single `#[cfg(test)] mod tests`.
- **Evidence**: The "largest production file" is ~99% one test module. The production code it tests lives in already-split siblings (`pool.rs`, `command_tx.rs`, `recovery.rs`). The test module bundles pool-init, FK, WAL, recovery-replay (#73, #429, #534, #605, #613-#618, #651…), command-tx, and timestamp-migration tests in one 4k-line file.
- **Problem**: Not a correctness issue and explicitly de-prioritized by scope (tests). But it impedes navigation and is the single biggest reason `db/mod.rs` shows up as "the largest file," skewing size dashboards. The production modules are split; their tests are not.
- **Impact**: Test-discovery friction; misleading size signal.
- **Fix**: Move the recovery-replay tests into `recovery.rs`'s own `#[cfg(test)]` (they already use `recovery::*` via the glob re-export at :12, which exists solely for this), and the command-tx tests into `command_tx.rs`. Leaves `db/mod.rs` tests focused on pool/pragma. Low value; note only.
- **Confidence**: high.
- **Effort**: S

---

## Cross-dimension notes
- The reserved-key mapping finding has a **data-integrity** edge: a missing `match` arm fails only at op-log *replay/undo* time (catch-all `Validation` error), which the data-integrity agent may want to weigh independently.
- `projection.rs` `project_set_property_to_sql` carries a documented FK-skip degrade (`#708`, :275-283) mirroring recovery's `#605` contract — correct and intentional, flagged here only as evidence the team handles sync-replay edge cases deliberately (do not re-report as a bug).

## Areas reviewed / not reviewed
- **Reviewed (production focus):** `db/mod.rs` (structure — found test-only), `db/pool.rs`/`command_tx.rs`/`recovery.rs` (structure + reserved-key mapping), `loro/projection.rs` (full production half, 1-1181), `sync_protocol/loro_sync.rs` (production half, 1-774), `op.rs` reserved-key constants (430-484), `src/lib/tauri.ts` (export catalog — confirmed thin-wrapper, no god-fn), `src/lib/tauri-mock/handlers.ts` (filter/sort/cursor/fbq logic), `scripts/check-tauri-mock-parity.mjs`, largest FE `.tsx` (`BlockTree.tsx` in depth; others by metrics). AGENTS.md conventions read in full.
- **Not reviewed in depth:** materializer handlers internals, `cache/*.rs` beyond the agenda UPDATE sites, the command handlers (`commands/blocks/crud.rs`, `commands/mod.rs`) — sampled only via grep for the dual-write surface; `engine/` directory; the full FE store layer. `bindings.ts` skipped (generated, per prompt). knip output not executed (would require install); noted that `knip` runs pre-push and should already catch genuine unused exports — no manual dead-export hunt performed.
