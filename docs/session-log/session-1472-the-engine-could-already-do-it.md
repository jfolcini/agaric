# Session 1472 — the engine could already do it

Phase 1 of #4553. The advanced-query engine has supported ten property operators and four value
types for a long time; the query-builder UI reached four operators and one value type. Nothing was
missing from the backend — the UI simply never offered what was already there.

## The gap, counted

`PropertyPredicate` (`filters/primitive.rs:150`) has ten operators: `Exists`, `NotExists`, `Eq`,
`Ne`, `Lt`, `Gt`, `Lte`, `Gte`, `Contains`, `StartsWith`. `PropertyValue` (`:198`) has four variants:
`Text`, `Ref`, `Num`, `Date`.

The popover's `PROPERTY_OPS` offered `Eq`, `Ne`, `Exists`, `NotExists`, and `AddFilterPopover`
hardcoded the `Text` variant. So the six ordered and substring operators were unreachable, and a
numeric or date property could only ever be compared as text.

`VALUE_BEARING_OPS` was the tell. It was literally `new Set(['Eq','Ne'])` — "takes a value" defined
by enumerating the two operators that took one, rather than by asking whether the operator has an
operand. That spelling cannot survive adding `Lt`; it is not a list that got stale, it is a list that
was always going to go stale. It is now derived from arity.

The operator set and the `PropertyValue` variant are both derived from the property's declared
`value_type` via `listPropertyDefs`, so a `number`-declared key offers ordered comparisons and binds
a `Num`, and the UI stops being a second, quieter source of truth about what the engine supports.

## The aggregate bug underneath it

`agg_target_expr` (`query/engine.rs:947`) folded `value_text` and only `value_text`. Migration 0062's
exactly-one-value-column CHECK means a `number`-declared property is written to `value_num` with
`value_text` NULL on that row — so `sum(estimate)` over a properly declared numeric property folded
nothing but NULLs and returned empty. Not wrong-looking, just empty, which is the kind of wrong
nobody files a bug about.

Now a `COALESCE(value_num, <coerced value_text>)` computed **inside one** correlated subquery, both
columns read off the single row the `(block_id, key)` primary key guarantees. That last part is
load-bearing rather than stylistic: `?{pos}` is consumed once and the caller advances past exactly
one bind, so the obvious shape — two subselects, one per column — would have referenced the
placeholder twice and desynchronised bind numbering downstream. (SQLite does dedupe repeated `?N`
to one binding, verified directly rather than assumed, so the two-subselect version was not a
live defect; one reference is simply the shape that cannot become one.)

The acceptance criterion the issue writes for this is a trap worth restating: a `sum()` test must use
a genuinely `number`-**declared** property. Digits stored in a text property fold correctly through
`value_text` with or without the fix, so that version of the test passes for the wrong reason.

## A process failure, recorded because the near-miss was the interesting part

This work was interrupted by exactly the hazard the falsification protocol exists to prevent. The
build agent mutated `engine.rs` to prove a test went RED, backgrounded the `cargo nextest` run
because it exceeded a foreground timeout, and ended its turn waiting for the result — leaving

```rust
// FALSIFICATION BREAK (#4553): value_text only, no COALESCE.
```

live in the worktree with the fix reverted underneath it. A backup did exist in the session
scratchpad, so the tree was recoverable; the defect was not the missing backup, it was **ending a
turn inside the window**. Three disabled fixes have reached this repo that way (#4287, #4018,
#4204), two of them from agents stopped mid-falsification rather than from carelessness.

What caught it was not the backup and not the test suite — the suite was green on the broken tree,
because the broken tree is precisely the state the test was written to detect and the test had not
been run yet. It was a `git diff | grep` for falsification markers before pushing. That check costs
nothing and is the only thing standing between this failure mode and a merge, so it belongs before
every push, not just after a suspicious one.

Worth noting what the marker grep does *not* catch: an unlabelled revert. The comment is what made
this one greppable. The backstops for the unlabelled case remain `clippy -D warnings` (which trips
on `if false &&` and on statements after a planted `return`) and the reviewer.

## One warning that was mine

The pre-commit lint caught a `react(set-state-in-effect)` warning this file did not have before.
Counted rather than eyeballed: three on `main` across the three touched components, four on the
branch, and the new one was in `AddFilterPopover`.

The added code reconciled `propOp` in an effect when the derived operator set stopped containing it —
and its own comment said it was mirroring `QueryControlsBar`'s Relevance-sort reconciliation. That is
true, and it is also one of the three warnings already on `main`, so the precedent being followed was
the warned-about pattern.

Deriving during render instead is not just lint appeasement. The effect form needs a second render to
settle, so for one commit the native `<select>` points at an option that no longer renders *and*
`buildPredicate` can read the stale operator. Deriving makes that state unrepresentable rather than
merely brief. `Eq` is in every operator set, so the fallback is always valid.

The three pre-existing warnings are left alone; they are not this diff's to fix.

## `count` is a reserved word, not a variable name

The pre-push gate caught one more thing: `catalog-parity` failed because
`advancedQuery.aggregate.contributingCount` interpolates `{{count}}` with no plural forms.

i18next keys its pluralisation on the *option name* `count`. This string is `(n={{count}})` — a bare
number in mathematical notation with no surrounding noun to inflect, so there is no singular wording
for i18next to select and never will be.

The guard offers an escape hatch, `PRE_EXISTING_COUNT_EXEMPT`, and one of its four documented shapes
("a bare number with no surrounding word to inflect") fits exactly. It was still the wrong tool. That
list is explicitly for keys audited under #3882, and adding new entries to an exemption list is the
same kind of permanent, ownerless debt as bumping a ratchet baseline — the list gets longer, nobody
ever removes an entry, and the next reader cannot tell an audited exemption from a convenient one.

Renaming the interpolation variable to `n` removes the problem instead of registering it. The string
never enters i18next's plural machinery, no exemption is needed, and the key stops falsely advertising
itself as a pluralisable count.
