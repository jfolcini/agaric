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
`validate_search_term_bytes` now, called in sequence at `handle_search`.

The function itself is gone. It survived the first round as a two-line
delegator, which #5035's review correctly called a helper for a one-off: one
caller, and a doc comment that only restated the two names it called. The one
sentence it carried that was not a restatement — *neither bounds the other* —
is already the opening of `validate_search_term_bytes`' own #1607 doc, so
deleting it lost nothing.

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

## The doc-block anchor, a fourth time — and the rule that did not hold

`session-1765`, written immediately before this slice, states the rule: *anchor
on the first line of the doc block, or on the blank line above it.* This slice
then broke it in the very next file.

Inserting `call_in_task_local_scopes` and `emit_completion` before
`async fn dispatch_tool_call(` put them between that function and its own doc
block. `call_in_task_local_scopes` inherited a header claiming it is "Core tool
dispatch shared by the `ServerHandler::call_tool` trait method" and carrying the
precondition "`agent_name` must already be sanitised" — for a function with no
`agent_name` parameter. `dispatch_tool_call`, which the trait method actually
calls and which that precondition constrains, was left undocumented. #5035's
review caught it.

Four occurrences, four mechanisms (#5026 `#[test]`, #5030 an indented
`#[tokio::test]`, #5031 the doc's second paragraph, this one an anchor on the
`fn` line itself). The pattern across all four is the same: **I anchor on the
item I can see and forget the doc block above it is part of that item.**

A prose rule in a session log did not survive one slice, so the fix is
procedural, not a better sentence: **insert a new item after the previous
item's closing brace, never before the next item's signature.** The closing
brace is unambiguous; a signature line has an invisible prefix.

That is a change to how I edit, not something the repo can check. Nothing here
catches it — the code compiles, the tests pass, and rustdoc renders the wrong
paragraph without complaint. A reviewer has caught it four times out of four,
which is the fact worth recording rather than the rule I keep restating.

## The other three notes from that review

- `ToolCompletionGuard`'s doc said it is "constructed INSIDE the `LAST_APPEND`
  task-local scope". This PR made that false, and it is the sentence carrying
  the soundness argument for draining the task-local from `Drop`. Corrected to
  say what actually makes it sound: the guard is built by the caller and MOVED
  in, and it is the DROP point inside the scope that matters, not the
  construction site.
- `call_in_task_local_scopes` took `call_ctx` and `scoped_ctx` — two clones of
  one `ActorContext` made two lines earlier. It takes one and clones inside now,
  and the "two copies needed" comment went with the clone.
- `let mut completion_guard = guard;` existed only to add `mut`. The signature
  says `mut guard` instead.
