# Session 1608 — the SLO gate broke because the bench changed queries (#4770)

## What failed

`scheduled-deep-checks` run 34190840273, `bench-slo`:

```
interactive_slo: count_agenda_batch_by_source @ 100K = 37.80 ms > budget 30 ms
```

## It is not a regression in the query, and not runner noise

The bench measured a different, cheaper query until two days earlier. #4770
deleted `count_agenda_batch` (no frontend caller) and repointed the bench at
`count_agenda_batch_by_source_inner` — the one the journal calendar actually
issues — keeping the budget that had been sized for the old one:

| run | bench | observed | budget |
|---|---|---:|---:|
| 2026-08-24 | `count_agenda_batch` | 15.43 ms | 30 |
| 2026-08-31 | `count_agenda_batch` | 16.79 ms | 30 |
| 2026-09-07 | `count_agenda_batch_by_source` | 27.02 ms | 30 |
| 2026-09-08 | `count_agenda_batch_by_source` | **37.80 ms** | 30 |

Nothing between the last two runs touches the query, its table or its indexes.
The first run under the new bench was already at 90% of a budget that was never
re-derived for it; the second crossed.

## The one column that costs everything

The two queries differ by `source`:

```sql
SELECT ac.date, ac.source, COUNT(*)   -- was: SELECT ac.date, COUNT(*)
 GROUP BY ac.date, ac.source          -- was: GROUP BY ac.date
```

`agenda_cache`'s `PRIMARY KEY (date, block_id)` covers the old query outright —
`EXPLAIN QUERY PLAN` says `SEARCH ac USING COVERING INDEX … (date=?)` and the
GROUP BY needs no sort. `source` is in neither, so the by-source form pays
twice: a table lookup per matching row, and `USE TEMP B-TREE FOR GROUP BY`.

Migration 0117 adds `(date, source, block_id)` — every column the query reads,
in the order it groups by — and the plan returns to the covering scan with no
temp B-tree. `block_id` is third because the join needs it, not for lookup.

## Measured, not reasoned

Full `interactive_slo` lane, this machine, before and after:

| bench | without 0117 | with 0117 |
|---|---:|---:|
| `count_agenda_batch_by_source` | **41.84 ms (FAIL)** | **24.27 ms (PASS)** |
| `list_blocks (paginated)` | 15.95 ms | 15.65 ms |
| `batch_resolve` | 0.20 ms | 0.20 ms |

The baseline run shared the machine with a frontend test run, so it is the
weaker of the two numbers. The two benches the index cannot touch moved by
under 2% across the pair, which is what says the load did not distort the
comparison — without that control the 41.84 would not be usable.

## What was not done

The budget was not raised. A bench whose budget is inherited from a query it no
longer runs is not evidence that 30 ms is the wrong number; it is evidence that
nobody re-derived it. With the index the shipped query fits the budget the
lighter one did, so there is nothing to re-derive.
