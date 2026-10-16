# Session 2167 — A block-scoped property write re-projects only that block

#5423 item 5. `push_property_op_invalidations` enqueued a FULL
`projected_agenda_cache` rebuild for every write to a projection-relevant
key (`repeat*`, `due`/`scheduled`, `due_date`/`scheduled_date`,
`todo_state`, any date value), on any block, repeating or not. The rebuild
deletes the whole cache and re-inserts every repeating block's rows under
one write lock. On main the `interactive_slo` probe
`set_property_2k_page_in_100k` measured 3.54 ms for the command and 80.98 ms
settled (command plus background work), run 38857201664.

Those keys now enqueue `RebuildProjectedAgendaForBlock { block_id }`. Its
handler, in one `BEGIN IMMEDIATE`, checks that `projected_agenda_horizon`
was rebuilt today, reads that one block with the full rebuild's own query
plus `b.id = ?`, deletes its rows and re-inserts them through the existing
`project_block_into`. A missing or stale horizon writes nothing and falls
back to the full rebuild, which also moves the reference date forward.
`template` (page-scoped), non-property ops and inbound sync keep the full
rebuild. Dedup keeps one task per block, lets a full rebuild in the same
drain subsume them, and collapses more than `BACKGROUND_CAPACITY / 4` blocks
into one full rebuild, the bound the inbound per-block fan-outs use. The
retry queue gets a per-block kind. `dedup_tasks` sat at the 70-line limit,
so the projected handling is a pre-pass and the old body is
`dedup_other_tasks`.

The oracle is the full rebuild itself: an end-to-end test drives eleven
block-scoped writes through real commands on a block with three repeating
neighbours and compares the cache with a full rebuild after each. Every new
test was shown red against a mutation (delete every row, skip the insert,
no fallback, no horizon check, date-blind horizon check, template narrowed,
no subsumption, wrong order, off-by-one bound, no bound, no dedup, no
retry round-trip).
