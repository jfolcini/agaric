# Session 4045 — Page-heavy vaults: a bench fixture, a tail-only rank reprojection, one page list for the pickers

`Refs #6527`: what was left after #6673. One PR, a commit per item.

## What shipped

- **Bench fixture.** `interactive_slo`'s `page_heavy` module seeds `PAGES` root pages of `BLOCKS_PER_PAGE` blocks in one engine-backed space and reports five probes on it, measurement only. `docs/architecture/operations.md` names both vault shapes.
- **Tail-only reprojection.** A block seeded into its space's engine at space assignment sends SQL the ranks from its slot on (`reproject_dense_positions_from`) where it sent the whole sibling group. For a new page that is one rank where it was every page and tag of the space.
- **One page list for the pickers.** The Links to / Linked from pickers, the ref-valued filter picker and a property's ref picker read `pageIndexQuery` (`src/lib/page-index.ts`), one TanStack query per space, re-read through the name-change bus.

## Decisions and traps

- **The siblings before the slot are not always at their ranks.** `apply_purge_block_via_loro` removes a node and reprojects nothing, so a purge leaves a gap in its group's SQL ranks; the old whole-group write healed it at the next create. A tail write onto that gap puts two siblings on one rank. So the tail is written only when the sibling right before the slot sits at its rank, else the whole group is. That one read does not prove the prefix dense: undoing a move ranks live siblings only (`history::reproject_live_sibling_group`), so a trashed block can keep a stale rank that cancels a gap. The tail then leaves those ranks as it found them; every rank it writes is the engine's, so the live order stays right.
- **The create path keeps the whole-group write.** The first version gave `apply_create_block_via_loro` the tail too. Review found that a root page or tag never reaches that branch (its create projects SQL-only until its `space` op hydrates it), so it bought #6527 nothing, sat on the busiest write path, and no test could fail on it. Dropped.
- **The whole-group write is the oracle.** In a test build every tail write is followed by it, and it must change no row. With the predecessor check removed, both purge tests die on it. Both halves of the workspace suite ran with it on and it never fired. A bench is built with `test-util` but without debug assertions, so it times the tail alone.
- **Replayed ops and the repair's seed keep the whole-group write.** On replay SQL holds the ops after the one applied, so the siblings before the slot are not known to follow the engine.
- **The space's own block is the first root of its doc**, not the last: it is there before any page. The first version of the fixture put it last, and a create then renumbered it with every page behind it. The command-level count test caught it; `assert_shape` in the bench compares the two root orders.
- **Seeding the engine through its own create is quadratic**, since that create reads every sibling to find its slot. `LoroEngine::seed_block_at_slot` is a `test-util` seam that takes the slot.
- **The engine's sibling scans still cost as much as the SQL half did.** Timed alone in an optimized build (`release-test` profile) at 33,000 root siblings: `apply_create_block` 55 ms, `children_ordered_block_ids` 45 ms; at 20,000: 30 ms and 24 ms. In a test build at 20,000 pages the command went from about 350 ms to about 245 ms, inside a 225 to 335 ms band. So the issue's two budget gates were not written: no wall-clock budget separates this fix from its revert in the lane that would run it. The counts are pinned exactly instead, and the bench's write probes report the times weekly. A test-build harness that printed the 20K figures was dropped in review as a second copy of those probes. Cutting `ranked_slot` needs either new engine state or a change to where a root block lands; that went to the issue as a question.
- **Step 2 of the lookup item was built on the issue's own measurement** (65 to 83 ms and 5.3 MB of JSON a listing at 33,335 pages), with the fixture's probe dispatched on the branch to confirm it.
- The New page dialog's similar-pages list and the `[[` picker still fill their own matcher cache; the issue keeps that cache out of scope.

## Verified

- Red first: an append sent 6 ranks where 1 was expected, a mid-list seed 4 where 3, with the hydrate path back on the whole-group write. The page-index tests died on three mutations (no bus subscription, tag changes invalidating, no caching), the ref-picker test and the e2e pin on a second listing.
- `cargo nextest run --workspace` in two partitions, on the rebased branch after review: 4002 and 3996 passed. `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `just gen-sqlx` (one new entry), `prek run --hook-stage manual --all-files`.
- Full vitest (one red, the hand-stub ratchet on the new test file, fixed and re-run with the ratchet), `npm run typecheck`, `npm run lint`.
- The bench fixture ran once in a dev build (`--test`, its group alone): shape assertions and all five probes.
- Playwright: `perf.spec.ts` and the Advanced Query, property, pages-filter, references-filter, rename and New page specs. The rest of the lane and WebdriverIO are CI's run.
