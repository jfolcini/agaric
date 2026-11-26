# Session 4479 — a device makes its commits durable before it serves them to a peer

#6524: the pools run `PRAGMA synchronous = NORMAL`, so a committed transaction can sit in the WAL unsynced. If a device serves a peer ops from such a commit and then loses power, it comes back without them. It then re-issues their counters and forks its own lineage on that peer. The maintainer chose durable-before-send.

**The barrier.** `agaric_store::db::make_commits_durable` takes a write turn and commits one page-changing write, a counter in `app_settings` (`sync.durable_barriers`). It does this on a connection of its own with `synchronous = FULL` and `fullfsync = ON`.
- From the bundled SQLite, a FULL commit syncs the whole WAL file. That covers every earlier commit still in it.
- Commits already checkpointed were synced by the checkpoint: the WAL is rewritten only after a full backfill, and the database file is synced before it.
- A commit that changes no page writes no frame and syncs nothing, so the counter is what makes the barrier work.
- The write turn also waits out a transaction that wrote the engine before the export read it.

**Where it runs.** Once per served stream, before anything is queued or sent:
- the responder's main stream (`head_exchange_outgoing_loro`);
- the snapshot catch-up (`try_offer_loro_snapshot_catchup`).

These are the only paths that send this device's ops. The dialler's change round sends heads and `SyncComplete`, attachments send file bytes, and MCP and the mirror send nothing to peers. A failed barrier fails the stream before its first byte.

**Docs.** data-and-events, sync-and-network, sync-protocol-spec and crdt-and-recovery describe the barrier.
- editor-and-content's "power failure loses at most the typing since the last debounce" was wrong under `NORMAL` and is corrected.
- docs/features/sync.md and the FEATURE-MAP Sync row say a power cut loses at most edits no other device had received.
- On the rebase over #7091, both PRs' fixes to the same sentence about undetected own-lineage forks took #7091's wording.

**Review.** An independent review checked the durability argument against SQLite 3.54.1's `walFrames`, `walCheckpoint` and `walRestartLog`. It also re-ran the four call-site reds, and made three changes:
- It deleted an `#[ignore]`d cost harness whose output nothing read.
- It made the catch-up test offer two spaces, so "once per stream" could fail against a barrier run per snapshot.
- It corrected two comments.

**Ran.**
- Reds before the change, with the call sites removed one at a time:
  - `a_served_stream_is_made_durable_once_before_its_first_message_6524`;
  - `a_stream_whose_barrier_fails_is_not_sent_6524`;
  - `a_catchup_offer_is_made_durable_once_6524`;
  - `a_catchup_offer_whose_barrier_fails_sends_nothing_6524`.
- Nine falsifications. Each mutated one of: the connection's `synchronous`, `fullfsync`, the awaited write, the counter increment, the pool's own `synchronous`, the barrier's placement in each path, and each `?`. Each turned its test red.
- `cargo nextest run --workspace` over sync, store, snapshot and durability tests, before the rebase and again after it.
- `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo fmt --all --check`, and `just gen-sqlx` (one new cache entry).

**Not tested.** Whether the bytes reach the disk: only a power cut shows it. The tests pin what SQLite is asked for and that a failed barrier sends nothing.
