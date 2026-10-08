# Session 1932 — remove the resting indent guides (#5355)

The user found the vertical lines beside nested blocks hard to look at,
especially in dark mode. Each nested block drew its own guide, only beside
itself and only at its own depth, so the lines came out as broken
stair-steps. Maintainer decision: remove them; indentation already shows
nesting.

What shipped:

- `src/components/editor/SortableBlock.tsx`: the `depth > 0` guide `div` is
  gone, and so is `SortableBlockBody`'s `depth` prop, which only the guide
  used. The block's own `depth` still drives its indent padding.
- The drag guides in `BlockListRenderer.tsx` (shown only while dragging) are
  a different feature and stay.
- `SortableBlock.test.tsx`: the two guide tests become one asserting a
  nested block draws no resting guide.

Verified: the new test went red with the original guide put back (builder
and reviewer, each on a copy, restored and `cmp`-checked); vitest on
`src/components/editor/__tests__/`, 1349 passed, and on SortableBlock plus
BlockListRenderer, 257 passed; `npm run typecheck` exit 0; oxlint and oxfmt
clean on the changed files.
