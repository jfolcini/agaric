# Session 1756 — query_by_property, and two arms nothing was testing

`query_by_property` was the last `too_many_lines` violator #4639 calls worth
its own slice. Workspace `#[expect(clippy::too_many_lines)]` count **29 → 28**
(anchored grep, measured on both sides).

The size claim is the threshold, not a line count: the old function carried an
`#[expect]` that the build would have rejected had it fallen under 70, and
clippy now accepts the file with that attribute **removed**, so every piece is
under 70. #4639's earlier slices published exact before/after numbers obtained
by dropping `too-many-lines-threshold` to 1 and re-running; that costs a full
rebuild, and the number it buys says nothing the threshold does not. The "147"
this slice was scoped against came from the issue and was never re-derived — a
local approximation of clippy's counter disagrees with it, which is reason
enough not to repeat it.

| helper | what it is |
|---|---|
| `PropertyFilters` | the fourteen values both branches bind, prepared once |
| `validate_value_filters` | the two mutually-exclusive-input refusals |
| `sql_operator` | safe tag → SQL operator, the one non-bind value in either statement |
| `json_array` | `&[String]` → `json_each(?N)` payload, or `None` |
| `reserved_column` | which `blocks` column a reserved key lives in |
| `fetch_reserved_column_rows` | the twelve-slot statement |
| `fetch_property_row_rows` | the fourteen-slot statement |
| `value_predicates` | `?2` / `?3`, special-cased for `!=` (#384) |

The SQL is byte-identical to `origin/main` and every `?N` keeps its bind. The
two branches number their slots independently — twelve and fourteen — which is
why they were mutated independently rather than as one function.

## `json_array` deletes a duplicate

`value_text_in` and `exclude_todo_states` were serialised by two identical
five-line blocks, each with its own comment arguing the same
`None`-short-circuits point. One function, one reason.

## Nine bind swaps, one survivor

Slice 20's lesson was that predicting which arm is uncovered is guesswork. So
every same-typed bind pair in both branches was swapped, not the pair I
expected to matter:

| mutant | result |
|---|---|
| reserved `?10`/`?11` date_from ↔ date_to | killed |
| reserved `?9`/`?12` value_text_in ↔ exclude_todo_states | killed |
| reserved `?5`/`?6` space_id ↔ exclude_parent_id | killed |
| reserved `?1`/`?8` filter_value ↔ block_type | killed (3) |
| property-row `?2`/`?3` value_text ↔ value_date | killed (3) |
| property-row `?11`/`?14` value_text_in ↔ exclude_todo_states | killed |
| property-row `?7`/`?8` space_id ↔ exclude_parent_id | killed (3) |
| property-row `?1`/`?10` key ↔ block_type | killed (3) |
| **property-row `?12`/`?13` date_from ↔ date_to** | **SURVIVED — 37/37 green** |

The half-open `[from, to)` semantic *is* pinned — by
`query_by_property_value_date_range`, which queries `due_date`. That is a
**reserved** key, so it binds the range to `b.due_date` and never reaches
`bp.value_date >= ?12 AND bp.value_date < ?13`. The property-row date range had
no test at all, in either direction.

`query_by_property_value_date_range_on_property_rows_is_half_open` closes it:
three rows on a non-reserved key at the lower bound, the interior, and the
upper bound, so the assertion pins inclusion and exclusion together rather than
one arm of the pair. Against the mutant: 38 run, 1 failed — the new test.

## Two of the four reserved keys had no routing coverage

`reserved_column` is the only thing making `is_reserved_property_key`'s "this
key is reserved" agree with "and it lives in this column". Mutating each arm:

| arm | result |
|---|---|
| `todo_state` → `priority` | killed (3) |
| `due_date` → `scheduled_date` | killed (3) |
| **`priority` → `todo_state`** | **SURVIVED** |
| **`scheduled_date` → `due_date`** | **SURVIVED** |

Half the reserved key set could be silently routed to the wrong column with the
whole estate green. `query_by_property_routes_each_reserved_key_to_its_own_column`
gives each key a block whose value sits in that column only, so a mis-route
returns another block rather than nothing, and asserts the exact id per key. It
kills all four arms, and the two new mis-routes tried afterwards.

## A precedence that could not be exercised

The reserved path chose its single value bind with

```rust
match col {
    "due_date" | "scheduled_date" => value_date.or(value_text),
    _ => value_text.or(value_date),
}
```

Swapping the arms changed nothing, and no test could have caught it: the
boundary rejects `value_text` and `value_date` both being `Some`, and that is
the only case a precedence decides. With at most one `Some`, `a.or(b)` and
`b.or(a)` are the same value. This is the unreachable condition, not a coverage
gap — the branch is deleted, and `filter_value` is one `or`.

The mutant still survives after the deletion, which is the point: it is the
proof the arms were equivalent. What holds it up is
`query_by_property_rejects_both_value_filters`, which pins the refusal on both
paths.

`properties.rs` was confirmed byte-identical to its pre-mutation copy after
every one of the thirteen mutations (#4287, #4018, #4204).

## The verify cannot see the tests that matter here

Six of the nine bind mutants were killed only by tests in
`src-tauri/tests/commands/` and `src-tauri/tests/command_integration/` — the
app crate. `scripts/test-related-rust.sh` maps a change in `agaric-store` to
that workspace member, not to the app crate that consumes it, so the pushed
range selects the store's own tests and not the ones with most of the
reserved-path coverage. The workspace suite was run by hand for this reason;
the same gap, from the other direction, is the note recorded in session-1755.
