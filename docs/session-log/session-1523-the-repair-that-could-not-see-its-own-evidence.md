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
space through `b.page_id`. Both of the ones that gave the tag a reference seeded `block_tag_refs`
by hand:

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

## The fix, and the union that did not survive review

Reference counting now scans `blocks.content` for the `#[<tag_id>]` token — evidence that exists
whether or not the cache was allowed to record it. The first version **unioned** that scan with
`block_tag_refs`, on the argument that rows in the cache are genuine references when they exist, so
the union could only add information — and it kept the two seeding fixtures meaningful.

Review took that apart. `block_tag_refs` is derived from exactly those tokens, so for a live block
it is a strict subset of the scan; the only row it can contribute that the scan does not is a
*stale* one whose token has since been edited out — a wrong vote, not an extra one. The honest
reason the arm was there was to keep two fixtures green, which is the fixture shaping the
production query: the thing this whole session is about. The arm is gone, the two fixtures now seed
the token like production does, and a new test pins that a stale cache row pointing at Work does
not put a tag there.

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

Neither justification transfers to the same degree. To a first approximation a *misfiled* tag is
this device's own doing: an old peer emits a space-**less** tag, which the cheap every-boot path
catches, and a current peer emits a correctly-filed one. Review found the two holes in "closed" —
a peer still on the buggy build can sync in a tag it already misfiled (heals once that peer
upgrades and syncs its repair ops), and the every-boot path itself still mints one when a
space-less tag arrives before the content that references it. Both small; the doc now says so
instead of claiming impossibility, and the marker is versioned so the pass can be re-armed. And
the check is not free: a misfiled tag is indistinguishable from a correctly filed one
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

Two kept a marker at first. Review caught that one of those markers was false too: the
misfiled-tag query claimed a `ROW_NUMBER` window it does not have, and has no binds at all — it is
fully static SQL, the easiest query in the diff to compile-check. It is a `query!` now, and the
baseline entry it would have bought is gone. The other marker's stated reason ("no fixed arity")
was also wrong — one bound JSON string fanned out by `json_each` *is* fixed arity — but the
conclusion survives for a different reason, found by trying: sqlx's compile-time SQLite analysis
cannot type a `json_each(?)` used as a FROM source (`no such table column: json_each.value`). The
marker now states that, so the next reader does not have to re-derive it.

Worth keeping: a guard that ships with a documented way to silence it is offering two different
things — an exemption for the case it cannot judge, and a shortcut for the case you did not want
to do properly. The message reads the same either way. The question that separates them is whether
the construct the guard prefers can actually express this query, and for most of these it could.

## Review round: moving the tag was half the repair

Two blocking findings, and together they said something worse than either alone: the PR moved the
tag and did not restore the behaviour the move exists for.

**The cache stayed empty.** `repair_misfiled_tag_spaces` emits `SetProperty`, and `SetProperty`
dispatch enqueues no tag-ref work — by design, since property values are never scanned for tokens.
The per-block `ReindexBlockTagRefs` is keyed on the *source* block, and the Work blocks carrying
`#[meet]` were never touched. The boot backstop in `lib.rs` fires only when `block_tag_refs` is
entirely empty; on the reporting vault it held one row (`book`), so it never fired. Net: after the
repair boot, `meet` was in Work and in Work's tag list, and the Tag filter, the backlink
projection and `usage_count` — all of which UNION `block_tag_refs` — still returned nothing for
it. The marker then retired the pass. The absorbing failure this session set out to remove,
relocated. `bootstrap_spaces` now enqueues `RebuildBlockTagRefsCache` then `RebuildTagsCache`
(that order: `usage_count` reads the refs table) whenever either migrator moved a tag. That covers
`migrate_orphan_tags_to_space` too: the empty-table backstop does run after bootstrap on the same
boot, so a *fully* empty table heals in one boot — but any surviving row disables it for good, and
`book` is exactly such a row.

The part worth keeping is why the tests missed it. Every test stopped at `blocks.space_id` — they
asserted the thing the code writes, not the thing the user sees. The new boot-level tests assert a
`block_tag_refs` row for the referencing block, that the Tag filter returns it, and that
`usage_count` is 1. Disabling the enqueue reddens exactly those two tests and nothing else.

