# Session 2121 — query_by_property pushes selective values into the index

#5426, the `query_by_property` value arms. The maintainer's call was to
push down only the selective shapes:
- equality, `value_text_in`, and ranges on the reserved date columns;
- every other range, `neq` and presence keep the id-order walk;
- bench before and after.

Before, every shape walked `idx_block_props_key` in id order and tested the
value per row. A key every block carries, filtered to a value few hold,
read the whole key before filling a page.

What changed:
- **Value arms.** Equality and `value_text_in` let the value index drive
  the plan. A reserved date range seeks the column's own index.
- **Everything else.** Every other shape keeps the id-order walk over the
  key, so none of the shapes the maintainer kept on that scan get slower.
- **Oracle.** The old query stays as a `#[cfg(test)]` oracle.
  `query_by_property_pages_match_the_oracle_for_every_shape` pages every
  shape against it across cursor boundaries.
- **Plans.** Two plan tests pin which shapes narrow the value index and
  which walk id order.
- **Bench probe.** `interactive_slo` gains `query_by_property (broad key,
  value on 20 blocks)` with a 5 ms budget. Its before-run on main's code
  went over budget.

Trades, measured in review and accepted:
- **Overdue reads without statistics.** The Due panel's overdue read is a
  `due_date` range up to today with content and todo-state filters, limit
  200. On a database without `sqlite_stat1` and with dense due dates, it
  goes from under a millisecond to over a hundred. With statistics, which
  the four-hourly `PRAGMA optimize` writes, it stays well under a
  millisecond.
- **Broad equality.** On a value most of a key's rows hold, equality reads
  more rows than the id-order walk did. This is the broad-key trade the
  maintainer accepted for item 3.

What ran in the lane: the targeted query, conformance, property and
backlink set; mutations F1–F9 on copies, each red on its predicted test;
clippy; and rustdoc.
