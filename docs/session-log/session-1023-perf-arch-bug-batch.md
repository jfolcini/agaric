# Session 1023 — perf / arch / bug / tech-debt batch (#1077 #667 #770 #653 #747 #1071)

Continuation of the autonomous `/loop /batch-issues` pass (2026-06-14). Two more batches
across frontend perf, sync internals, drafts, and DB-contract tooling, run with higher
parallelism (up to ~6 concurrent agents, ≤2 concurrent Rust compiles for earlyoom).

## Shipped (all merged)

- **#1077 (refactor) — page-blocks structural-move helper.** Extracted the
  recompute-at-commit + reconcile-or-reload core duplicated across six actions
  (`createBelow`/`reorder`/`indent`/`dedent`/`moveUp`/`moveDown`) into one
  `applyStructuralMove({validateAtCommit, computeSpliced})` helper with a 3-way
  commit/reload/skip decision. Pure refactor; per-site equivalence verified. PR #1186.
- **#667 (materializer) — single-op multi-device guard.** Added the batch arm's #412
  single-device-cursor invariant to the single-op `apply_op` path as a `debug_assert`
  reusing the cached `COUNT(DISTINCT device_id)` macro. Reviewer corrected the "test-only"
  premise (apply_op is a production path) and swapped the builder's redundant runtime scan
  for the compile-checked macro. PR #1187.
- **#770 (bug) — three draft-lifecycle gaps.** Programmatic-focus orphan rows
  (`deleteDraft` in `persistUnmount`), unmount-while-focused losing <2s of typing
  (chained `saveDraft`→`flushDraft` so the INSERT lands before flush's `BEGIN IMMEDIATE`),
  and emptying a block keeping the stale row (discard-on-clear via `lastSeenRef`). Builds
  on #1065. PR #1191.
- **#653 (tooling) — append_local_op_in_tx contract.** Extended the `check-raw-tx` prek
  hook to flag a bare `.begin()` near the append helpers (proximity-gated, 0 false
  positives over 299 files), with a `--self-test`. Chose lint over a marker newtype / FFI
  debug_assert. PR #1192.
- **#747 (perf) — graph + code-render cluster.** Worker `resize` message (swap forces in
  place, no re-scatter), rAF-coalesced tick application, and a 30KB `highlightAuto` size
  cap. PR #1193.
- **#1071 (perf) — targeted post-sync invalidation.** Thread `changed_page_ids` (recursive
  ancestor CTE) onto `SyncEvent::Complete` (`#[serde(default)]`); the FE reloads only the
  affected mounted page stores, with a mandatory full-reload fallback when the field is
  absent/empty. Fail-safe (over-reports, never stale UI). PR #1194.

## Filed (out-of-scope findings)

- **#1188** — `check-dynamic-sql.py` (#646 guard) misses turbofish call syntax
  (`sqlx::query_scalar::<_,_>(`); found independently in the #667 and #1071 reviews.
- **#1189** — Playwright visual-regression baselines for the design system + key states
  (flake-mitigation requirements written in: CI-container baselines, reduced-motion,
  masked dynamic regions).
- **#1190** — evaluate Storybook scoped to the leaf design-system primitives.

## Notes / lessons

- **Adversarial review caught real defects again:** #770's review found a cross-block
  content-corruption bug (the unmount save wrote the *new* block's text into the *old*
  draft on a block switch) and confirmed the gap-2 race was real (the write pool has 2
  connections, not a single serialized writer — the "single writer lock" assumption was
  false). #667's and #1071's reviews both independently caught the missing #646 marker
  (the turbofish guard blind spot, now #1188).
- A naive `unsafe-code allowlist` prek hook string-matches the literal
  `#![allow(unsafe_code)]` — a doc comment quoting that token trips it; reword prose to
  avoid the literal.
- A worker-protocol behavior change (resize → `resize` instead of re-`start`) broke two
  pre-existing `useGraphSimulation` tests the targeted review scope missed; the pre-push
  full-suite gate caught them. Reviewers running only touched-file tests can miss
  consumers of a changed contract — the pre-push suite remains the backstop.

## Visual-testing question (maintainer)

Confirmed the repo has strong behavioral (69 e2e) + a11y (242 axe) coverage but **zero**
visual-regression / screenshot testing and no Storybook. Recommended staged adoption
(Playwright `toHaveScreenshot` first, Storybook scoped to leaf primitives) with strict
flake-mitigation. Per maintainer decision: filed #1189/#1190, no code yet.
