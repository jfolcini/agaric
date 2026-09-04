<!-- markdownlint-disable MD060 -->
# CRDT Convergence, Snapshots, Recovery

How persisted state stays consistent across crashes and across peers.

## CRDT convergence (the Loro engine)

Every op application routes through a per-space `LoroEngine` (`src-tauri/agaric-engine/src/loro/`). All op types except `add_attachment` / `delete_attachment` apply via Loro-native CRDT primitives (`LoroTree`, `LoroText`, `LoroMap`, `LoroList`):

- `create_block`, `delete_block`, `restore_block`, `purge_block`, `move_block` → `LoroTree`-modelled hierarchy. Each block is a tree node; its meta map holds `block_id` / `block_type` / `content` (a `LoroText`) / `position` (a legacy `i64` `FIELD_POSITION`) / `deleted_at`. The **parent is the tree structure**, so a reparent (`move_block`) is Loro's convergent move-CRDT and a cycle-forming move is rejected deterministically (`CyclicMoveError`) — replacing the old flat-`LoroMap` + per-key-LWW `parent_id` scalar and its cycle/position edge cases. Soft-delete sets/clears the `deleted_at` meta (the node survives for restore + the SQL descendant-cascade derivation); `purge_block` is `tree.delete`.

  Sibling order **is** the tree's native fractional index (#400). The SQL `ORDER BY position` key is a *derived* dense 1-based rank, re-projected from the engine's child order (`LoroEngine::children_ordered_block_ids`) on every affected parent by `reproject_dense_positions` (`src-tauri/agaric-engine/src/loro/projection.rs`). That re-projection runs **inside the same transaction on both apply paths** — the live local command path and the remote/boot-replay path both route through `apply_op_projected` (#2250 / #2325) — so SQL `position` tracks the engine's converged order at every commit; the old provisional-until-boot-replay window (#1245 / #1257) is closed. A **provisional** rank (`index_to_provisional_position`) survives only as the op-payload breadcrumb and as the write made by the `sql_only` fallback, which has no engine to project from (see [sql-only-convergence.md](sql-only-convergence.md)); boot replay converges it. SQL sibling order is therefore a deterministic function of the converged CRDT tree, not an independently-merged scalar. The `i64` `FIELD_POSITION` meta is written only on the legacy op-replay path.
- `edit_block` (content) → `LoroText` character-level CRDT merge (the block's `content` meta).
- `set_property`, `delete_property` → `LoroMap` per-key writes, storing each value with its **native type** (`LoroValue::Double` / `Bool` / `String`) so engine→SQL re-projection is type-lossless.
- `add_tag`, `remove_tag` → per-block `LoroMap` keyed by the tag's **normalized name** (`tag_norm::normalize_tag_name`; value = the `tag_id` ULID), so concurrent adds of the same tag converge to one entry by per-key LWW (#622, #709 Phase 1). Pre-fix docs may still hold a legacy `LoroList` of tag_ids in the slot — kept in place with read-side dedupe and remove-ALL-occurrences semantics until the #709 Phase-2 re-key.

Concurrent writes from multiple devices converge automatically and deterministically: same inputs → identical final state on every replica. No DAG walk. No resolver. **No user-visible conflict surface.** For the tree, concurrent reparents **and reorders** converge via the move-CRDT (the tree owns sibling rank — SQL `position` is then re-derived from it, see above); for scalar/property/`deleted_at` writes, Loro's internal Lamport ordering picks the winner for concurrent writes to the same `(block_id, key)`; the per-peer monotonic counter is the tiebreaker for same-device replays.

**The block hierarchy is the only mergeable structure that owns its own ordering invariant.** The SQL `parent_id` / `position` / `page_id` columns are *derived* from the engine tree (`parent_id` = the tree parent's `block_id`; `position` = a dense 1-based rank re-derived from the tree's fractional-index child order; `page_id` is a pure SQL/app derivation). Enums (`property_definitions`), validation, and the soft-delete descendant cascade stay in the app + SQL layer — the engine stores only the per-block seed.

**Who owns sibling order, layer by layer (#2464).** Three layers hold an ordering, and each is *derived* from the one below it — none merges positions independently. The engine tree's fractional index is the **merge truth** (concurrent reorders converge here). The SQL `position` dense rank is the **query truth**, re-projected from the engine's child order on every affected parent. The frontend's per-page `blocks` array is the **render truth** between loads: optimistic reorders splice the array and compute target slots from *array order* — the frontend never compares or arithmetics stored `(position, id)` keys to decide placement — and any structural mutation reloads the array from the backend's dense rank. Keeping the derivation strictly one-directional is what lets each layer stay simple: two layers disagreeing about order can only be a stale-derivation bug, never a merge conflict.

**Attachments are out-of-engine.** The file blob lives in the filesystem; only the binding (`block_id` ↔ `attachment_id`) is opped. CRDT-converging file blobs would require content-addressed storage, which is out of scope.

**`block_links` and similar caches are also out-of-engine.** They are derived state, re-parsed from `blocks.content` by the materializer post-commit.

**`device_id → Loro PeerID` mapping.** `loro::peer_id_from_device_id` hashes the device id via `xxh3_64` for cross-toolchain stability. Changing the hash is a wire-format change (the engine state in `loro_doc_state` is keyed by `PeerID`, so the mapping must be deterministic).

### Legacy conflict-merge residue

The legacy three-way merge / conflict-copy model is gone (sessions 697-700):

- `is_conflict`, `conflict_type`, `conflict_source` columns dropped (migrations 0058-0060).
- `merge_parity_log` table dropped (0057).
- `diffy` crate removed.
- `merge::resolve` / `merge::detect` / `merge::types` modules deleted.
- `create_conflict_copy`, `resolve_property_conflict`, `merge_block_text_only` deleted.
- `loro-shadow` Cargo feature retired (Loro is now a hard dep).
- Tauri commands `get_conflicts`, `count_conflicts`, `resolve_conflicts_batch`, `first_op_device_for_blocks` deleted.
- Frontend `ConflictList*` components, the `'conflicts'` nav entry, the `Alt+C` shortcut, the `useConflictCount` polling hook, the sidebar badge, the "Sync completed with conflicts" toast — all deleted.

## Loro state persistence

Per-space Loro state is persisted in `loro_doc_state` (migration 0052) as the encoded `LoroDoc` snapshot. The engine is updated **eagerly on every apply path**: since the apply-path collapse (#2250 / #2325, which closed #1257), the live local command path routes each op through `apply_op_projected` (`src-tauri/agaric-engine/src/apply/kernel.rs`) inside its own `CommandTx` — the same function boot replay and remote-sync apply run — applying the op to the per-space engine *and* the SQL projection in one transaction (the paths differ only in whether they advance the apply cursor; see [data-and-events.md](data-and-events.md) "Apply-cursor semantics"). Engine freshness therefore tracks local writes live; the boot replay remains as an idempotent safety net, not the convergence mechanism. Post-commit, `commit_and_dispatch` enqueues only background SQL cache-rebuild work (including the descendant-cohort fan-out on delete/restore — derived caches, not engine state). The engine serialises its state via `LoroEngine::export_snapshot` (the periodic snapshot task and shutdown path call `loro::snapshot::save_all_engines`).

There are two co-equal materialization targets now: the SQL primary state (`blocks`, `block_properties`, `block_tags`, …) and the Loro engine state. Both derive from the same op log; sync envelopes carry the Loro state, not the SQL projection.

**Engine format version + migration.** The engine has a format version (`loro::engine::ENGINE_FORMAT_VERSION` = 2). Version 1 was the legacy flat-`LoroMap` block model; version 2 is the `LoroTree` hierarchy. The v1→v2 forward-migration (`migrate_flat_blocks_to_tree`) was **retired in #332** once every persisted snapshot had been re-saved as v2: `LoroEngine::import` now **rejects a stray v1 snapshot loudly** via `reject_legacy_v1_snapshot` (`src-tauri/agaric-engine/src/loro/engine/snapshot.rs`) instead of migrating it forward, and a snapshot stamped with a newer format than this build supports is likewise rejected at import (`reject_unknown_format_version`, #1584). A maintainer who encounters a stale v1 vault must open it with a pre-#332 build to migrate the data forward first, then re-open it on current main; `migrate_flat_blocks_to_tree` and `dedupe_block_nodes` no longer exist in the tree.

**Cross-format handshake gate (#2130).** Two peers on different engine formats are kept from merging raw bytes primarily by the sync handshake, not just receiver-side import rejection: `HeadExchange` carries `engine_format_version`, and the responder rejects a non-zero mismatched peer up front (`SyncState::Failed`) before any raw-byte Loro merge (`sync_protocol/session_state_machine.rs`). A legacy peer that omits the field (value `0`) falls through to the import-time guards above as the fallback.

## Snapshots

Snapshots are the durable compaction artifact. They serialise the full SQL primary state into a zstd-compressed CBOR blob keyed by a content hash and a frontier (`{device_id → seq}` per peer). Their live purpose is **op-log compaction**: when the log grows past `DEFAULT_RETENTION_DAYS` (90), a background job emits a snapshot, then deletes ops up to its frontier.

They were also the sync catch-up vehicle. Since **#2503** production catch-up ships **Loro** snapshots that the receiver *merges* into its own engine, and **#3487** deleted the CBOR wipe-and-replace wire path entirely — the iroh cutover made a pre-#2503 peer unable to open a session at all (see [sync-protocol-spec.md](sync-protocol-spec.md) § Snapshot-fallback flow). No sync path reaches the destructive restore described below.

### What's in a snapshot

- All `blocks`, `block_properties`, `block_tags`, `block_links`, `attachments`, `property_definitions`, `page_aliases` rows that survive the frontier (`SnapshotTables` in `src-tauri/agaric-sync/src/snapshot/types.rs`).
- Schema version (a small integer; bumped on schema-breaking migrations to refuse cross-version snapshot apply).

Loro engine state is **not** bundled into the snapshot blob — it lives in the separate `loro_doc_state` table (see § Loro state persistence above) and is restored by the engine's own load path, not by `apply_snapshot`.

**Not in a snapshot:** materialised caches (`tags_cache`, `pages_cache`, `agenda_cache`, `block_tag_inherited`, `projected_agenda_cache`, `fts_blocks`, `block_tag_refs`, `page_link_cache`). `apply_snapshot()` wipes them before restoring core data; the materializer rebuilds them after.

### What a catch-up RESET costs the caught-up device (#2474)

`apply_snapshot()` is the destructive **CBOR** RESET restore. It used to back the pre-#2503 snapshot catch-up; #3487 deleted that wire path (the iroh cutover made a pre-#2503 peer unable to open a session at all), and the current Loro-merge catch-up is non-destructive. It now has **no production caller at all**: disaster recovery reprojects from `loro_doc_state` (`db/recovery.rs`), and compaction only *creates* snapshots. It survives as the read side of the compaction artifact's format, exercised by tests and benches; #4699 asks whether the module should go. The contract below is what that restore costs. In one `BEGIN IMMEDIATE` transaction it wipes the core tables **and** `op_log`, `loro_doc_state`, `loro_sync_inbox`, `log_snapshots`, and `block_drafts`, then re-seeds the core tables from the peer's snapshot:

- **Content converges, the local paper trail does not.** Core-table rows are replaced wholesale by the snapshot's rows — the device's document content ends up equal to the snapshot (pinned by `apply_snapshot_wipes_unsynced_local_ops_and_resets_heads_2474`).
- **Unsynced local ops are LOST.** Any op the device authored *after* the snapshot's frontier is deleted with the rest of `op_log`. Because a sync session only ever pulls data responder → initiator (#610), the reset device never pushes those ops to the peer that offered the snapshot within that same session — true of **both** the heads- and VV-triggered paths (see [sync-protocol-spec.md](sync-protocol-spec.md) § "Fate of the initiator's local state"). Surviving them requires an unrelated, separately-timed reverse-direction session to have already carried them out beforehand. Pinned by `apply_snapshot_wipes_unsynced_local_ops_and_resets_heads_2474`.
- **History, activity feed, and undo/redo reset to empty.** They are all queries over `op_log`; with the log wiped, `get_local_heads` returns no heads and `undo_page_op_inner` returns `NotFound` even for a block that survived in the snapshot (pinned by `apply_snapshot_resets_undo_and_history_surface_2474`). Origin/`is_undo` attribution for pre-reset ops is gone with them.
- **The Loro peer-id epoch is bumped (#792)** so post-reset engines re-key to a fresh `PeerID` and their op counters can restart at 0 without forking the `(peer, counter)` space against pre-reset ops peers still hold (pinned by `apply_snapshot_bumps_peer_epoch_2474`).
- **Loro engines reload EMPTY (#607/#779).** `loro_doc_state` is wiped in the same tx, so the caller's mandatory `reload_registry_from_db` rehydrates nothing — post-reset engines are intentionally empty and import the peer's full CRDT state cleanly on the next session (pinned by `apply_snapshot_wipes_loro_doc_state_and_engines_reload_empty_2474`).
- **Re-apply is not deduped.** Applying the same snapshot blob twice is safe for core-table state (deterministic wipe-then-insert) but is *not* a no-op for the epoch: each apply is an independent RESET and bumps the epoch again (pinned by `applying_the_same_snapshot_twice_is_reapplied_not_deduped_2474`).

All of the above are pinned by tests in `src-tauri/agaric-sync/src/snapshot/tests.rs`.

### Crash-safe write

`create_snapshot` (`src-tauri/agaric-sync/src/snapshot/create.rs`) is two-phase, and the phases hold different locks (#2470):

1. **Collect** — a `DEFERRED` **read** transaction wraps `collect_tables` + `collect_frontier` so every SELECT sees one consistent point-in-time view. Under WAL this holds only a read lock: concurrent writers are *not* blocked while the (potentially large) table scan runs.
2. **Encode** — CBOR + zstd, outside any transaction.
3. **Write** — a brief `BEGIN IMMEDIATE` transaction folds `INSERT INTO log_snapshots (..., status = 'pending')` and `UPDATE ... SET status = 'complete'` together, then commits. The write lock is held only for these two statements, not for the collection phase.

Folding both write statements into one transaction means no other connection ever observes an orphan `pending` row. The only remaining crash window is at the SQLite layer between commit and durable write — boot recovery still deletes any `pending` rows it finds before anything else (step 1 below), so no half-written snapshot is ever applied. (`apply_snapshot`, by contrast, is the one genuinely long write-lock holder — it wipes and restores core tables in a single transaction by design.)

## Crash recovery

Runs once per process (guarded by an `AtomicBool`). Four steps, in order:

1. **Delete pending snapshots.** `DELETE FROM log_snapshots WHERE status = 'pending'`.
2. **Replay unmaterialized ops** (C-2b). Walk `op_log WHERE seq > materializer_apply_cursor.materialized_through_seq`; enqueue each row through the materializer foreground queue; drain via Barrier. The apply-cursor advance is transactional with the apply, so no gap should exist — this is the standing safety net, and (because local writes never advance the cursor) it re-applies the whole prior session's local ops idempotently on every boot.
3. **Reconcile drafts.** Walk `block_drafts`; for each row, emit a synthetic `edit_block` op iff no newer op supersedes it (`src-tauri/agaric-sync/src/recovery/draft_recovery.rs`; `recover_single_draft` only ever constructs `OpPayload::EditBlock` — there is no `create_block` synthesis path). A draft whose block is missing or soft-deleted is dropped as orphan noise rather than recreating the block. Supersession is the **#1256 seq-anchor** check: each draft carries `(draft_anchor_device, draft_anchor_seq)` — the local device's op-log high-water seq at save time (migration 0092) — and is superseded iff a block-scoped `edit_block`/`create_block` op exists with `device_id = draft_anchor_device AND seq > draft_anchor_seq`. This replaced the #384 wall-clock comparison, which a backward clock step (NTP correction) could defeat.
4. **Delete all draft rows.** After reconciliation. Followed by an explicit cache rebuild for any blocks resurrected by step 3.

Per-draft errors are captured in a `RecoveryReport`; a single corrupt draft does not block boot.

**Materializer is constructed before recovery runs**, then passed by reference into `recover_at_boot`. Recovery's foreground enqueues use the constructed materializer.

### Missing-`blocks`-table rebuild is engine-first (#2504)

Separate from the four-step `recover_at_boot` above, `init_pools` runs disaster recovery around the migration step (`src-tauri/src/db/pool.rs`, helpers in `src-tauri/src/db/recovery.rs`):

1. `ensure_blocks_table_exists` **before migrations** — if the `blocks` table is missing (a partial blocks-rebuild migration DROP that was not rolled back, or external corruption), recreate it and replay the op_log into it via `recover_blocks_from_op_log`.
2. `recover_derived_state_from_op_log` after migrations — restores properties/tags a CASCADE would have taken.
3. `reproject_blocks_from_engine` — the authoritative pass. It upserts every block, property and tag out of the per-space Loro snapshots in `loro_doc_state`, overwriting the op-log passes' rows, then rebuilds the visibility-critical caches (`blocks.page_id`, `fts_blocks`, tag inheritance) that the live sync path would normally rebuild via the materializer (which does not exist yet at `init_pools` time).
4. `recover_attachments_from_op_log` **after** the engine pass (#3268) — replays `add_attachment` / `delete_attachment` / `rename_attachment`. `attachments` is not modelled in Loro, so step 3 can neither restore nor repair it, but the rows are FK-guarded on the owning block and a peer-authored block exists only once step 3 has reprojected it; running these arms inside step 2 silently drops every attachment on a peer-authored block, permanently. This last pass is also what retires the `DERIVED_RECOVERY_PENDING_KEY` marker, so a crash anywhere in steps 1–4 retries the whole sequence on the next boot.

The engine pass is what makes this whole-vault rather than device-local. The op_log is strictly device-local (remote ops never land in it post-#490-M1), so steps 1–2 alone reconstruct only locally-authored content — `recover_blocks_from_op_log` logs loudly (`tracing::error!`) when engine snapshots exist and it is about to drop remote content, and step 3 then puts it back. Local ops authored after the last engine snapshot are replayed on top from the op_log tail by the ordinary boot replay.

Steps 2–4 are gated on this boot's block-recovery signal, plus a persisted retry marker (`engine_reproject_pending`, #2920) so a partial engine reprojection is retried on the next boot instead of being lost permanently.

The three-truths boundary is what this ordering encodes: **op log = audit truth (device-local), Loro engine = state truth, SQL = query truth**; only the engine can rebuild whole synced state. Pinned by `recover_blocks_from_op_log_is_device_local_only_2504` and `reproject_blocks_from_engine_no_snapshots_is_noop_2504`.

## What's intentionally NOT crash-safe

- Filesystem-level encryption is the user's responsibility (no SQLCipher; rejected for the overhead and key-management complexity — the SQLite DB lives where the OS encrypts the user's home directory).
- File attachments stored on disk are recovered via OS file system, not via op log replay. A torn write on a 1 GB video file is the OS's problem.
- Index drift in `fts_blocks` is reconciled at materializer boot (the FTS index is a cache; if it's stale, a full rebuild fixes it).
