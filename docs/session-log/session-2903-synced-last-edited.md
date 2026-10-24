# Session 2903 — a peer's ops raise their page's last-edited time

#6048. On a device that received blocks by sync, "Recently modified" listed the page by its older time, and App health reported `pages_cache.last_edited_ms` as diverged. The issue traced one cause; there were two.

**The raise never ran on sync.**
- `dag::ingest_remote_record` raised the page through `record.block_id`. That is a sidecar `From<OpTransfer>` always leaves `None`, so no synced op raised any page.
- The dag unit test passed only because its fixture filled the sidecar.
- The raise now takes the block from the payload with `extract_indexed_ids_from_payload`, as `op_log.block_id` does. That matches the local raise op for op.

**`page_id` lagged the raise.**
- The engine projection inserts a synced non-page block with `page_id` NULL, and a moved block keeps its stale one. `RebuildPageIds` fixes both, but behind the inbound debounce, and `flush()` never fired that debounce.
- `complete_pull_session` now calls `fire_pending_inbound_rebuild()` (on `ApplyHost`) before the flush that precedes the audit ingest. The flush's barrier waits for the whole fan-out it enqueued.
- That covers three cases:
  - a new block;
  - a cross-page move, which now raises the new page and not the old one, as a local move does;
  - a new page whose cache row came before its children's page ids.
- **Cost:** the fan-out now runs inside the session, before `SyncComplete`, and only when the session carries audit records. On a pessimistic debug build at 100K blocks it took about 6 s. The bound is 120 s.
- **Residual:** a full background queue can shed the fan-out, and that session's raise then misses. That is no worse than before.

**Not here:** the fix is forward-only. Pages that already diverged stay reported by App health until something edits them again.

**Shown red:**
- With the raise keyed on the sidecar again, the dag test and three real-QUIC tests fail. The QUIC tests assert that `reconcile_all` reports no divergence and that B's times equal A's.
- With the early fire deleted, or moved after the flush, the three QUIC tests fail.
- `e2e-tauri/sync-refresh.e2e.ts` checks that a block the peer adds lifts its page above a newer one in "Last edited". It passed five runs out of five on the real backend, and failed with its own message with the dag fix reverted.

**Suites:**
- the whole workspace under nextest;
- clippy, fmt and `SQLX_OFFLINE` check;
- `typecheck:e2e-tauri`, the e2e-tauri helper tests, and lint;
- the real-backend sync-refresh spec.
