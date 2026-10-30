# Session 3176 — the fuzzer moves pages and tags across spaces

Item B3 of #6054, first half: the differential fuzzer now emits `SetProperty(space)` and `move_blocks_to_space`, and the mock declines a link to a block in another space or in none, as `write_block_link_diff` does. Session 3012 said B3 had to model that decline before the cross-space exclusion could go. Both are done.

**Mock.**
- `linkable()` in `link-index.ts` is the backend's INSERT condition: the target is live, and in the source's space, or the source has no space. A target in no space is dropped.
- A restore re-indexes the restored block's referrers (`relinkRestored`, the twin of `resolve_referrers_of`).
- The mock now stores the kind of an edge it keeps but can no longer re-link (`keptLinkKinds`). The backend keeps the old row's kind, and the grouped-backlinks kind filter reads the stored kind.
- `move_blocks_to_space` and `set_property(space)` refuse a block that is not a page or a tag (`rejectNonSpaceHolder`). Both re-rank arrivals through one helper. A move into the space a root already holds is not an arrival, so ranks stay put.
- `allOrNothing` now snapshots the link index, so a refused batch reverse puts the link kinds back.

**Fuzzer.** It renders space moves of a page and of the seed tag, plus a refused move of a content block. Before moving the tag, it plants `[[S2]]` on the seed page, so a woven edit can name the tag from its new space and reach the decline. The cross-space exclusion is lifted. Five backend-authored fixtures pin each piece.

**Kept out.** The `#[…]` exclusion stays. The backend keeps a tag's old-space refs after the tag changes space, until the next full rebuild (#6209), so the two stacks give different answers until then.

**Not here.** The `list_page_links` roll-up, the links that paste, batch create, draft flush, import and duplicate never record, and moves of pages that hold content or links. These are B3b.

**Review.** A separate reviewer found and fixed four things: the same-space ranking, the rollback gap, the unreached decline, and a stale re-export that knip reds. Another reviewer checked those fixes. Each mock change was shown red by a one-command mutation.

**Suites:** conformance nextest; the fuzz lane at 256 and 1500 cases; vitest over `src/lib`, `src/stores`, `src/hooks` and `src/components/block-tree`; typecheck, lint, knip, clippy, sqlx-offline check, and the manual-stage hooks. About 800 Playwright tests ran: `@pages`, `@spaces`, `@graph`, `@markdown`, undo, history and trash.
