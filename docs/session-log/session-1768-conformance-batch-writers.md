# Session 1768 — #5057: the five remaining batch writers, and a red main that was not ours

Continues the #5057 burn-down. Session 1767 shipped the trash-lifecycle trio
(#5065, 37 → 34). This session closes the batch-ops cluster and spends a large
part of its time on a red `main` that turned out to predate both.

## The cluster

`create_blocks_batch`, `move_blocks_batch`, `set_property_batch`,
`set_todo_state_batch`, `add_tags_by_ids`. Debt 34 → 29.

Neither return shape could be expressed on the command leg, and the scalar one
failed **open**, which is the part worth remembering. Three of the five answer
with a bare `i64`. `project_return` did `response.as_object().cloned()
.unwrap_or_default()`, so a scalar became `{}` and the record projected to the
command name alone — the count, the only thing those callers can see, was
silently unchecked. A fixture written against the old harness would have passed
while pinning nothing. That was never specific to these three: any future
scalar-returning command wired as `HEADED_ID_KEY` inherited it.

A scalar now renders under the shape's single declared attribute
(`set_todo_state_batch#updated=2`) rather than a synthetic key, and an array
projects one row token per element in the order returned. The order half
matters because the settled snapshot sorts: nothing else in the harness can
redden a batch that answers with the right rows in the wrong order.

`batch_writes.json` drives all five and deliberately includes the arms that
separate a batch from a fold over single-block calls — a tag applied twice
answers `tagged=0`, a null state clears rather than no-ops, `priority` routes to
value_text while `due_date` routes to value_date.

Two things the backend corrected in the fixture's first draft, both by refusing
it rather than by anyone noticing:

- `priority: "A"` is not a value. The vocabulary is `"1"/"2"/"3"`
  (`PRIORITY_FALLBACK_DEFAULTS`, seeded by migration 0014). An org-mode-shaped
  guess was simply wrong.
- A spec with two properties pins hash iteration, not a contract.
  `CreateBlockSpec.properties` is a `HashMap`, so the op order between
  `set_todo_state` and `set_priority` is whatever that run produced. Authoring
  it would have shipped a fixture that flakes on the Rust side. Each spec now
  carries one property; two specs cover both keys in a deterministic order.

The mock divergence the fixture exposed: `create_blocks_batch` assigned
`position = siblings.length` and never renumbered — the 0-based slot written as
if it were the 1-based rank. Every appended block landed one short of the
backend and left the sibling group un-renumbered for the next writer. It now
goes through `insertAtSlotAndRenumber`, which the single-block `create_block`
already used; the fix is a deletion of hand-rolled arithmetic rather than a
correction of it.

## A review note that was right when the obvious check said otherwise

#5065's review said `restore_blocks_by_ids` skips a LIVE id where the backend
refuses with `InvalidOperation`. Reading the batch function found no such guard,
and the line the note cited belongs to a different function — so on the evidence
in front of me the note looked wrong.

Rather than dismiss it, the question went to the backend as a fixture arm with
no declaration, which forces the runner to report whatever actually happens. It
refuses, from a helper the function calls. The note was right and the reading
was wrong, and the mock now refuses too.

Worth recording as a method rather than an anecdote: on this harness the cheapest
way to settle "what does the backend do here" is one undeclared fixture op, not
another pass over the source. The declaration discipline turns the answer into a
test failure that states it.

## Main was red, and it was not this work

The session was interrupted by `main` failing on `validate / playwright (3)`.
Established, not assumed:

- it failed on main at `96702262` (run 35109484773), hours before the drafts
  merge, and again at `e05ba98` (run 35152821602)
- it reproduces at `415358b`, before the second of those
- locally it is 3–6 failures in 20–25 runs of `-g "Formatting buttons"
  --repeat-each=5`, rotating between `Italic`, `Inline code` and
  `Bold + Italic combined`

So no merge caused it. Filed as #5066 with the reproduction.

The diagnosis, by instrumentation against copies, every probe restored
byte-identically:

| Hypothesis | Verdict |
| --- | --- |
| `focusBlock` returns before TipTap loads the content | out — correct 6/6 |
| focus is on the toolbar button, so Enter misses the editor | out — `inEditor=true` at press |
| the Enter is dropped by `enterSaveInProgress` / `mergeInProgress` | out — no such warning in any failing run |
| `deleteBlockIfLeakedEmpty` deletes it as empty | out — the store holds real content at the decision point |
| the block is lost in the backend | out — backend has it, with the right content |

That last row is the correction that matters, and #5066's body was amended for
it: the first write-up implied data loss. There is none. The block is committed
correctly and a reload recovers it. What fails is the rendered list — at failure
it is `[NEW_ULID, BLOCK02…05]`, five rows where six belong: the Enter-created
block takes the edited block's slot instead of the one after it.

What is left to examine is slot computation in `createBelow` against the
just-flushed store state on the legacy (non-caret-split) Enter path. Stopped
there rather than guessing at a fix in the save orchestration, where a wrong
change would create the data loss this bug does not have.

One property note for whoever takes it: inserting a ~1.2 s wait between the
Enter and the assertion makes the block render correctly, so a "fix" validated
only with an added wait proves nothing.

## What was verified

Seven mutations, seven reds, each against a copy and restored byte-identically
(`cmp`):

| Mutation | Result |
| --- | --- |
| Rust scalar projection back to `unwrap_or_default()` | red |
| Rust array branch removed | red |
| TS twin: scalar loses its count | red |
| TS twin: array projects only the first row | red |
| mock batch create back to `siblings.length` | red |
| mock restore drops the live-id refusal | red |
| replay drops the `specs` `parentId` expansion | red |

The sixth was GREEN on the first attempt — because `git checkout --
conformance/fixtures/` after an authoring run had reverted the tracked fixture
and taken the new arm with it. The fix to the process is to revert selectively
(`git status --short | grep -v <mine> | xargs git checkout --`); the lesson is
that a mutation coming back green is as much a signal about the harness as about
the code.

```
npx vitest run src/lib/tauri-mock   45 files, 899 passed
cargo nextest run --workspace -E 'test(conformance) or test(structural_op_parent)'
                                    107 passed
cargo nextest run --workspace       6331 passed, 13 skipped
cargo test --doc --workspace        clean, all six crates
cargo clippy --workspace --all-targets   clean
npm run typecheck / npx knip        clean
```

## Next

Remaining #5057 debt is 29 mutating + 3 read. The clusters left are undo/redo
(7, self-labelled "NOT cross-checked", with `restore_page_to_op` a constant
stub), attachments (3), import/export (3, and `export_page_markdown` returns a
rendered `String`, so the query leg needs a projection for it), op-log
maintenance (2), plus the ten commands #5057's own table never enumerated —
sync/peers (5) and a misc group (5). Recorded on the issue.

The spaces cluster remains blocked on the per-space Loro registry, unchanged
since session 1766.
