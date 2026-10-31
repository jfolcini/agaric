# Session 3244 — hand a contested alias to the next claimant when its holder drops it

#6229: when two pages claimed the same alias, the one with the lower id held the `page_aliases` row and the other kept only its engine-map claim. If the holder then dropped the alias, or was purged, nothing gave the alias to the remaining claimant. The alias stopped resolving on every device, even though a page still claimed it.

- `project_unheld_page_alias_claims` (`agaric-engine` projection) gives each alias that the engines claim and no row holds to its lowest claimant with a `blocks` row, spelled the way that page's map spells it. It skips an alias whose folded key a row already holds, so it cannot hit the `page_aliases` UNIQUE index.
- It runs once per transaction, before commit, on each of the three paths that can leave an alias unheld:
  - `CommandTx::commit_and_dispatch`, when the batch removes an alias or purges a block. Not per op: a respell removes and then re-adds the same key, and a per-op hand-off would give the alias away in between.
  - The import's alias pass (Pass B).
  - The deferred-purge sweep.
- A soft-deleted page still has its `blocks` row, so it keeps its claim. The hand-off happens at purge.
- One existing test, `clearing_a_page_drops_an_alias_it_lost_…` in `page_alias_ops_tests.rs`, pinned the old outcome: after the winner dropped the alias, the loser never showed it. That assertion was the defect. The loser now clears its claim while it is still the loser, which still exercises the `engine_held` branch. The winner's drop then hands it nothing.
- Tests:
  - local remove, purge, sync-import removal and remote purge each have their own `_6229` test;
  - registry and projection units;
  - `e2e-tauri/page-alias-contested-sync.e2e.ts`. The app's page holds an alias, a sync peer's page claims it, the app removes it, and the peer's page takes it. Not run locally (no `tauri-driver`); CI's `e2e-tauri-gate` is its first run.
- The `aliasBadge` selector moved from `page-alias-undo.e2e.ts` into `e2e-tauri/helpers.ts`, unchanged, for the new spec to share.

**Accepted (user-visible):**
- Undoing the removal of an alias that has already been handed on is refused with `DuplicatePageAlias`. The frontend shows its generic toast and drops the undo entry; this is the write path's existing rule.
- The hand-off can give an alias to a claimant in the Trash. That alias then resolves to nothing until the page is purged or restored. It matches the oracle, engine-first recovery and the write path.

**Review.** A separate reviewer re-ran eight mutations, each red at the predicted assertion: each of the three hooks removed, the held-key check removed, the claim sort removed, the `WHERE EXISTS` guard removed, the pass run per op, and the `engine_held` clearing removed. Temporary probes confirmed undo, revert and both bulk purges hand the alias on. The reviewer also corrected two doc comments.

**Suites:** full `cargo nextest run --workspace` (both partitions), clippy, the `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, `npm run typecheck`, `npm run typecheck:e2e-tauri`, `prek` (both stages); after the rebase, the alias, oracle and sync tests.
