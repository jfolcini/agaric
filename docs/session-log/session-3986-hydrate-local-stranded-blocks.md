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

Known limits, raised with the maintainer:

- A local child under a peer's page still missing at the upgrade boot stays SQL-only.
- A locally created block whose `create_block` op was compacted away reads as not local.

Ran: the #6525, #5670, #5712, session-save and repair tests, and clippy over the workspace. The
whole workspace suite was left to review and CI.
