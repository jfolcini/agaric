# Session 1754 — compile_and_run, and a hole where I did not predict one

`compile_and_run` was 217 code lines, the largest `too_many_lines` violator
left after #5021. It is now **25**. Workspace count **31 → 30**.

| helper | lines | what it is |
|---|---|---|
| `validate_limit` | 7 | the reject-never-clamp limit policy (invariant 10) |
| `sanitize_fulltext` | 10 | raw query → FTS5 `MATCH`, or a refusal |
| `compile_query_ctx` | 35 | the filter tree → one predicate, and its bind numbering |
| `first_page_scalars` | 8 | count + global aggregates, concurrently, first page only |
| `match_set_count` | 19 | `COUNT(*)` over the bound predicate |
| `fetch_flat_page` | 54 | keyset + `ORDER BY` + `LIMIT`, bound and fetched |
| `order_by_clause` | 11 | the `NULLS LAST` sort clause |
| `flat_page_response` | 32 | trim the probe row, build the cursor, fold the response |

## One context, both paths

`GroupCtx` already carried exactly what the predicate-assembly stage produces:
FROM clause, predicate, space id and its `?N`, the next free slot, the
sanitised MATCH, and the filter binds. It was built inline at the grouped
dispatch and named for the one path that used it.

It is now `QueryCtx`, owned, built once by `compile_query_ctx`, and passed to
**both** paths. "The grouped path reuses the SAME predicate as the flat path"
was a comment; it is now the type. Two consequences fall out:

- `has_fulltext` was a stored field sitting beside `match_sanitized`, always
  set to `match_sanitized.is_some()`. It is a method now. Two fields that must
  agree are two fields that can disagree — the same note #5021's fourth review
  made about a derivable `next_pos` parameter.
- `grouped_global_aggregates` is what the flat path's `agg_fut` body already
  was, line for line. The flat path calls it (as `global_aggregates` — it was
  never grouped; only its caller was), and ~18 duplicated lines are **deleted**
  rather than moved.

## The falsification: my prediction was wrong, the map was right

Going in, the recorded mutant #1 was the `next_pos` ordering in the keyset
stage: `limit_pos` must be read AFTER `keyset_predicate` claims its slots, or
the LIMIT binds into the first keyset slot and every cursor page misbinds.

That mutant was **killed** — by three tests
(`fulltext_pagination_under_relevance_equals_one_big_page`,
`pagination_page_through_equals_one_big_page`,
`sort_by_title_ascending_with_keyset_pagination`). The ordering was already
well covered. The comment naming it stays, because the ordering is still
load-bearing and now sits inside a helper where it is one edit from reversal,
but it was not a hole.

The hole was the one the read-through had flagged as a *coverage* gap rather
than a *risk*:

| mutant | result |
|---|---|
| `limit_pos` read before the keyset claims its slots | killed — 3 tests |
| filter binds and keyset binds swapped | killed — 1 test (`relational_predicate_paginates_correctly`) |
| the same swap, **only when `has_fulltext`** | **SURVIVED — 169/169 green** |

Three tests for the first, exactly one for the second, and nothing at all for
the third. The relative order of the filter binds and the keyset binds was
pinned only on the structural path:
`fulltext_pagination_under_relevance_equals_one_big_page` pages the FT path
with `default_filter()`, which contributes **zero** binds, and
`relational_predicate_paginates_correctly` pairs filter binds with a keyset but
never with full-text. Neither half covers the combination.

`fulltext_with_bound_filter_paginates_equal_to_one_big_page` closes it: `alpha`
∩ `TAG_RED` is F1 + F2 (F3 has the term but no tag, F4 the tag but no term, FX
is another space), so the filter bind is load-bearing and two rows are enough
for one cursor page at `limit = 1`. Against the mutant: 170 run, 1 failed — the
new test, and nothing else.

`engine.rs` was confirmed byte-identical to its pre-mutation copy after each of
the three (#4287, #4018, #4204).

## What this says about the sweep

Slice 19 found a surviving mutant in bind ORDER and I carried that lesson into
this slice as a specific prediction. The prediction was wrong and the *method*
was right: mutating bind order found a real hole, just not the one I named.
Predicting which arm is uncovered is guesswork; mutating every arm is not.
