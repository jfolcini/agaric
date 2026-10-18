# Session 2563b — a wide equation is tapped before KaTeX shrinks it

**Asked:** fix the cause of a CI flake in `e2e/diagram-legibility.spec.ts`,
"a wide equation being edited at 390 px scrolls inside its node view
(#5693)" (PR #5844, shard 1). `focusBlockById` timed out for 15 s with
`<div class="min-h-[60px]"> from <li aria-hidden="true"> … intercepts
pointer events` on every attempt.

**Premise corrected:** the intercepting `<li aria-hidden>` is not the
offscreen placeholder from `SortableBlockWrapper` (that one carries
`block-placeholder` and no child). It is `SentinelDropZone` in
`BlockListRenderer.tsx`, the drop target after the last row, whose child is
the `min-h-[60px]` div. The seeded block is the last row on Projects, so
the sentinel sits directly under it.

**Cause:** the static `$$…$$` renders through a lazy `KatexMath`; until the
chunk arrives, its Suspense fallback (`marks/math.tsx`) shows the raw
LaTeX, which wraps at 390 px. Measured with the chunk held by a route: the
block is 152 px tall on the fallback and 99 px once KaTeX renders, and the
sentinel starts at the fallback's bottom edge. `clickIntoStaticBlock`
measures the box once and clicks `height - 2`; when the box is taken on the
fallback and KaTeX lands before the click, that point is 50 px below the
shrunk block, inside the sentinel, and stays there for every retry. Locally
the chunk is cached before the measure; under CI load it is not.

**Users:** not affected. A person taps what is on screen; the stale point
exists only because the test measured one layout and clicked another.

**Fix:** the spec waits for the rendered equation (`katex-block .katex`)
before focusing the block, as its sibling test already does.
`clickIntoStaticBlock`'s doc now states that the block must have finished
rendering. The desktop mermaid focus test in the same file goes through the
same helper but its block grows on render, so the corner stays inside it:
20/20 under 6× CPU throttling, left alone.

**Reproduction:** a throwaway copy of the test under
`Emulation.setCPUThrottlingRate` 6, `--repeat-each=20 --workers=2`: 18 of
20 failed with the CI's intercept message before the fix, 0 of 20 after.

**Ran:** `diagram-legibility`, `mobile-editor`, `math-katex`,
`mermaid-roundtrip` specs (36 passed); `npm run typecheck:e2e`;
`npm run lint`.
