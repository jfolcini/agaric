# Session 3986 — the one-time engine hydration runs for locally created blocks

`Refs #6525` (box 3, step 4, as the maintainer decided on 2026-11-12; steps 1 to 3, with the
Android suspend save, merged in #6624).

A block can be live in SQL and absent from the engine. The one-time repair that hydrates such
blocks runs again, under marker `repair.engine_missing_live_blocks.v2`, restricted to blocks this
device created itself: a `create_block` op with `is_replicated = 0`. A block a peer authored
arrives through sync; hydrating it here would make a second node for it.

Decisions and traps:

- `hydrate_page_subtree_into_engine` seeds a whole page group, so the restriction is a filter on
  the seed, `SeedRank::Sql { only }`, not on which pages are visited.
- A local block whose parent the engine lacks is skipped: `resolve_parent` would put it at the doc
  root. It is counted in a `warn` line and not retried, because the marker is written once.
- Boot replays the last local op, so an SQL-only create that is the newest op heals itself. A
  fixture for the stuck population needs a later local op.
- The two-device harness's `pull` stores no audit rows. Without `ingest_replicated_record` in the
  fixture the `is_replicated = 0` clause was unpinned and its mutant survived.
- The no-twin test asserts the twin first: after B pulls, B holds Y once. Checked before the pull,
  "Y was not seeded" fired first under every mutant and the twin count was never seen red.
- The stranded-block test ends on the reconciliation oracle's `engine.*` artefacts, empty on both
  devices, with a task state on the child so the property seed is pinned too.

Known limits, for the maintainer:

- A local child under a peer's page the engine still lacks at the upgrade boot stays SQL-only for
  good: it shows on this device only, every later write to it takes the SQL-only fallback, the
  reconciliation report lists it under `engine.blocks.row`, and an engine-first recovery drops it.
  It does not stop the space's outbound sync: the #1257 gate refuses only engine-live, SQL-deleted
  blocks.
- A locally created block whose `create_block` op was compacted away reads as not local. The
  automatic compaction keeps 90 days and this population postdates the first hydration (0.19.0),
  so only a manual compaction with a shorter window can reach it.

Ran: the session-save and #5670 repair tests, each falsification (the twin shown red at 2 nodes),
clippy over the workspace with all targets, the `SQLX_OFFLINE` check, and the workspace nextest.
`just e2e-related` selects no Playwright spec and the whole WebdriverIO lane (`src/repair.rs` has
no area), left to CI.
