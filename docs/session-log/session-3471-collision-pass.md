# Session 3471 — The collision pass: a sync twin's later page renamed, a later tag merged (#6278 I3)

Item I3 of #6278, on top of I1 (#6318) and I2 (#6345). `repair::name_collisions` runs at boot, after the `Repair::OPS` loop in `repair_unreachable_content_at_boot`, and after each sync session that changed something, through `repair::repair_after_sync` from `SpacePlacementSink::on_sync_event`, which also merges journal duplicates after sync now.

- Peer rule: only the device whose Loro peer minted the later node acts (`LoroEngine::created_here` / `LoroEngineRegistry::created_here`, a read that creates no engine). Every write-path engine is built with `with_peer_id_epoch`; a node minted under a retired pre-reset peer belongs to no device, so its tie stays and I2 resolves it.
- Pages: one transaction per space renames each later page of a `name_key` tie to the first free `Title (n)` with an ordinary `EditBlock` under `Actor::Housekeeping`; journal titles are never renamed. A `pages:renamed` event drives an i18n toast (`usePageRenameNotices`); boot renames show none, History lists them.
- Tags: the later tag's holders get the keeper and lose the later tag, `#[LATER]` referrers are rewritten to `#[KEEPER]`, then the later tag is deleted, in chunks of `TAG_MERGE_CHUNK` with engine rollback armed; each transaction re-reads the tie, so a stale or racing run is a no-op.
- Review found that a tag held or named from another space (an edge #6245 keeps) failed its merge and logged an error on every pass; such a tie is now left whole (`used_outside_its_space`). A three-device re-tie on `Foo (2)` can still give `Foo (2) (2)`: stripping a trailing `(n)` cannot be told from a user's own `Report (2024)`, so the doubled suffix is the lesser wart (comment in `first_free_title`).
- No new table, op type, store, queue, sync message or format bump.
- The branch carried the pre-squash I1 and I2 commits; it was rebuilt on main by cherry-picking I3's two commits, which left only docs and one test-module conflict.
- `e2e-tauri/page-name-tie-sync.e2e.ts` could not run in the container (no tauri-driver or WebKitWebDriver); CI's real-backend lane is its first run.

Suites run on the final base: `SQLX_OFFLINE` check, targeted nextest over name_collisions, repair, spaces, sync events, the registry and the commands binary, clippy, vitest over hooks, i18n, `src/__tests__` and `e2e-tauri`, typecheck and `typecheck:e2e-tauri`; the review also ran the full workspace suite, `prek` (all and manual) and eight falsifications.
