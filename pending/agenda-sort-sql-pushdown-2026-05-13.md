# Agenda sort/group SQL pushdown — 2026-05-13

> **Status:** **deferred** — the sub-millisecond cost on ≤200 items per
> page doesn't justify the compound-cursor reshape this requires. Filed
> as a tracked plan so a future contributor doesn't re-derive the
> blocker. This is the original sql-audit H4 item, separated out from
> the audit doc when the audit was retired.

## What this asks for

Move `sortAgendaBlocks` + `groupBy*` (in `src/lib/agenda-sort.ts`,
sort sites at lines 30, 108, 175, 230, 242, 265, 325, 331, 339, 354)
from JS into a SQL `ORDER BY` on the backend.

The sort key is `(effective_date, state_rank, priority_rank)` where:

- `effective_date = COALESCE(due_date, scheduled_date)`
- `state_rank` is a custom enum ordering: `DOING < TODO < (other)`
- `priority_rank` is a custom enum ordering: `A < B < C`

The audit's suggested SQL:

```sql
ORDER BY COALESCE(due_date, scheduled_date),
         CASE todo_state WHEN 'DOING' THEN 0 WHEN 'TODO' THEN 1 ... END,
         CASE priority   WHEN 'A' THEN 0 WHEN 'B' THEN 1 ... END
```

`blocks` already has `due_date`, `scheduled_date`, `todo_state`,
`priority` as columns (migration 0012/0013), so the CASE expressions
themselves are straightforward.

## The blocker — cursor pagination

`filtered_blocks_query_inner` (`src-tauri/src/commands/queries.rs:735`)
uses keyset pagination on `b.id` only:

```sql
WHERE (?1 IS NULL OR b.id > ?2)
...
ORDER BY b.id ASC
LIMIT ?
```

The cursor is just a `b.id`. The "give me page 2 starting after this
id" predicate is one comparison.

Changing `ORDER BY` to
`COALESCE(due_date, scheduled_date), CASE …, CASE …, b.id` requires a
**compound cursor tuple** `(date, state_rank, priority_rank, id)`. The
page-2 predicate becomes:

```sql
WHERE (date > ?d
   OR (date = ?d AND state_rank > ?s)
   OR (date = ?d AND state_rank = ?s AND priority_rank > ?p)
   OR (date = ?d AND state_rank = ?s AND priority_rank = ?p AND b.id > ?i))
```

Knock-on consequences:

- Cursor type changes shape (no longer a single string id).
- FE `SafeLimit` / cursor wrappers in `src/lib/tauri.ts` and
  `src/lib/safe-limit.ts` need updating to carry the compound shape.
- Every existing `filtered_blocks_query` caller has to deal with a new
  cursor variant, or we add a parallel `filtered_blocks_query_sorted`
  function (more duplication).
- Test surface for cursor correctness multiplies — every ORDER BY
  branch needs its own keyset-pagination test.

## Why deferred

Post-H3 (sql-audit Batch 3, Session 706), the agenda is one
`filtered_blocks_query` call returning up to 200 items
(`PAGINATION_MAX`). The JS sort on 200 small objects is
sub-millisecond — well below render budget.

The compound-cursor work is medium-risk and only pays off if:

1. The result set frequently exceeds one page (≥200 matching items),
   AND
2. The JS sort becomes measurable on real data.

Today neither is true. The 200-item cap is rarely hit; even at 200 a
JS comparator-based sort is microseconds-fast on modern V8.

## When to revisit

- Profiling shows the per-page sort is measurably hot on real user
  data (e.g. p95 > 5 ms).
- The practical agenda size grows past one page consistently (which
  would also surface the load-more cursor bug in
  `pending/agenda-loadmore-cursor-namespace-2026-05-13.md`).
- A new agenda-style view emerges that wants the same ORDER BY shape
  (the compound-cursor pattern would then have two consumers,
  improving the ROI).
- The backend `filtered_blocks_query` is being refactored for unrelated
  reasons and the compound-cursor change is local to that work.

## Cost when picked up

- **M (1-3 days).** Backend extension is ~half a day; the cursor type
  reshape + all-callers update is the bulk; tests for compound-cursor
  correctness add another half day.

## Risk

**Medium.** The state/priority enum ordering must match the JS
ordering exactly or the user sees re-shuffled agenda rows after the
cutover. Pin the enum ordering with a property test before changing
the production sort.

## Related

- Original sql-audit item H4 (deleted with
  `pending/sql-audit-2026-05-09.md` in Session 707, commit `a97d3263`).
- Session 706 (commit `60a104cb`) — H3 frontend agenda migration
  which made H4 less urgent (≤200 items per page).
- `src/lib/agenda-sort.ts` — the JS sort/group sites.
- `src-tauri/src/commands/queries.rs:735` —
  `filtered_blocks_query_inner` (the keyset-cursor SELECT to extend).
- `src/lib/safe-limit.ts` + `src/lib/tauri.ts` — cursor wrapper layer
  that would need a compound shape.
