# Session 1007 — testing: mock-vs-backend conformance corpus (#763 item 1)

Maintainer split #763 into its four adoptions (#886 StrykerJS, #887 React Compiler, #888
Maestro Android lane) and approved **item 1** — the conformance corpus — as a standalone PR.

## Shipped

- **`test(conformance)` #763 item 1** — a cross-language conformance harness proving the
  3,509-line tauri-mock reproduces the **real backend's** behavior, so drift fails CI.
  Today only NAME parity is checked (135/135 commands) while 51 e2e specs trust the mock's
  behavior with zero behavioral cross-check.

  **Design (backend = source of truth):**
  - Shared fixtures at repo-root `conformance/fixtures/*.json`: `{ name, seed, ops, expected }`.
    Seed ids are stable labels (`S1`…) padded to a valid 26-char ULID shape so `[[id]]` link
    tokens + FK refs work on both sides.
  - **Canonical id-relabeling** defeats ULID/counter nondeterminism: both normalizers walk
    blocks in seed-then-op-creation order (from the op_log), assign `B1,B2,…`, and remap EVERY
    id reference (`parent_id`, `page_id`, `block_tags`, `page_links.{source,target,source_page}`,
    property `value_ref`). Nondeterministic fields (timestamps, hashes, auto-properties)
    stripped; `deleted_at` → `"DELETED"` sentinel.
  - Symmetric normalizers — Rust (`command_integration_tests/conformance{,_snapshot}.rs`) and
    TS (`tauri-mock/__tests__/conformance{-snapshot.ts,.test.ts}`) — produce byte-identical
    canonical JSON: blocks / properties (typed) / block_tags / page_links / op_log_digest.
  - `CONFORMANCE_UPDATE=1` authors `expected` from the Rust backend; the mock test asserts it
    reproduces that. `expected` is never hand-written.

  **The runner exercises the production apply pipeline.** Ops are applied via
  `append_local_op` + `materializer.dispatch_op` + `settle` with the Loro engine installed
  (`shared::install_for_test` + per-space engine seed) — i.e. the real foreground `ApplyOp`
  path that reprojects the authoritative dense sibling rank (crud.rs:195: the inline command
  position is *provisional/optimistic*; "the materializer reprojects the authoritative dense
  rank from the engine's fractional order shortly after"). A permanent runner assertion fails
  loudly if any op-created block is missing from the engine tree, guarding against silent
  regression to the SQL-only fallback. **Result: all 5 fixtures pass on BOTH sides, mock
  unchanged.**

  **#891 — a corpus harness bug, NOT a mock bug.** The first cut of the runner called the
  `*_inner` command fns with no engine installed, so it captured the *transient provisional*
  position (gaps) instead of the *settled reprojected* position. That made
  `position_reproject_drift` look like mock drift (mock dense-renumbers = correct;
  fallback-runner = gapped). Fixing the runner to settle the reproject (production steady
  state) resolved it: the fixture is re-authored dense and un-skipped, and the mock matches
  with no change. #891 closed as the corpus fix.

  Reviewer verified normalizer symmetry field-by-field and ran a **perturbation probe** (flip a
  `source_page_id` → both runners fail), proving the comparison is real and non-vacuous. Rust
  conformance suite + the mock vitest + tsc all green.

  Extends by dropping a fixture JSON + `CONFORMANCE_UPDATE=1`; a new op kind needs one dispatch
  arm per runner. Refs #763 (item 1); Closes #891.

## Backlog state
- #763 re-scoped to item 1 (this PR); items 2/3/4 = #886/#887/#888.
- #891 filed then resolved IN this PR (it was a harness bug — the runner captured the
  transient provisional position; fixed by running the settled engine reproject).
- Remaining actionable arch: #139 (space-filter SQL dedup), #882 (tx-core extraction). Gated:
  #709 (tag re-key plan), #877 (component migration — quiet tree), #645-core / #644 deep slices
  (deferred). #833 (docs CI fast-path) flagged for maintainer (touches the strict merge gate).
