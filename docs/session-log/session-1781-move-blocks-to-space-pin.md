# Session 1781 — the last name #5057 owns

`move_blocks_to_space` is pinned by `spaces_lifecycle.json`, and #5057's own
list is done. What remains in `NOT_YET_PINNED_MUTATING` is
`import_bibliography` and `import_markdown`, which #5071 owns, alongside
`export_page_markdown` on the read side.

## An arriving block lands FIRST, which is not what anyone assumed

The brief for this work said to re-rank the destination by `nextDenseRank`'s
rule — append. The backend does the opposite, and the fixture is what
established it: moving `Drafts` into `inbox` gave `Drafts` rank 1 and pushed the
space block itself to 2. Why, in full, is derived once at the mock's call site
(`move_blocks_to_space` in `src/lib/tauri-mock/handlers/blocks.ts`); it predicts
three separate backend-authored runs exactly, which is why a model is written
down there rather than the observation alone.

## A multi-block move is deterministic, and this session had that wrong

The first pass drove a *single*-block move on the belief that a multi-block
move's order came out of raw id comparisons — emergent, and not something to
encode as contract. That belief was wrong, and the mock shipped a real defect
behind it: the handler re-ranked the destination inside its per-block loop, so
each arrival prepended over the one before it and `[A, B]` came back as `B, A`.
That is the ordinary multi-select move from `PageBrowserBatchToolbar`, not an
exotic case.

The ids never decide. `hydrate_page_subtree_into_engine` runs once per moved
block and seeds each with the `position` it still holds in the space it is
leaving; the source group is never reprojected, so within one source space those
are distinct and `legacy_slot`'s `(position, block_id)` tiebreak on the id never
fires. A multi-block move arrives in SOURCE RANK order. `spaces_lifecycle.json`
now pins that with a THREE-block step, because two cannot: the fix moved the
ordering out of the per-block loop into one pass after it, so "iterate the
caller's list instead" is the regression the fix itself invites, and with two
arrivals the listing that catches the old reversal is exactly the listing a
list-order handler also gets right. Three arrivals separate all four candidate
orders — rank, id, listed, and listed-reversed — and each of the three wrong
rules was shown red against a copy.

The source group is never reprojected, so the arrivals have to be a SUFFIX of
it: moving a page out of the MIDDLE strands every later sibling's
`blocks.position` above its dense rank in the source doc, which the #891 parity
guard fails the fixture on. That is a backend staleness, filed as #5100, and it
is why the multi-block step runs before the single-block one.

The two cases still not modelled are named at that call site: an arrival whose
source rank exceeds a resident's creation position, and two arrivals from
different source spaces holding the same rank.

## Two things the brief got wrong about the fixture

"Create a page in the first space, then move it into the second" does not
redden. That page is created at rank 2 and arrives at rank 2: the position never
changes, so a pin over it proves nothing. Moving a *seed* page does — `Drafts`
at rank 3 in the harness space becomes rank 1 in the destination.

There is also no "before" query leg to be had. `expand_query_args` expands
`$SPACE` and `S<n>` labels only, never a `C<n>` created label, and every query
step runs after every op. So the destination space cannot be named by a read at
all, and the one query step that exists observes the harness space after the
fact: `Drafts` was seeded there and is gone. Both limits are stated in the
fixture description rather than left for the next person to rediscover.

## The refusal arms were not free

The mock's handler validated nothing about its target: any string was accepted
as a space. It now mirrors `require_live_space_in_tx` — a live block carrying
`is_space = 'true'` — which in turn meant `undo-space-move.test.ts` had to seed
its two spaces as real space blocks rather than bare ULIDs. That test had been
passing against a handler that checked nothing.

## Both arms shown red

Reverting the re-rank reddens the snapshot on `position`, on exactly the two
rows the re-rank touches and nothing else. Reverting the target validation
reddens the refusal op, which reports that the command succeeded where the
fixture declared `validation`.

## One divergence found and not fixed

The mock's revert path does not restore `position` when a cross-space move is
undone, while the backend's reverse `SetProperty(space)` re-hydrates and
re-ranks. Nothing pins it, and it predates this change — in the other direction,
since before this the mock never ranked on the way in either. It needs its own
fixture, so it is named here rather than folded in.

## Verified

The conformance fixture test passes without `CONFORMANCE_UPDATE`, which is what
makes the expectation the backend's rather than an author's. Workspace
conformance 107 passed; the mock suite 962; the full frontend suite 19,263;
typecheck clean; the spaces e2e lane 8 passed, so the re-rank does not disturb
the Move-to-space flows.
