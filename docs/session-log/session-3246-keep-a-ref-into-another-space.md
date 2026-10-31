# Session 3246 — keep a ref into another space whichever space syncs first

#6236: a ref property on a block in one space that points at a block in another lost its row on a newly paired device when the holder's space was imported before the target's. The FK guard in `reproject_property_row_from_engine` (#377) dropped the row because the target had no `blocks` row yet. The target's later import never revisited the holder. The sender walks its spaces in `HashMap` order, so it was a coin flip. Engine-first recovery had the same bug: it walks the snapshots by space id.

- `project_dropped_refs` (agaric-engine projection): for each key a space declares `ref`, it reads that space's holders from the engine and re-projects those with no row whose target now has a `blocks` row.
- `LoroEngineRegistry::property_holders` reads a registered engine without creating one or marking it dirty.
- An import runs the pass before commit, but only when it gives some block its first row (`brings_new_block_rows`, asked before Pass A). Healed holders join the changed set, so their pages refresh.
- Engine-first recovery runs it after its last space. When a space's holders don't read, recovery logs, leaves that space's refs dropped and arms the retry marker, as it does for a block whose properties don't read (#2920). A plain `?` there would fail every boot, since recovery runs at pool init. No engine write produces a map that doesn't read, so that arm has no test.
- A default vault declares no `ref` key, so there the pass costs one batched existence probe and one empty SELECT.
- One existing test pinned the old outcome. `a_session_without_the_new_doc_sweeps_the_moved_page_5712` expected B to lose the ref on `notes` after a sweep. The old doc still holds that ref, so it now comes back. The link and the tag stay lost.
- No e2e-tauri spec: the sender's space order is random, so a spec couldn't be shown red on demand. The Rust test runs both orders through the same real commands and `apply_remote`.

**Review.** A separate reviewer re-ran eight mutations, each red at the predicted assertion. It added an assertion that the last import reports the healed holder as changed; nothing had pinned that merge. It fixed stale prose, including the oracle's header table. It also replaced recovery's log-and-skip with a plain `?`, calling that arm unreachable. I restored the log-and-skip: recovery runs inside pool init, so one bad map would stop the app from booting on every start, and its sibling `project_engine_property_defs` skips the same way.

**Found in review:** tags have the same two gaps. A scratch test showed that, with the holder's space imported first, B misses the `block_tags` row and `reconcile_all` reports `engine.block_tags.row`. Engine-first recovery drops the edge to a tag in a later-sorting space. The tag fix is its own PR. Links have no order bug: the cross-space filter in `block_links` keeps them out either way.

**Suites:** full `cargo nextest run --workspace` (both partitions), clippy, the `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, `prek` (both stages); after restoring recovery's skip, clippy and the sync, recovery and #5712 tests.
