# Session 1770 — review notes from #5069, #5070, #5072 and #5073

The batched follow-up for the four PRs merged in the previous sweep. Every note
in it was non-blocking on an approved, green PR, so none of them caused a push
onto an approved branch; they land here as one review round instead of four.

## The one that was a real latent bug

#5072's reviewer pointed out that `useViewportObserver` LATCHED the first
scroll container it found and never re-probed. Reading Radix's
`ScrollAreaScrollbar` confirmed the consequence: the viewport is
`overflow-y: hidden` whenever no scrollbar is enabled, and `scroll-area.tsx`
hardcodes `type="hover"`, so `ScrollAreaScrollbarHover` enables it on
pointerenter and drops it again on leave. A row attaching while it is hidden
walks straight past the viewport and adopts whatever scroller sits above it —
permanently, with no event able to correct it.

The root is now a `useState` re-derived on every attach; only a CHANGED answer
rebuilds the observer, so the rebuild stays rare rather than the walk. An
attach that finds no scroller never downgrades an adopted root to the viewport
— a row may simply have mounted outside the container.

The walk itself moved to `src/lib/scroll-parent.ts`, shared with
`DiffDisplay`'s `findScrollableAncestor`, which was the same loop on a wider
axis test. Two exports, `scrollParentY` and `scrollParentAny`, over one walk.

Three tests cover it: an unchanged answer does not rebuild the observer; a
nearer container that becomes scrollable is adopted (plain divs, stating the
mechanism); and the same against the REAL `ScrollArea`, so the walk is proven
against the DOM the app renders — Radix puts a `position: relative` Root with
no overflow of its own between the viewport and whatever scrolls outside it,
and the walk has to pass through that without stopping.

The `ScrollArea` test took two attempts to make honest, both caught by review
rather than by me. As first written it set the viewport to `scroll` before its
only attach, so the old code's first probe found the viewport too and the test
passed either way: the latch only bites once a root has been ADOPTED, and an
attach that finds nothing leaves it unadopted. Reverting to the latch reddened
only the plain-div sibling. My first correction wrapped the `ScrollArea` in an
outer scroller so the first attach would adopt the wrong box — but located that
wrapper with `live.closest('div[style*="overflow-y"]')`, and `closest` matches
the element itself, so `outer` and `live` were the same node and both
assertions were trivially true. The test now looks the wrapper up by its own
`data-outer-scroller` attribute and asserts `outer !== live` before either
comparison, so a lookup that collapsed them again fails loudly instead of
passing for two reasons.

Both `overflowY` assignments in it are deliberate. Radix drives the viewport
between `hidden` and `scroll` from `scrollbarYEnabled`, which it decides by
MEASURING an overflow; jsdom does no layout, so the viewport mounts already
enabled and never moves — the forced `hidden` is what reproduces the
pre-scrollbar state a browser starts in. Reverting to the latch now reddens
both root tests.

## A false premise I had propagated

#5070's PR body and a comment in `_validate.yml` both said the vitest coverage
merge job "only runs when every shard passed". It does not — `--mergeReports`
runs before `npm run build`, and the job is not gated on shard success. I had
copied the claim out of #5058's body without checking the workflow. The comment
is corrected here, and the correction was posted on the issue when it was
found.

## Mock-conformance notes

- `create_space` pushed `position: 0` in its op payload while storing
  `position: 1` in the row. Now it pushes `row.position`.
- `set_page_aliases` compared `deleted_at !== null`, which lets any other
  falsy tombstone shape through. Truthiness check now.
- `nextDenseRank`'s doc-comment claimed more than it delivers: the rank
  survives only until the next ROOT renumber, because
  `insertAtSlotAndRenumber(null, …)` densifies the whole cross-space
  `parent_id = null` group. Stated at the function, and the
  `move_blocks_to_space` waiver reason corrected to match — the mock does not
  MAINTAIN per-space root positions, which is broader than "models no
  per-space positions".
- `restore_page_to_op` carried a comment saying page scoping is not modelled,
  which #5069 had made false. Deleted, along with a `depth < 0` branch its only
  caller already refuses.
- Trimmed the archaeology out of two `conformance-coverage.test.ts` comments:
  the rules they state are load-bearing, the story of which PR taught the
  parser which convention is not.

## Verified

- `npm run typecheck` — clean.
- `npx vitest run` — 833 files, 19222 passed, 1 expected fail, 37 skipped.
- `cd src-tauri && cargo nextest run --workspace -E 'test(conformance)'` — 107
  passed.
