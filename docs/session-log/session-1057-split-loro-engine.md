# Session 1057 — #1262: split the 4532-line loro/engine.rs god-file

2026-06-16. From the 2026-06 Opus quality audit (maintainability). `/loop /batch-issues` run.
Behavior-preserving module split — zero behavior change.

## Change
`loro/engine.rs` (4532 lines; one `LoroEngine` impl mixing tree mechanics, op application,
reads, legacy migration, snapshot I/O, sync-update generation) → `loro/engine/mod.rs` +
6 cohesive submodules, each an `impl LoroEngine` block (`use super::*`):
- `tree.rs` — tree mechanics, block_id↔TreeID index, pending-parent reconciler, sibling order.
- `migration.rs` — the one-time pre-#400 legacy sibling-order migration (isolated).
- `apply.rs` — all `apply_*` op handlers + `create_block_impl`/`move_block_impl`/tag keying.
- `reads.rs` — `read_*_typed` getters, child walk, alive-count.
- `snapshot.rs` — import/export/snapshot I/O + `reject_legacy_v1_snapshot`.
- `sync.rs` — version-vector / `export_update_since` / sync-update generation.

`mod.rs` keeps the struct, all consts (`ENGINE_FORMAT_VERSION`, roots, FIELD_*), the
`PropertyValue`/`BlockSnapshot` types, the 14 free helpers, the core impl + constructors,
`impl Default`, and all 5 `#[cfg(test)]` modules — verbatim.

## Pure-move guarantees
Every one of the 41 `impl LoroEngine` methods is byte-for-byte identical to the original
(reviewer reconstructed from `git show HEAD` + brace-balanced diff — all verbatim, no logic
edited). Visibility: 29/30 cross-sibling private methods → `pub(super)` (module-internal);
`pub`/`pub(crate)` surface unchanged; `init_sibling_ordering` correctly stayed private.
One doc citation repointed (`data-and-events.md` → `engine/mod.rs`).

## Verification
Reviewer accounted for every method (41, no drop/dup), confirmed verbatim bodies + minimal
visibility, doc-citations guard passes. Full Rust suite 4188 passed (incl. the 70
`loro::engine` tests + proptests — the behavior oracle); clippy clean.
