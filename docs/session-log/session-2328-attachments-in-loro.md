# Session 2328 — Attachment metadata lives in the Loro engine and reaches peers

#5608 (severity high): attachments never reached the other device, with no
row and no bytes. The maintainer chose option (b), attachment metadata in
Loro with an engine format bump. They approved the design's points:
- the `block_attachments` root, nested per block;
- `ENGINE_FORMAT_VERSION` 3 → 4;
- `content_hash` on the add payload, the only part of #4955 taken; iroh-blobs
  is deferred;
- undo of a delete reading an add op of either provenance;
- `fs_path` naming the stored path after dedup.

This covers design steps 1–5, built on #5647's branch for its shared registry
probe. The PR is held for the maintainer's review.

1. **Engine model** (`loro/engine/attachments.rs`). Block → attachment id →
   fields, both levels mergeable maps. A delete is a `deleted_at` tombstone,
   because removing a key would let a later `ensure` resurrect a mergeable
   child. Purge drops the block's map. There are 13 unit tests and a
   three-peer convergence proptest (also run at 20,000 cases).
2. **Writes, undo and replay** go through `apply_*_attachment_via_loro` in the
   kernel, `merge::dispatch_engine_op`, the three commands and the undo
   arms. `find_attachment_block` shares #5647's `spaces_containing`. Undo
   read only local add ops (`is_replicated = 0`); that filter is dropped in
   the delete reverse and, as found here, in history's three positional-undo
   queries and the batch reverse. With it, Ctrl+Z skipped a peer
   attachment's delete and undid an earlier op instead. Until step 6, the
   row's `content_hash` is written by one `UPDATE` after projecting.
3. **Peers.** The import projection writes attachment rows from the engine.
   The new root is classified per block, and the format version is now 4.
   The #5608 loopback test (real QUIC) covers add with B's bytes equal to
   A's, rename, delete, and delete against a concurrent rename. Without the
   projection, B ends with no rows: the issue's own symptom.
4. **Existing vaults.** `hydrate_attachments_into_engine`, the sixth boot
   repair, writes no ops. It runs after #5670's one-shot engine hydration,
   which would otherwise seed whole a space whose engine the backfill
   created. Seeding a page into a space carries its attachments and
   tombstones any old entry that has no row.
5. **Disaster recovery** restores attachment rows from the engine.
   `recover_attachments_from_op_log` replays only ids no engine holds.

Each step's tests went red first at the predicted assertion.

**Found, not fixed here.** A peer sometimes loses a cross-space-moved page's
blocks from SQL, depending on which space's doc it imports first. It
reproduced in 1 of 4 runs with no attachment ops and is filed separately.
Because of it, the design's peer-side "there and back" test is left out; the
single-device one stays. Also known: a page that returns to a space with no
attachments brings its old deleted entries back live on a later add. Page
aliases share this gap.

**Remaining:**
- step 6: `content_hash` on the op and the receiver's check;
- step 7: an attachments arm in the reconciliation oracle;
- step 8: e2e peer commands and spec (#5365's image-bytes scenario), the
  version-mismatch message, and docs.

Gates: `just gen-sqlx` (root, engine and sync caches), fmt,
`SQLX_OFFLINE=true cargo check`, clippy, and the full workspace suite (3,512
+ 3,504); the bindings drift test passed. Docs this made false
(`crdt-and-recovery.md`, `data-and-events.md`, one line of
`commands/AGENTS.md`) are corrected.
