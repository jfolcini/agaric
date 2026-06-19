<!-- markdownlint-disable MD060 -->
# CRDT Convergence, Snapshots, Recovery

How persisted state stays consistent across crashes and across peers.

## CRDT convergence (the Loro engine)

Every op application routes through a per-space `LoroEngine` (`src-tauri/src/loro/`). All op types except `add_attachment` / `delete_attachment` apply via Loro-native CRDT primitives (`LoroTree`, `LoroText`, `LoroMap`, `LoroList`):

- `create_block`, `delete_block`, `restore_block`, `purge_block`, `move_block` → `LoroTree`-modelled hierarchy. Each block is a tree node; its meta map holds `block_id` / `block_type` / `content` (a `LoroText`) / `position` (a legacy `i64` `FIELD_POSITION`, see below) / `deleted_at`. The **parent is the tree structure**, so a reparent (`move_block`) is Loro's convergent move-CRDT and a cycle-forming move is rejected deterministically (`CyclicMoveError`) — replacing the old flat-`LoroMap` + per-key-LWW `parent_id` scalar and its documented cycle/position edge cases. Soft-delete sets/clears the `deleted_at` meta (the node survives for restore + the SQL descendant-cascade derivation); `purge_block` is `tree.delete`. Sibling order **is** the tree's native fractional index (#400): the SQL `ORDER BY position` key is a *derived* dense 1-based rank, re-projected from the engine's child order (`LoroEngine::children_ordered_block_ids`) on every affected parent by `reproject_dense_positions` (`src-tauri/src/loro/projection.rs`). This re-projection runs on the engine-apply path; on the live local command path a `create` / `move` instead writes a **provisional** dense rank (`index_to_provisional_position`) and the engine-derived order is reconciled only on the next boot replay, so within a session the SQL `position` can transiently disagree with the converged order (#1245 / #1249). After settle/replay, SQL sibling order is a deterministic function of the converged CRDT tree, not an independently-merged scalar; the pagination cursors and frontend position arithmetic read this derived rank. The `i64` `FIELD_POSITION` meta is written only on the legacy op-replay path.
- `edit_block` (content) → `LoroText` character-level CRDT merge (the block's `content` meta).
- `set_property`, `delete_property` → `LoroMap` per-key writes, storing each value with its **native type** (`LoroValue::Double` / `Bool` / `String`) so engine→SQL re-projection is type-lossless.
- `add_tag`, `remove_tag` → per-block `LoroMap` keyed by the tag's **normalized name** (`tag_norm::normalize_tag_name`; value = the `tag_id` ULID), so concurrent adds of the same tag converge to one entry by per-key LWW (#622, #709 Phase 1). Pre-fix docs may still hold a legacy `LoroList` of tag_ids in the slot — kept in place with read-side dedupe and remove-ALL-occurrences semantics until the #709 Phase-2 re-key.

Concurrent writes from multiple devices converge automatically and deterministically: same inputs → identical final state on every replica. No DAG walk. No resolver. **No user-visible conflict surface.** For the tree, concurrent reparents **and reorders** converge via the move-CRDT (the tree owns sibling rank — SQL `position` is then re-derived from it, see above); for scalar/property/`deleted_at` writes, Loro's internal Lamport ordering picks the winner for concurrent writes to the same `(block_id, key)`; the per-peer monotonic counter is the tiebreaker for same-device replays.

**The block hierarchy is the only mergeable structure that owns its own ordering invariant.** The SQL `parent_id` / `position` / `page_id` columns are *derived* from the engine tree (`parent_id` = the tree parent's `block_id`; `position` = a dense 1-based rank re-derived from the tree's fractional-index child order; `page_id` is a pure SQL/app derivation) — realised on the engine-apply path; the live local command path writes `position` provisionally until the next boot replay reconciles it (#1245 / #1257). Enums (`property_definitions`), validation, and the soft-delete descendant cascade stay in the app + SQL layer — the engine stores only the per-block seed.

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

Per-space Loro state is persisted in `loro_doc_state` (migration 0052) as the encoded `LoroDoc` snapshot. The engine is updated through the **foreground engine-apply path** (`apply_op` / `BatchApplyOps`), which runs on boot replay, remote-sync apply, and the snapshot-transfer helper — **not** on the live local command path. There, `CommandTx::commit_and_dispatch` materialises SQL synchronously and its post-commit dispatch enqueues only background SQL cache-rebuild tasks (never an `ApplyOp`), so the engine is brought current on the next boot's (idempotent) replay. Engine freshness is therefore currently coupled to op-log replay rather than to local writes — see [data-and-events.md](data-and-events.md) "Apply-cursor semantics" and the `apply_create_block_via_loro` "Atomic semantics" note in `materializer/handlers/loro_apply.rs`; eager local engine-apply is tracked in #1257 and the apply-cursor semantics in #1248. (A consequence: the post-commit descendant-cohort fan-out on delete/restore also leaves SQL transiently ahead of the engine until replay — accepted because re-apply is idempotent.) The engine serialises its state via `LoroEngine::export_snapshot` (the periodic snapshot task and shutdown path call `loro::snapshot::save_all_engines`).

There are two co-equal materialization targets now: the SQL primary state (`blocks`, `block_properties`, `block_tags`, …) and the Loro engine state. Both derive from the same op log; sync envelopes carry the Loro state, not the SQL projection.

**Engine format version + migration.** The engine has a format version (`loro::engine::ENGINE_FORMAT_VERSION` = 2). Version 1 was the legacy flat-`LoroMap` block model; version 2 is the `LoroTree` hierarchy. A persisted v1 snapshot is migrated forward **in place** on load: `LoroEngine::import` runs `migrate_flat_blocks_to_tree`, which reads the legacy flat map, rebuilds the tree (preserving `parent_id` / `position` / `deleted_at`, dangling parents landing at the tree root), clears the legacy root, and rebuilds the `block_id → TreeID` index. It is **idempotent** — a no-op once the legacy root is empty — so it runs unconditionally on every import rather than gating on a stored version byte; the next periodic snapshot persists the v2 form. `block_properties` and `block_tags` roots are untouched by the migration (only the hierarchy moves); block content is re-seeded as a fresh `LoroText` (the op log remains the canonical replay source for fine-grained edit history).

**Cross-peer migration convergence.** Loro mints tree-node identity (`TreeID`) from the local peer, not from the domain `block_id`, so two already-synced peers that each migrate the *same* v1 snapshot independently create divergent nodes for the same `block_id` that both survive a later merge. `LoroEngine::import` converges this with `dedupe_block_nodes` — a deterministic post-import pass that keeps the `min` `TreeID` per `block_id` (every peer computes the identical survivor set), reparents survivors under their parent-block's survivor, and deletes the losers — so a v1→v2 rollout across synced devices is safe. A future protocol-version handshake may additionally gate raw-byte merges across *different* formats.

## Snapshots

Snapshots are the durable compaction artifact. They serialise the full SQL primary state into a zstd-compressed CBOR blob keyed by a content hash and a frontier (`{device_id → seq}` per peer). Used for:

1. **Op-log compaction.** When the log grows past 90 days (default), a background job emits a snapshot, then deletes ops up to the snapshot's frontier.
2. **Sync catch-up.** A peer joining or re-joining can request a snapshot instead of replaying the full log (see [sync-and-network.md](sync-and-network.md)).

### What's in a snapshot

- All `blocks`, `block_properties`, `block_tags`, `block_links`, `attachments`, `property_definitions`, `page_aliases` rows that survive the frontier (`SnapshotTables` in `src-tauri/src/snapshot/types.rs`).
- Schema version (a small integer; bumped on schema-breaking migrations to refuse cross-version snapshot apply).

Loro engine state is **not** bundled into the snapshot blob — it lives in the separate `loro_doc_state` table (see § Loro state persistence above) and is restored by the engine's own load path, not by `apply_snapshot`.

**Not in a snapshot:** materialised caches (`tags_cache`, `pages_cache`, `agenda_cache`, `block_tag_inherited`, `projected_agenda_cache`, `fts_blocks`, `block_tag_refs`, `page_link_cache`). `apply_snapshot()` wipes them before restoring core data; the materializer rebuilds them after.

### Crash-safe write

The compactor writes snapshots inside a single `BEGIN IMMEDIATE` transaction (`src-tauri/src/snapshot/create.rs`):

1. `INSERT INTO log_snapshots (..., status = 'pending') VALUES (...)`. Body bytes go to the row.
2. `UPDATE log_snapshots SET status = 'complete' WHERE id = ?`.
3. `tx.commit()`.

Folding both statements into one transaction (M-69) means no other connection ever observes an orphan `pending` row. The only remaining crash window is at the SQLite layer between commit and durable write — boot recovery still deletes any `pending` rows it finds before anything else (step 1 below), so no half-written snapshot is ever applied.

## Crash recovery

Runs once per process (guarded by an `AtomicBool`). Four steps, in order:

1. **Delete pending snapshots.** `DELETE FROM log_snapshots WHERE status = 'pending'`.
2. **Replay unmaterialized ops** (C-2b). Walk `op_log WHERE seq > materializer_apply_cursor.materialized_through_seq`; enqueue each row through the materializer foreground queue; drain via Barrier. Necessary because the apply-cursor advance is transactional with the apply itself, but a process kill between the op_log write and the cursor write would leave a gap (it doesn't today — they're one transaction — but recovery is the safety net).
3. **Reconcile drafts.** Walk `block_drafts`; for each row, emit a synthetic `edit_block` or `create_block` op iff no newer matching op supersedes the draft in `op_log` (`src-tauri/src/recovery/draft_recovery.rs`). Both `op_log.created_at` and `block_drafts.updated_at` are INTEGER epoch-ms from `now_ms()` (migrations 0079 / 0082), compared **numerically**: an op with `created_at` strictly after the draft supersedes it, and a same-ms op supersedes only when its resulting content *differs* from the draft (content-provenance disambiguation, #384). This survives clock skew and same-millisecond writes — there is no reliance on lexicographic string ordering.
4. **Delete all draft rows.** After reconciliation. Followed by an explicit cache rebuild for any blocks resurrected by step 3.

Per-draft errors are captured in a `RecoveryReport`; a single corrupt draft does not block boot.

**Materializer is constructed before recovery runs**, then passed by reference into `recover_at_boot`. Recovery's foreground enqueues use the constructed materializer.

## What's intentionally NOT crash-safe

- Filesystem-level encryption is the user's responsibility (no SQLCipher; rejected for the overhead and key-management complexity — the SQLite DB lives where the OS encrypts the user's home directory).
- File attachments stored on disk are recovered via OS file system, not via op log replay. A torn write on a 1 GB video file is the OS's problem.
- Index drift in `fts_blocks` is reconciled at materializer boot (the FTS index is a cache; if it's stale, a full rebuild fixes it).