**The move bypassed the Loro prune.** The repair copied `migrate_orphan_tags_to_space`'s
hand-rolled `UPDATE blocks SET space_id`. That neighbour gets away with it because its tags have
no old space — #2907's prune gate is a no-op by construction. The repair is a genuine reassignment
between two registered spaces, which is exactly what `apply_set_property_via_loro` exists for: it
captures the old space *before* the column is overwritten, purges the tag out of the old doc,
projects the column, hydrates into the new doc. Pre-writing the column makes `old == new`, so no
prune, and the tag stays durably a member of both docs — a peer importing the old doc re-stamps
the old space, and the marker means nothing corrects it. The record now goes through
`apply_op_projected` in the same transaction (what `set_property_in_tx_with_declaration` does at
its step 4; the validating wrapper itself is not used because its rejections would be boot-fatal
here and every candidate satisfies them by construction). The test follows the existing #2907
one: precondition that the tag is in Personal's doc, then after the boot it is absent there,
present in Work's, and a fresh peer importing each snapshot sees it only in Work.

Also from review, each with a test that fails without it: the "unanimous" rule ignored explicit
`block_tags` associations, so a tag applied via the picker to Personal blocks and inline-referenced
from one Work block would have been moved and its Personal associations orphaned — the severance
the rule was written to prevent; and both queries resolved a source block's space through its page
without the `p.deleted_at IS NULL` guard that `resolve_block_space` and `compute_desired_pairs`
carry, so a block on a trashed page voted for a space the gate would not agree with.

## The repair moved the tag and did not fix the symptom

Two reviewers, independently, both blocking, and together they say the thing worth recording:
**the fix wrote the field and stopped there.**

`repair_misfiled_tag_spaces` emitted only `SetProperty`. `invalidations_for_op` maps that to the
two agenda rebuilds and nothing else, so nothing reindexed `block_tag_refs` for the blocks
referencing the moved tag — and those rows are exactly the ones the cross-space gate had been
refusing. The boot backstop only fires when that table is *entirely* empty, and the affected vault
holds one row. So after the repair: `space_id` correct, refs still absent, tag filter still empty,
`usage_count` still 0 — and the marker means it never runs again. The absorbing failure this
function exists to remove, relocated one table over.

The tests are why it got that far. All three asserted `blocks.space_id`. Every one of them passed
on a repair that fixed nothing a user could see, because they asserted **what the code writes**
rather than **what the feature promises**. The new tests reproduce the reported vault and assert
the `block_tag_refs` row, the tag filter returning the block, and `usage_count == 1`.

## Copying a sibling copied its exemption too

The second blocker: the repair used a hand-rolled `UPDATE blocks SET space_id`, copied from
`migrate_orphan_tags_to_space`. But that function's `old_space` is `None`, so #2907's prune gate is
a no-op *by construction* — it is not doing without the prune, it simply has nothing to prune. The
repair is a genuine reassignment between two registered spaces, so skipping the Loro
prune/hydrate leaves the block durably a member of **both** docs, and a peer importing the old one
re-stamps the old space.

The pattern is what makes this worth keeping: a neighbouring function that looks like it skips a
step is not evidence the step is optional. It may be exempt for a reason that does not transfer,
and the reason is usually invisible at the call site.

## Fixture-shaped production code

One non-blocking note landed harder than the blockers. `majority_space_by_content_refs` unioned
`block_tag_refs` into the content scan, and I had kept that arm to leave existing fixtures
meaningful. `block_tag_refs` is derived *exclusively* from `#[ULID]` tokens in `blocks.content`, so
for a live source block it is a strict subset of the scan — except when stale, where it votes for
a reference the content no longer has. A wrong vote, not an extra one.

So the arm existed only to keep two fixtures green, in a change whose entire subject is a fixture
that shaped what production could see. Dropped, and the fixtures now seed content tokens the way
production does.

## Corrections to the reviews

They were right on both blockers and wrong in three details, each checked rather than assumed:
the empty-table backstop self-heals in **one** boot, not two (`bootstrap_spaces` runs before
`spawn_boot_maintenance`); "delete the UPDATE and let the background `ApplyOp` do it" is not how
local records are applied, since `commit_and_dispatch` computes invalidations and the local path
applies in-tx; and the false `dynamic-sql` marker on the majority query was wrong about the reason
but right about the exemption — sqlx's compile-time analysis rejects `json_each(?)` as a FROM
source, so the macro genuinely cannot express it. The marker now states the real reason.
