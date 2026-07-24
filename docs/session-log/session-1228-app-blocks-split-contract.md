# Session 1228 — App blocks writes behind engine primitives (#2895 slice 2)

**Issue:** #2895 (slice 2 — split contract)

## What

The app crate's 13 non-recovery raw `blocks` writes (crud delete/restore, history
undo arms, draft recovery, soft-delete trash/restore) moved byte-identically behind
8 new `agaric_engine::block_ops` primitives:

- `CohortDeletedAt` enum (`Stamp` / `ClearWhereRef` / `ClearAll`) +
  `write_cohort_deleted_at_json` — the three cohort deleted_at shapes as one
  predicate-mapped writer.
- `reparent_active_block`, `set_active_block_content` (deleted_at-guarded),
  `set_block_content` (unguarded, draft recovery), `clear_all_deleted_at`,
  `rebuild_all_page_ids`, `restore_cohort_subtree` (cohort CTE),
  `cascade_soft_delete_subtree` (recursive CTE).

All take the caller's `&mut SqliteConnection` — no nested tx, no Pool. All are
runtime `sqlx::query` with `// dynamic-sql:` markers, so the per-crate offline
cache class (#3111/#3112) is structurally impossible here.

## Decisions honored (maintainer-approved)

- **Split contract:** engine owns Loro→SQL projection writes; store's 10 physical
  primitives stay owner-adjacent (annotated).
- **Recovery carve-out:** `src/db/recovery.rs` untouched (zero diff) — 12 boot-time
  repair writes remain annotated, incl. the #2043 INTENTIONALLY DIVERGENT restore.

## Review (adversarial, independent agent): SHIP, zero fixes

- CohortDeletedAt branch mapping audited variant-by-variant: predicates, call
  sites, and binds all match the pre-move originals byte-for-byte; `ClearAll`
  correctly omits the timestamp bind.
- Guarded vs unguarded content writers correctly split; reparent bind order
  reproduces the original `query!` order incl. `Option<&str>` parent.
- rows_affected rewiring preserved at all 8 consumers (undo NotFound guards,
  idempotent-restore warn path, counts).
- Carve-out honesty verified: exactly 12 real blocks-writes in recovery.rs;
  baseline annotation accurate.
- `recovery_kernel_parity` 8/8; affected modules 357/358 (1 pre-existing
  #317-class timing flake, passes in isolation); clippy clean; `--update-baseline`
  round-trip byte-identical.

## Baseline

App blocks 25→12 (`12 app blocks  # recovery carve-out: boot-time repair writes
(pre-engine, corrupt-DB tolerant)`); annotations preserved.

## Verification

Post-rebase (over the #2897 shim-removal merge, restore.rs paths re-ported):
`SQLX_OFFLINE=true cargo check --workspace --all-targets` clean; 304/304 targeted
nextest; ownership + dynamic-sql + raw-tx guards pass.
