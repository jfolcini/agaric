# Session 2135 — Write path: benches, then two trims

#5423, items 1 and the link roll-up behind item 2. Benches first, as the issue asks.

`interactive_slo` gains three probes on a 2K-block page at 100K:
`edit_block`, `set_property (todo_state)` and `move_block`. Each also
prints an unbudgeted *settled* time, the command plus the background
flush, so trims to the background work have a number too. The weekly
summary now renders those settled lines as observed-only rows instead of
FLAG rows.

Before, from `bench-slo` on the probes alone:

| Probe | Command | Settled |
| --- | --- | --- |
| `edit_block` | 3.65 ms | 65.28 ms |
| `set_property (todo_state)` | 2.13 ms | 82.29 ms |
| `move_block` | 9.53 ms | 9.78 ms |

The trims:

- **The own page's counts.** An edit changes neither count of its own
  page (`child_block_count`, `inbound_link_count`). It no longer
  recomputes them under the write lock. The pages it links to or used to
  link to are still recomputed in the same transaction.
- **The link roll-up's touched targets.** They were read through
  `COALESCE(page_id, parent_id, id)`, which scanned `block_links`. Three
  indexed branches replace it: by page, by parent when the source has no
  page, and by the source itself when it has neither. The old query stays
  as a `#[cfg(test)]` oracle, and the fixture covers every branch's
  deleted and NULL guards.

The conformance replay seeded pages through raw SQL, so they had no
`pages_cache` rows or counts until an edit repaired them. The first trim
removed that repair. The replay now builds rows and counts once after
seeding, as a page created through ops already has them.

Falsified on copies in the lane:

- **Own-page trim:** A1 (put the own page back), A2 and A3 (drop the old
  or new outbound targets). Each turned the predicted test red.
- **Roll-up:** B1–B10, which drop each branch, each branch's `deleted_at`
  guard, each NULL guard, and the `page_link_cache` arm. All ten reddened
  `touched_targets_match_the_scanning_oracle_for_every_rollup_case_5423`,
  most of them alongside the page-link-cache tests that read the same
  rows.

Ran at the merge with main, after #5578:

- `just gen-sqlx` (no change);
- the write-path, pages, space and conformance tests, 918 of them, all passed;
- `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo clippy --bench
  interactive_slo` after the merge that brought #5588's probes into the same file.

Items 2 (the second link reindex), 3, 4, 5 and 6 are not in this PR. The
after numbers from this branch's `bench-slo` run decide the budgets and
whether the settled times justify the background batching in item 4.
