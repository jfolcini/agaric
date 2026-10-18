# Session 2607 — interactive_slo budgets an order of magnitude too loose are tightened

The maintainer asked for the SLO budgets to match the order of magnitude
the probes now measure.

The harness compares each probe's mean to its budget. Evidence: the six
green `bench-slo` jobs since 2026-10-14 (main 39142833582 and 38877345085;
branches 39071734582, 39028408187, 38793634338, 38709602007). Rule: only a
budget at least 10× the worst CI mean moves, to the smallest 1-2-5 value at
least 3× that worst mean. The newest main run read 1.3–1.5× slower across
the board, which the 3× absorbs.

| probe | old | worst CI mean | new |
|---|---|---|---|
| batch_resolve | 5 | 0.26 | 1 |
| list_pages_with_metadata (Notes/*) | 10 | 0.68 | 5 |
| filtered_blocks_query | 10 | 0.19 | 1 |
| create_block | 60 | 1.71 | 10 |
| list_projected_agenda @100–100K | 200 | 1.73 | 10 |
| list_projected_agenda past day | 200 | 1.64 | 5 |
| query_by_property | 5 | 0.19 | 1 |
| search_blocks (word) | 30 | 2.75 | 10 |
| mcp get_page_markdown/journal/resolve/query/search | 30 | 2.53 | 10 |

Unchanged: probes within 10× of their budget, `get_block` and
`get_properties` (1 ms is the series' floor), the problem-tier probes, and
the 20k-page perf gates, whose medians nextest hides on a passing test, so
no CI number exists for them. Near their budgets, and not loosened:
`list_all_tags_in_space` @10K tags (37 of 64 ms) and
`count_backlinks_batch` (95 of 160 ms).

Ran: `cargo check --bench interactive_slo`, clippy on the bench, rustfmt;
no bench locally (`src-tauri/benches/AGENTS.md`). At the maintainer's word
the lane was not re-run on the branch: the next scheduled `bench-slo` is the
first to hold these probes to the new budgets.
