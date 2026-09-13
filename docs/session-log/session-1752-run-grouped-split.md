# Session 1752 — #4639 slice 19: `run_grouped`, and the pair nothing pinned

`run_grouped` was 228 lines, the largest `too_many_lines` violator left. It is
now 65. Workspace count 32 → 31.

## The split

It read as one function only because the five SQL statements it issues were
stacked in one body. Each is named now:

| helper | lines | what it is |
|---|---|---|
| `grouped_total_count` | 26 | how many buckets the match set has |
| `grouped_global_aggregates` | 26 | the un-grouped fold — no group-key join, so a multi-valued tag key cannot double-count it |
| `fetch_group_buckets` | 61 | one keyset page of buckets, `HAVING`-resumed |
| `fetch_member_preview` | 54 | the windowed per-bucket member preview |
| `grouped_page_response` | 30 | fold buckets + members into the response |
| `preview_order_clause` | <20 | the window's `ORDER BY` |

`GroupKeySql` carries what every statement shares — the rendered key
expression, its join, its one bind — because *all three statements agreeing on
the same key* is the property that keeps grouping correct, and `GroupCtx`
already set that precedent in this file. Each extracted body rebinds those
fields to the original local names, so the moved statements are verbatim.

A second bundle, `GroupAggSql`, did not survive review and should not have been
written: one consumer, destructured on its first line, existing only to keep
`fetch_group_buckets` under the argument threshold. `fetch_group_buckets` takes
`&[AggregateSpec]` and calls `resolve_aggregates` itself instead — same
parameter count, same `?N` numbering, one fewer type.

`fetch_member_preview` first landed at **68/70**. Two lines of headroom is the
exact position this sweep exists to get functions *out* of — it is what
`search_fts_partitioned` was in two sessions ago — so its ordering clause came
out as well rather than shipping a new function onto the ceiling.

## The finding: a surviving mutant

The failure mode a move like this hides is **bind order**. The binds are
positional; nothing in the type system connects the third `bind` call to `?3`.
So the mutants targeted order, not logic.

| mutant | result |
|---|---|
| `fetch_group_buckets`: aggregate binds before the group-key bind | **SURVIVED** — 110/110 green |
| `fetch_member_preview`: preview `IN` keys before the group-key bind | killed — `grouped_member_preview_left_join_equals_correlated_2269`, `group_by_property_declared_number_buckets_by_value` |

The first one is a real hole, and it is the **half-covered pair** AGENTS.md
names. The two binds occupy adjacent `?N` slots, and every existing test
exercised at most one of them:

- `per_group_aggregates_correct` groups by `GroupKey::State` — a native column,
  **no bind** — while requesting aggregates.
- the `group_by_property_*` tests bind a key but request **no aggregates**.

Each arm pinned alone; their relative order open. Swapping the two `bind` loops
was invisible to the whole suite.

The hole predates this refactor — the same swap was possible when the binds sat
inline — but the extraction is what made it worth finding: the ordering is now
carried by a comment in a helper, one edit away from a silent reversal.

`group_by_property_with_aggregates_binds_key_before_aggregates` closes it: it
groups by the `status` property while folding the `estimate` property, so both
binds exist at once. Swap them and the group key reads `estimate` while the fold
reads `status` — the asserted buckets stop existing. Re-run against the mutant:

```
111 tests run: 110 passed, 1 failed
```

One test, the new one, and nothing else — it pins the pair without duplicating
coverage that already exists.

`engine.rs` was confirmed byte-identical to its pre-mutation copy afterwards
(#4287, #4018, #4204).

## Verification

- `cargo nextest run --workspace`: `6323 tests run: 6323 passed, 13 skipped`
- `cargo clippy -p agaric-store --all-targets`: clean, and the `#[expect]` on
  `run_grouped` reported itself unfulfilled — which is how the attribute is
  supposed to announce that the split worked

These statements are `sqlx::query(AssertSqlSafe(..))` runtime queries, so the
`.sqlx/` drift guard says **nothing** about them — it only records `query!`
macro queries and would stay green over an arbitrary rewrite of these strings.
An earlier draft of this log and of #5021's description cited it as evidence
that the SQL was unchanged. It is not evidence; the claim rests on reading the
diff. Twice today I have cited a passing guard for a property the guard does
not test (the other was `.sqlx/` and literal indentation, session 1750) — the
check being green is a fact about the check's own subject, never about whatever
I happened to be claiming.

## Left for the next slices

`query::engine::compile_and_run` (217 lines) and
`pagination::properties::query_by_property` (147). Both are their own PRs.
