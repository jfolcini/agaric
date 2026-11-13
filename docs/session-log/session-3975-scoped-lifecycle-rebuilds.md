# Session 3975 — delete and restore stop rebuilding the whole vault

`Refs #6522` (items 1 and 2; dropping the two indexes stays open).

- Delete and restore no longer enqueue `RebuildPageIds`. Their inputs to `page_id` and `space_id`
  (`parent_id`, `block_type`, the page's space) do not change, so the whole-vault rebuild could
  not change anything. Purge, inbound sync and the daily backstop keep it; a `needs_page_ids` flag
  on the lifecycle debounce makes one purge in a burst still fire it.
- `rebuild_space_ids` and `rebuild_pages_cache_counts` find the stale rows on the read pool and
  write only those. With nothing stale, the counts rebuild takes no write lock at all.

Decisions and traps:

- Both write halves re-derive under the lock from the ids the read phase found; they do not write
  the read phase's values. Create, edit and move maintain counts in their own transaction, so a
  value read earlier could overwrite a fresher one.
- The old one-statement forms stay as `#[cfg(test)]` oracles, and tests assert both agree. A test
  oracle that writes `blocks` outside `mod tests` trips the table-ownership baseline, so it lives
  inside the test module.
- A restore does write `page_id` in its own transaction, to the value the rebuild derives. The
  premise is about inputs, not writes.
- Delete and restore no longer repair page-id drift that already existed elsewhere in the vault,
  nor in the rows a batch restore or restore-all brings back: single restore and undo re-derive
  their subtree, the batch restore does not, and restore-all re-derives `page_id` but not
  `space_id`. That waits for the backstop, a purge or inbound sync. Raised with the maintainer.
- A seeded test drives creates, moves, space moves, deletes, single / batch / all restores, purges
  and undos through the commands and checks after every step that the full rebuild changes
  nothing; a longer search run of it found no drift either.
- The plan assertion reads the statement's SQL from the `query!` value, so it tests the production
  text and not a copy.
- Two mutations can mask each other: an unscoped write hides a read phase that misses rows.
  Falsification ran as two builds.

Not done: settled-time budgets and the before/after comparison, which needs `main`'s settled
time from a `bench-slo` run. The bench cannot show write-lock time: its materializer has no read
pool, so every rebuild runs its single-pool form, nothing contends for the lock during the flush,
and no tracing subscriber is installed, so a `slow BEGIN IMMEDIATE` warning could not appear in
its log.

Ran: the whole workspace under nextest, clippy over the workspace with all targets, the
`SQLX_OFFLINE` check, and both prek stages, on the final tree.
