<!-- markdownlint-disable MD060 -->
# CRDT Convergence, Snapshots, Recovery

How persisted state stays consistent across crashes and across peers.

## CRDT convergence (the Loro engine)

Every op application routes through a per-space `LoroEngine` (`src-tauri/src/loro/`). All op types except `add_attachment` / `delete_attachment` apply via Loro-native CRDT primitives (`LoroMap`, `LoroText`, `LoroList`):

- `create_block`, `delete_block`, `restore_block`, `purge_block`, `move_block` → `LoroTree`-modelled hierarchy.
- `edit_block` (content) → `LoroText` character-level CRDT merge.
- `set_property`, `delete_property` → `LoroMap` per-key writes.
- `add_tag`, `remove_tag` → `LoroList` adds/removes per-block.

Concurrent writes from multiple devices converge automatically and deterministically: same inputs → identical final state on every replica. No DAG walk. No resolver. **No user-visible conflict surface.** Loro's internal Lamport ordering picks the winner for concurrent writes to the same `(block_id, key)`; the per-peer monotonic counter is the tiebreaker for same-device replays.

**Attachments are out-of-engine.** The file blob lives in the filesystem; only the binding (`block_id` ↔ `attachment_id`) is opped. CRDT-converging file blobs would require content-addressed storage, which is out of scope.

**`block_links` and similar caches are also out-of-engine.** They are derived state, re-parsed from `blocks.content` by the materializer post-commit.

**`device_id → Loro PeerID` mapping.** `loro::peer_id_from_device_id` hashes the device id via `xxh3_64` for cross-toolchain stability. Changing the hash is a wire-format change (the engine state in `loro_doc_state` is keyed by `PeerID`, so the mapping must be deterministic).

### PEND-09 residue

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

Per-space Loro state is persisted in `loro_doc_state` (migration 0052) as the encoded `LoroDoc` snapshot. The materializer dispatches into the engine post-commit; the engine persists its state via `LoroEngine::flush`.

There are two co-equal materialization targets now: the SQL primary state (`blocks`, `block_properties`, `block_tags`, …) and the Loro engine state. Both derive from the same op log; sync envelopes carry the Loro state, not the SQL projection.

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
3. **Reconcile drafts.** Walk `block_drafts`; for each row, emit a synthetic `edit_block` or `create_block` op iff no newer matching op exists in `op_log` after the draft's `updated_at` (strict comparator relies on the millisecond-precision `Z`-suffix lex-monotonic invariant of `now_rfc3339()`).
4. **Delete all draft rows.** After reconciliation. Followed by an explicit cache rebuild for any blocks resurrected by step 3.

Per-draft errors are captured in a `RecoveryReport`; a single corrupt draft does not block boot.

**Materializer is constructed before recovery runs**, then passed by reference into `recover_at_boot`. Recovery's foreground enqueues use the constructed materializer.

## What's intentionally NOT crash-safe

- Filesystem-level encryption is the user's responsibility (no SQLCipher; rejected for the overhead and key-management complexity — the SQLite DB lives where the OS encrypts the user's home directory).
- File attachments stored on disk are recovered via OS file system, not via op log replay. A torn write on a 1 GB video file is the OS's problem.
- Index drift in `fts_blocks` is reconciled at materializer boot (the FTS index is a cache; if it's stale, a full rebuild fixes it).
