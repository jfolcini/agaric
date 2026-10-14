# Session 2017 — Boot: trim per-boot work

Set out to work #5420: steps that cost a little on every boot, re-run work boot already did, or compete with the first UI queries.

What shipped: boot no longer runs `PRAGMA optimize` (the 4 h maintenance job's first tick, a minute after boot, refreshes planner stats). A healthy boot returns from `recover_derived_state_from_op_log` before its op-log `COUNT`. The FTS and `block_tag_refs` emptiness probes are existence checks on the read pool, and the tag-ref rebuild is only scheduled when some live block holds a `#[` token, so a vault with no inline tag refs swaps the rebuild (writer lock, regex, space map) for a cheaper read-only `LIKE` scan on the reader. The projected-agenda midnight timer starts at today, so boot's own rebuild is not repeated a minute later. The #5074 agenda rewrite is retired by an `app_settings` marker written in the same transaction as the rewrite. The vault-wide `page_id` rebuild and the orphan-attachment sweep left the boot burst for their daily maintenance jobs, whose first tick is about a minute after boot; the page-id backstop is not gated on the app being backgrounded, because an inbound sync's page-id rebuild is debounced in memory and a quit inside that window is healed only by it. Each boot phase logs `elapsed_ms`.

Dropped with a measurement: importing the Loro snapshots in parallel. A throwaway harness under `release-test` (2, 5 and skewed space counts, three runs) never showed parallel beating sequential outside its p10–p90 band, and the realistic skewed cases were equal or slower; the box was loaded, so the bands were wide.

Traps: the first half renamed a log line that `bug_report.rs` `STABLE_MESSAGES` pins, which only the whole-workspace run caught. The marker for the agenda rewrite has to be committed with the rewrite, not before it, or a failed pass is never retried. A test of the midnight seed helper did not pin the call site; the job is now driven through `run_tick` in `lib.rs`.

Ran: the whole workspace under nextest (split in partitions), clippy with `--all-targets -D warnings`, fmt, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, and `check-dynamic-sql.py`.
