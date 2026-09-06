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
