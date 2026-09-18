# Session 1781 — the last name #5057 owns

`move_blocks_to_space` is pinned by `spaces_lifecycle.json`, and #5057's own
list is done. What remains in `NOT_YET_PINNED_MUTATING` is
`import_bibliography` and `import_markdown`, which #5071 owns, alongside
`export_page_markdown` on the read side.

## An arriving block lands FIRST, which is not what anyone assumed

The brief for this work said to re-rank the destination by `nextDenseRank`'s
rule — append. The backend does the opposite, and the fixture is what
established it: moving `Drafts` into `inbox` gave `Drafts` rank 1 and pushed the
space block itself to 2.

The cause is a scale mismatch in `legacy_slot`. A root group orders by
`(legacy position meta, block_id)`, and the two sides of a move are measured
differently. A block already in the space carries the position it held when it
was created, and `create_block_in_tx` with no position appends across the whole
`parent_id IS NULL` set — every space and every page in one count, so the
numbers there are large. An arriving block is seeded by
`hydrate_page_subtree_into_engine` with its small per-space dense rank. Small
key wins, so the arrival prepends.

That model predicts three separate backend-authored runs exactly, which is why
it is written down rather than the observation alone.

The mock mirrors it, and its call site names the two cases it does **not**
model: an arrival whose rank falls below the destination's oldest member, and
two arrivals whose ids order against their ranks. The fixture therefore drives
a *single*-block move — a multi-block move's order depends on raw id
comparisons that would be encoded as contract while being emergent.

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
