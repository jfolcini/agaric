# Session 1967 — TagList renders only what's visible; every list view is bounded per PR (#5366)

The Tags view rendered every tag in a plain list, and nothing on a PR checked
that a list view stays bounded or that opening it doesn't fan out IPC.

What shipped:

- `TagList` uses `useVirtualizer` the way PageBrowser does (inside a
  `ScrollArea`, keyed by tag id); rows keep their list semantics plus
  `aria-setsize`/`aria-posinset`, and tabbing into a row past the window
  scrolls it in. The tag colour state moved into `src/hooks/useTagColors.ts`,
  keeping the component near the size guideline.
- `e2e/perf.spec.ts` gains four per-PR tests (no `AGARIC_PERF`): Agenda,
  Pages, Tags and Search, each seeded with 500 rows, assert at most 60
  rendered rows and pin the IPC calls on open (Agenda 3, Pages 7, Tags 2,
  Search 4), printing the command list on failure. Pages drops to 3 when
  #5446 makes the visible-row prefetch touch-only.
- `e2e/tag-list-virtualization.spec.ts`: 120 Tab presses reach a tag past
  the first window, with the first row unmounted.
- `e2e/AGENTS.md` "Performance runs" describes the per-PR count tests.

Verified: every tag rendered → the windowed unit test, the Tags count (503
rows) and the Tab spec red; an extra call per Pages row → the Pages pin red
(25 vs 7); the wrong scroll element → the Tab spec red; five hook breaks and
an `aria-setsize` break red; all on copies, restored and `cmp`-checked. Full
vitest 20,810 passed; the four count tests 12/12 under `--repeat-each=3`;
tag-management, tags-lifecycle and mobile-overflow 62/62; typecheck, oxlint,
oxfmt, knip clean.
