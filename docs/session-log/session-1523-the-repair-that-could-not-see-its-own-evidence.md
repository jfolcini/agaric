# Session 1523 — the repair that could not see its own evidence

A user report of "tags still don't work well, we need to fix it ASAP" turned out to be one bug,
and the bug is a deadlock between two pieces of code that are each individually correct.

## The two halves

`migrate_orphan_tags_to_space` places a tag that has no space into the space that most often
references it. It read those references from `block_tag_refs`.

`reindex_block_tag_refs` writes that table, and refuses any ref whose tag is in a different space
from the referencing block — "Phase 3 — filter out cross-space tag-refs before inserting". Tags
are space-scoped; the cache mirrors the write-time gate. That is right.

Put them together and a tag with **no** space matches no block's space, so it earns **zero** rows
in `block_tag_refs`. The tag that most needs placing is precisely the tag guaranteed to have no
evidence available to place it. Every orphan tag scored zero references and took the
fallback — Personal — regardless of where it was actually used.

And the failure is absorbing. Once a tag is parked in Personal, a reference from Work is
permanently cross-space, so the gate keeps refusing the row, so the tag stays broken. There is no
state from which it recovers.

## What it looked like from outside

On the reporting vault: 48 live tag blocks, and `block_tag_refs` holding **one** row. Exactly one
tag in the vault worked — `book` — and only because it happened to be created in the same space
that used it. `meet`, `qa` and `pa` were created and referenced solely from Work and were all
sitting in Personal, invisible to the Work tag list, every `#[ULID]` reference rendering as a raw
ULID and matching no filter.

The user's phrasing was right and mine was wrong for two rounds. I first blamed a
`resolveBlockTitle` cache miss, then a missing space property at tag creation. Both were
plausible, both explained the symptom, and both were refuted by the op log — the second one by
`create_tag_in_space_inner`, which had already fixed exactly the thing I was "discovering" (#3081,
and the vault shows every tag created after 2026-07-23 landing correctly).

## The tests were the reason it shipped

Five tests covered `migrate_orphan_tags_to_space`, including one specifically about resolving the
space through `b.page_id`. All five seeded `block_tag_refs` by hand:

```rust
sqlx::query!("INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)", …)
```

That single line is the whole story. The fixture hands the migration the row that production
would have refused to create. Every test passes, the covered behaviour is real, and the one
condition that matters — *what happens when the cache is empty, which is always* — is the one
state the suite could not reach, because reaching it meant not writing that line.

The new test writes only the `#[ULID]` token into the block's content, asserts up front that
`block_tag_refs` is empty, and checks the tag lands in Work. Disabling the fix puts it back in
`…AGAR1CPER` — the exact production value — while the other six stay green, which is the proof
that they never covered this.

Generalisable: a fixture that seeds a **derived** table has quietly assumed the deriving step
succeeded. When the bug under test *is* that the deriving step declines, the fixture has
constructed a world the system cannot produce. Seed the input, not the cache.

## The fix, and why it unions

Reference counting now scans `blocks.content` for the `#[<tag_id>]` token — evidence that exists
whether or not the cache was allowed to record it — **unioned** with `block_tag_refs` rather than
replacing it, de-duplicated per `(tag_id, source_block)`. Rows in that table are genuine
references when they exist; the union means the change can only add information, and it keeps the
five existing tests meaningful instead of rewriting them to match a new answer.

## Repairing what already shipped

`migrate_orphan_tags_to_space` only ever fires for a tag with no space, so it cannot correct the
tags an earlier run already misfiled — they have a space; it is just the wrong one. That needs a
separate pass, and the interesting decision there was **not** to reuse the majority rule.

Majority is fine for placing a tag whose alternative is no space at all. It is not a good enough
reason to *move* a tag the user may have filed deliberately: the minority space's references
would be severed by the cross-space gate as a side effect of a repair nobody asked for. So the
repair moves a tag only when every live reference to it resolves to one and the same space, and
that space is not its current one. Unanimity can only take a tag from a space where nothing
references it to the one space where everything does.

