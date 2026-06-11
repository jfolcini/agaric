# Session 1008 — #139 space-filter drift guard (maintainer-approved slice)

## Shipped

- **`tooling(prek)` #139** — the maintainer-approved *actionable slice* of MAINT-172: a cheap
  prek **drift-guard** for the inlined `(?N IS NULL OR b.space_id = ?N)` space-filter fragment
  (duplicated across ~15 pagination/backlink/fts/commands files), plus deletion of the stale
  pre-#533 prose that still described the OLD `block_properties(key='space')` form. The full
  build.rs/`include_str!` consolidation stays **deferred** (maintainer decision; gated on the
  untouched sqlx#3388) — no live SQL or query plans changed.

  **`scripts/check-space-filter-drift.py`** (mirrors the existing test-time
  `space_filter_canonical.rs` parity module, now enforced at commit time):
  - **Rule A (shape):** every guarded `(?A IS NULL OR b.space_id = ?B)` must have `A == B` and
    the exact `b.space_id` column — catches a mismatched bind index or wrong column.
  - **Rule B (per-file baseline, `src-tauri/space-filter-baseline.txt`):** counts the canonical
    guard per file; a drop means a guard was removed or degraded to a bare `b.space_id = ?N`.
    Needed because bare `b.space_id = ?` is *legitimate* at ~10 single-space sites — a pure text
    scan would false-positive. Re-anchor with `--update-baseline`.
  - `history.rs` is a natural exception (its op-log filter is `... space_id = ?N` with no `b.`
    alias, so the `b.space_id` regex never matches it). Registered in `prek.toml` (pre-commit +
    pre-push, `^src-tauri/src/.*\.rs$`), `validate-config` passes.
  - Probe-verified: clean tree exit 0; dropped-guard → exit 1 (Rule B); param-mismatch → exit 1
    (Rule A); restored → exit 0.

  **Stale comments fixed** (comments only): `pagination/mod.rs` canonical doc block,
  `fts/search.rs`, `backlink/grouped.rs`, `commands/{agenda,queries,blocks/queries,pages/aliases,
  journal,tags}.rs`, `filters/primitive.rs`, and the `space_filter_canonical.rs` scope table —
  all repointed from the old `block_properties(key='space')` sub-select to `b.space_id`.
  Historical "retired/no longer read" comments and the move-write-op comment were correctly left
  intact. Closes #139 (actionable slice; consolidation tracked-deferred).

## Backlog state
Remaining actionable arch: #882 (tx-core extraction). Gated/deferred: #709 (tag re-key plan),
#877 (component migration), #645-core (Option C), #644 deep slices, #139 consolidation
(sqlx#3388). #833 (docs CI fast-path) flagged for maintainer (strict-gate surgery).
