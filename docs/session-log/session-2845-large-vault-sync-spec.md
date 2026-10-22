# Session 2845 — a fresh device syncs a large vault and the counts match

#5739's last real-backend Sync item.

- **Reworded item.** Its original wording asked for snapshot catch-up; the maintainer reworded it to "a fresh device syncs a large vault and the counts match".
- **What a fresh device does.** It takes the ordinary pull, not snapshot catch-up: the responder sends one `LoroSync` per space (a full snapshot when the initiator holds none) and the op log follows as audit-only `OpLogBatch` messages capped at `OP_LOG_BATCH_INLINE_MAX_BYTES`.
- **When snapshot catch-up runs.** Only after `ResetRequired`: own-lineage loss (`check_reset_required`), or a delta the receiver cannot reach (`classify_from_vv_reachability`).

Built:
- **`seed_vault` peer command.** It is new in `e2e_sync_peer`. It writes pages and blocks through `create_block_inner_with_space` and `create_blocks_batch_inner`, settling the background queue after each page. It reports how many op-log batches a device holding none of the log would receive, using the responder's own `collect_ops_for_peer` and `batch_ops_for_wire`.
- **`e2e-tauri/sync-large-vault.e2e.ts`.** The peer seeds 10 pages × 100 blocks of about 7 KB each, which makes 4 op-log batches; the spec refuses a seed under 3. A fresh app pairs and syncs. The Pages view then shows 10 pages and 1,000 blocks, re-read after leaving and returning. The last block's text matches the peer's, and its history is the peer's one `create_block`, which covers the op-log batches no count can see.
- **Docs.** `docs/features/sync.md` said large vaults use snapshot catch-up and that it is typical on a fresh device. It now says the first sync brings the vault over one message per space, and names snapshot catch-up's real trigger.

Reviewed separately. The reviewer:
- dropped reply fields that only echoed the inputs;
- renamed `seed_bulk` to `seed_vault`, after the bulk-equivalence ratchet flagged the name;
- corrected the docs.

Shown red on the real backend:
- the responder sending only the first op-log batch: the history assertion failed with `Array []`, while the counts passed, as they ride `LoroSync`;
- the responder leaving the Personal space's `LoroSync` out: the counts failed with `{"pages":0,"seededRows":0,"blocks":0}`.

Suites run: the spec green in 58 s, `cargo fmt`, `cargo clippy -p agaric-diagnostics -D warnings`, `typecheck:e2e-tauri`, lint, `node --test scripts/e2e-related.test.mjs`, vitest over `e2e-tauri` and `src/__tests__`, `prek` on the changed files.
