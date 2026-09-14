# Session 1766 — three MCP functions, and three kinds of proof

The `src/mcp` group: `tool_desc_search` (101 code lines), `validate_search_term_budget`
(74) and `dispatch_tool_call` (78). Anchored workspace count **23 → 20** on this
base, and `src/mcp` carries no `#[expect(clippy::too_many_lines)]` at all now.

## Three splits, each along a seam that was already there

**`tool_desc_search`** was one `json!` literal, two thirds of which is the
`filter` sub-schema. That is now `search_filter_schema()` — its own function
because a new filter dimension is a change to that shape and nothing else, and
because the MCP-facing schema mirrors `SearchFilter` in
`agaric-store/src/search_types.rs`, which is the thing it should be read
alongside.

**`validate_search_term_budget`** was two budgets sharing a name: how MANY terms
arrived (the SQLite bind-parameter cap) and how LARGE each is (#1607's byte cap).
Neither bounds the other — that is the whole reason #1607 exists on top of the
count cap — so they are `validate_search_term_count` and
`validate_search_term_bytes`, and the budget function is the two calls that say
so.

**`dispatch_tool_call`** was setup, a doubly-nested task-local scope, and an
emission point. The scope block is `call_in_task_local_scopes` (an associated
function, not a method: everything `move`s into the spawned future, so taking
`&self` would have been the wrong shape) and the emission is `emit_completion`.

## Three kinds of proof, one per split

The interesting thing about this slice is that each extraction was verified a
different way, and none of the three would have caught the others.

**The schema: an insta snapshot already pinned it.**
`tool_descriptions.snap` covers every tool's `input_schema`. Extracting 64 lines
of JSON into a function either produces byte-identical output or reddens that
snapshot — so the green run *is* the falsification, and no new test was owed.
Worth saying because the instinct on a 64-line move is to reach for a mutant;
here the existing coverage was strictly stronger than one.

**The budget: mutate the `?` chain.** Drop the `validate_search_term_bytes` call
and **six** `#1607` tests go red (aggregate overflow, oversized query,
page-glob, block-type, property value, state filter). The two halves are
independently pinned, which is the shape the split claims.

**The dispatch: mutate the guard.** Pass `None` where the `ToolCompletionGuard`
should go and exactly one test fails —
`rw_mutation_emits_activity_even_when_dropped_mid_commit`, the #2954 test the
guard exists for. A single-test kill on a hand-picked mutant is the strongest
signal in this sweep: the test is not merely present, it is aimed.

## One thing that is not pure relocation

The guard is now constructed *before* the scope rather than inside it. It still
moves in, is armed the same way, and is disarmed and dropped at the same point;
the only difference is that the `Option::map` runs on the caller's stack instead
of inside the future. Everything else, normalised to code lines and diffed, is
relocation plus signatures.

## Test plan

```
cargo clippy -p agaric --all-targets   # clean, none of the three expects needed
cargo nextest run -p agaric            # 2593 passed, 0 failed
```

The app crate has no dependents, so `-p agaric` is the coverage boundary here —
unlike #5033, where narrowing a `pub` made `--workspace` the check that mattered.
