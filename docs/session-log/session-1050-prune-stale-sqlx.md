# Session 1050 — chore #1292: prune stale .sqlx offline-cache entries

2026-06-16. Filed during the #1253 review (orphaned gcal `.sqlx` entries). `/loop /batch-issues` run.

## Change
Regenerated `src-tauri/.sqlx` against a fully-migrated dev DB (91/91 migrations, verified
via `sqlx migrate info`; `migrate run` was a no-op) with `cargo sqlx prepare -- --tests`.
Result: **45 stale cache files removed** (578 → 533), 0 modified, 0 new.

The 45 break down as: **21 gcal orphans** (the #1292 target, from the gcal removal) + **24
non-gcal orphans** from a prior `purge_subtree_tables` refactor (commit `8b9ffc69`) whose
query text no longer exists in source. `cargo sqlx prepare --check` is all-or-nothing, so
the full prune ships together — you cannot drop only the gcal subset and leave the other
24 orphans (the check would then fail).

## Safety
All 45 verified genuinely dead: each deleted entry's query string is absent from `src/`
(grep), `cargo sqlx prepare --check -- --tests` passes, `SQLX_OFFLINE=true cargo check
--tests` compiles, and **0 new entries** appeared — so no live query lost its cache (the
#1253 stale-DB footgun was explicitly avoided: the DB was fully migrated first). Only
`src-tauri/.sqlx/` changed; no source, no behavior.