Dry-run against the real vault selects exactly three rows — `meet`, `qa`, `pa`, all
Personal → Work — and leaves `book` and the 44 unreferenced tags alone.

## A note on repairing data at all

The first instinct was to fix the vault with SQL. That would have been wrong: `blocks` is a
projection. `loro_doc_state` holds a CRDT snapshot per space with `applied_through_seq`, and
`materializer_apply_cursor` tracks how far the op log has been applied. An `UPDATE` against
`blocks` is not a repair, it is a divergence — reverted by the next reprojection, or propagated as
a conflict to the peer. The repair emits `SetProperty` ops through the normal pipeline for the
same reason every other migration here does.

## Every boot, or once?

The repair pass was first written to run on every boot, copying its two neighbours.
`pages_without_space` and `migrate_orphan_tags_to_space` do that deliberately, and their doc says
why: their candidate — a block with no space — can still *arrive* later, synced in from a peer on
an older build. Their check is also nearly free, an indexed `space_id IS NULL` test.

Neither justification transfers. A *misfiled* tag is not something a peer can deliver: an old
peer emits a space-**less** tag, which the cheap every-boot path catches, and a current peer emits
a correctly-filed one. The population is closed — it is the damage this device's own earlier runs
did. And the check is not free: a misfiled tag is indistinguishable from a correctly filed one
until its references are counted, so there is no cheap precondition, and the pass costs a
sequential scan of `blocks` plus a `LIKE` join against every tag. Paying that forever to find
something that can only exist once is the wrong trade, so it is marker-gated in `app_settings`.

The marker is written even when zero tags moved. Its job is to retire the **scan**, not to record
that work happened; gating the write on `repaired > 0` would make every clean vault pay the scan
on every boot forever.

That gate then created a trap in the test that was already there. `misfiled_tag_moves_…` asserted
that a second call returns 0, meaning "the tag now agrees with its references, so it is no longer
a candidate". With a marker in front, that assertion passes for a second, unrelated reason — the
short-circuit — and the property actually under test stops being tested while the test stays
green. The fix is to delete the marker before the second call, so the scan really re-runs. Two
further tests pin the gate itself: that the marker is written on a clean vault, and that a tag
misfiled *after* it was set is deliberately left alone.

Worth keeping: adding a short-circuit in front of an existing function silently weakens every
test that asserted a zero/no-op result through it. The short-circuit is new evidence for the same
assertion, and an assertion satisfied by two independent causes is testing neither.

## The guard offered an escape hatch, and two of four didn't deserve it

CI failed on the dynamic-SQL justification guard (#646): four new runtime `sqlx::query(` sites
with no `// dynamic-sql:` marker. The guard's own message names the remedy — add the marker, then
re-anchor the baseline — and taking it for all four would have been a two-minute fix.

Two of them did not deserve it. `SELECT value FROM app_settings WHERE key = ?` and its matching
`INSERT OR REPLACE` are static SQL against a table the schema has had since migration 0053. The
guard's message says so itself, above the escape hatch: *prefer the compile-checked macro form*.
Marking them would have bought two permanent entries in a ratchet baseline — ownerless debt, in
exchange for skipping a codegen step — for queries that can simply be validated at build time.
They became `sqlx::query_scalar!` / `sqlx::query!`.

Only the two that genuinely cannot be macros kept a marker: a `json_each` fan-out over an id list
built at runtime, joined against a `ROW_NUMBER` window. There is no fixed arity to compile-check.

Worth keeping: a guard that ships with a documented way to silence it is offering two different
things — an exemption for the case it cannot judge, and a shortcut for the case you did not want
to do properly. The message reads the same either way. The question that separates them is whether
the construct the guard prefers can actually express this query, and for half of these it could.
