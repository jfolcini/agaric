# Session 2093 — Agenda filters: push `filtered_blocks_query` down to id sets

#5426 item 3. `filtered_blocks_query_inner` walked `blocks` in id order and
tested every row with correlated `EXISTS` subqueries, one per property or tag
filter. A rare filter therefore scanned the whole space. The new
`interactive_slo` probe (a key on 20 of 100K blocks) measured 22.69 ms against a
10 ms budget before the change.

The base SQL is now static per call shape:
- `+b.space_id = ?` always, with the `+` keeping the planner off
  `idx_blocks_space_type` and its sort;
- `b.block_type = ?` only when set;
- `b.id > ?` only with a cursor.

A non-reserved property filter becomes `b.id IN (SELECT bp.block_id FROM
block_properties bp WHERE bp.key = ? …)` with the unchanged value predicate.
Tag filters become id-set subqueries over direct, ref, inherited and prefix
tags: one `IN` per clause in AND mode, one `IN` over a `UNION ALL` in OR mode.
Reserved columns and the soft-delete filter are untouched. The old composition
is a `#[cfg(test)]` oracle.

The trade, accepted on #5426: a filter matching a dense id set builds that set
in full before the `LIMIT`. Presence of a key nearly every block carries, an
`eq` on a value almost every block shares, and a tag on every block each go
from about 0.1 ms to about 30 ms at 100K. A report-only problem-tier probe
measures the broad-key case.

Tests:
- A parity test pages the production function against the EXISTS oracle with a
  small limit, over every operator, the four reserved columns, direct/ref/
  inherited/prefix tags (including an escaped `%`), and/AND/xor modes,
  `block_type` and the cursor.
- An EXPLAIN test pins the id lookup on `sqlite_autoindex_blocks_1` and
  `idx_block_props_key*`, with no correlated step and no temp sort.

Falsified on copies in the lane:
- dropping the `+` turned the EXPLAIN test red;
- dropping the inherited-tag arm turned the parity test red.

The review also ran a differential fuzz of both SQL shapes in SQLite over about
16,100 random pages and found no difference. It found three stale "composed
`EXISTS`" comments, now corrected.

Suites run:
- nextest on the filtered-blocks, query, agenda and conformance subsets, plus
  the bindings test;
- clippy and `cargo doc` with the CI lint flags, after merging `main`;
- the `bench-slo` lane before the change.
