# Session 2091 — Page aliases are ops, undoable and synced like tags

Aliases used to live only in `page_aliases`, written in place with no op, so
they could not be undone and never reached another device. Two op types,
`AddPageAlias` and `RemovePageAlias`, now carry every alias change (approved on
#5387). They go through the op log and one new Loro root, `page_aliases`, per
page; SQL is a projection of it. `ENGINE_FORMAT_VERSION` is 3, so a peer still
on 2 is refused at the handshake instead of receiving ops it cannot apply.
Page-level undo inverts them, history lists them, and a one-time backfill at
boot (`repair_page_aliases`, idempotent, as housekeeping) turns each device's
legacy rows into engine state.

Review found three defects, each fixed with a test shown red first:

- A contested alias (two devices claim one alias for different pages offline,
  most likely through each device's legacy backfill) converged in the engine
  but projected to different pages on each device. Reprojection now gives it to
  the lowest page id, an `EXISTS`-guarded eviction; forward projection keeps
  first-claim so a replayed old op never takes a row from a newer one. The
  issue said "first page by op order"; the engine has no cross-page order. A
  two-device real-socket test pins it.
- A peer's alias ops were indexed with `op_log.block_id = NULL` because the
  payload carries `page_id`, so page history never listed them on the
  receiving device. `extract_indexed_ids_from_payload` falls back to `page_id`.
- A cross-space page move dropped the page's aliases from the new space's doc;
  hydration now seeds them.

`src-tauri/migrations/AGENTS.md` said aliases have no op-log entries; it now
says `page_aliases` is a projection of the engine root that only disaster
recovery reprojects, not boot (maintainer approval in this session). The same
claim was aligned in `prek.toml` and `db/tests.rs`.

Gates: whole-workspace nextest (6868 run, 0 failed, 8 partitions), clippy,
`SQLX_OFFLINE=true cargo check --workspace --all-targets`, `just gen-sqlx`
(one new entry for the eviction in the root, engine and sync caches),
bindings unchanged, conformance fixtures reproduced, vitest on the touched
frontend and the mock, `npm run typecheck`. Not run here: the e2e-tauri
alias-undo spec, which needs the real backend lane.
