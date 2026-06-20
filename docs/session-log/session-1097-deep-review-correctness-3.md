# Session 1097 — /batch-issues loop: 4 correctness fixes, batch 40 (2026-06-20)

## What happened

Four independent correctness findings (disjoint files) from the deep review, built by
parallel subagents in shared worktree `wt-batch40` and reviewed together. Part of the
maintainer-requested sweep of all open `correctness`-labelled issues.

## Shipped

PR `fix/deep-review-correctness-3`:

- **#1519** (HIGH, `sync_daemon/server.rs`) — the pending-pairing flow left the initiator
  stuck: the S-1 unpaired gate in `handle_incoming_sync` rejected the joiner's first
  connection before TOFU could establish its `peer_ref`. Now the gate admits a connection
  with no `peer_ref` IFF `is_pending_pairing()` (a bounded 5-min marker set only after
  passphrase verification); TOFU then persists the row and `clear_pending_pairing` closes
  the window. A device with no marker is still rejected.
- **#1544** (`mcp/handler_utils.rs`) — `validate_block_in_space`'s authorization SELECT ran
  as a standalone autocommit read separate from the write tx (TOCTOU under WAL). Lifted it
  onto the serialized writer path (`begin_immediate`, read-only rollback), so the check and
  the subsequent write evaluate on the same writer snapshot.
- **#1552** (`dag.rs`) — `insert_remote_op` accepted remote ops with non-canonical
  `parent_seqs` ordering with no reader canonicalization. Added `parse_parent_seqs_canonical`
  (parse + `sort()` matching the local writer's order) and routed ingest through it.
  Stored bytes are preserved verbatim (hash preimage intact) — canonicalization is on-read.
- **#1548** (`cache/block_links.rs`, `materializer/handlers/pages_cache.rs`) — the per-op
  `inbound_link_count` recompute joined `block_links` before the new edge was written (that
  happened later in the background reindex), so the count was stale until the async job
  caught up. Extracted `reindex_block_links_conn` and run it synchronously in the Create/
  Edit apply-op tx before the recompute. The BG reindex remains an idempotent no-op backstop.

## Review pass

Reviewer (APPROVE, all four correct): mutation-checked the #1519 security gate (forcing it
to admit any unpaired device fails the control test) and the #1548 no-double-count (disabling
the in-tx reindex fails the synchronous assertion). Confirmed #1519 admits only within the
bounded marker window; #1544 rolls back with byte-identical SQL + unchanged semantics; #1552
preserves stored bytes and matches the writer's sort order (no production order-sensitive
bypass); #1548's extracted SQL is byte-identical and the Edit arm collects affected pages
before the in-tx reindex. clippy `--all-targets` clean; 471 tests; `.sqlx`/baseline unchanged.

## Notes

- All four files disjoint (sync_daemon / mcp / dag / cache+materializer) — no shared-worktree
  clobber. #1544 touches `mcp/` so the push needs the prebuilt `agaric-mcp` release binary
  (Phase F) — built via `scripts/prepare-external-bins.mjs`.
- Branch base is current `origin/main`.
