# Session 3228 — the oracle checks block_tags, page_aliases and the spaces registry

#6207: three tables projected from engine or block state had no consistency check. Each is now rebuilt in Rust from its source, sharing no code with the projection it audits.

- **`engine.block_tags.row`** compares each space doc's tag map with `block_tags`. Only blocks that both the engine and `blocks` hold are compared, because `diff_engine_membership` already reports the rest. Engine tag ids with no `blocks` row are dropped first: a purge leaves the id in other blocks' tag maps, and the reprojection skips it with an `EXISTS` guard.
- **`engine.page_aliases.row`** groups each held page's alias claims by `trim().to_ascii_lowercase()` (the engine's key, which also matches `COLLATE NOCASE`). The lowest page id wins, spelled as its own map holds it. Keys carry ids only; the alias text sits in `expected`/`actual`, which the integrity report drops.
- **`spaces.row`** expects every block with an `is_space = 'true'` row, soft-deleted ones included (migration 0089 keeps the row). The trigger writes the registry in the same transaction as the property, so this check joins the per-op gate `reconcile` as well as `reconcile_all`.
- `apply_reproject_proptest` (B2–B6) and the four crash-injection tests end with the three checks green. Tags reach B5 and B6 through generated ops. No proptest generates alias ops, so only the unit tests exercise the alias check.
- `bl_register_space` and `seed_space_row` now register a space through its `is_space` row. The old fixtures inserted into `spaces` directly, a state production never reaches.

**Traps.**
- A registry row whose `is_space` flag was deleted would read as an extra row. The reviewer traced every path (frontend, MCP's space guard, Edit as Markdown, history scope, space moves, delete space, repairs, import) and found none that deletes the flag, so the extra direction stays. Its owner string says so.
- The new alias check found a real defect, filed as #6229. When the holder of a contested alias drops it, or is purged, the alias is not handed to the next claimant. Two throwaway probes confirmed it.

**Review.** A separate reviewer re-ran three of the reds: a dropped tag insert, the 0089 trigger disabled, and the oracle's purged-tag filter removed. It fixed two stale comments and an assertion message that counted entries, and judged the added engine reads constant-time per block.

**Suites:** full `cargo nextest run --workspace` (both partitions), clippy `--all-targets`, `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, `prek run --all-files` and the manual stage. `just e2e-related` selected no Playwright spec and the whole WebdriverIO lane, which is left to CI.
