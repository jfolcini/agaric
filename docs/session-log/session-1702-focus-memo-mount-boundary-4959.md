# Session 1702 — focus-move memo scoping and the mount-boundary dead end (#4959)

Three parts of #4959, all in the block-tree render path: the last memo-busting
prop on a row, arrow navigation stopping at the mount cap, and two doc
paragraphs that told the next maintainer a measurement had never been run.

## The memo

`BlockListRenderer` passed the page-wide `focusedBlockId` to every
`SortableBlockWrapper`. That value is the same for all N rows and changes on
every focus move, so the wrapper's `React.memo` shallow compare failed for all
of them when exactly two rows' focus state had changed. Every other prop was
already primitive or identity-stable by design — the sibling aria pair was split
into two numbers for this reason (#1267 did the same for drag state) — so focus
was the one prop left holding the memo open.

The wrapper's only use of it was `const isFocused = focusedBlockId === block.id`.
Grepping every consumer found exactly two: `BlockListRenderer` and the wrapper's
own test fixtures. (`LinkedReferences.tsx:455` and `BlockTree.tsx:1522` also pass
a prop of that name, but to `LinkedReferenceList` and `BlockListRenderer`
respectively — neither is this component.) So the derivation moved up one level:
the parent passes `isFocused={focusedBlockId === block.id}`, the wrapper takes a
boolean, and the internal comparison is gone.

`BlockListRendererFocusRerender.test.tsx` measures it with the same probe
`BlockListRendererDragRerender.test.tsx` (#1267) uses: the mocked leaf
`SortableBlock` is a plain function, so a bump in its per-id render count means
the memoized wrapper above it re-rendered. Five rows, everything but
`focusedBlockId` held identity-stable across the rerender — the production
invariant on a bare focus move. Focus A → B, then a second case clearing focus
entirely.

Red against a copy of `BlockListRenderer.tsx` + `SortableBlockWrapper.tsx` with
the pre-fix shape reinstated (the page-wide id forwarded as a prop again):

```
expected 2 to be 1 — BLK_C, at :111 (re-renders only the two rows whose focus changed)
expected 2 to be 1 — BLK_A, at :126 (re-renders only the previously focused row when focus is cleared)
```

That is the whole claim: the bystanders bumped to 2 with the prop present and
stay at 1 without it.

## The mount boundary

`BlockTree` hands the orchestration hook `zoomedVisible`, which *is*
`mountedVisible` — the mount-capped list. `handleFocusNext` only moved when
`idx < collapsedVisible.length - 1`, so on a page past `INITIAL_MOUNT_LIMIT`
ArrowDown at row 500 did nothing at all and the only way on was the
`MountBoundaryRow` button. The #3276 reveal effect does not cover this: it keys
on `focusedBlockId` already naming an unmounted row, which arrow navigation
cannot produce.

The hook now takes an optional `revealNextMounted: () => FlatBlock | null`.
`BlockTree` implements it against the machinery it already owns — index
`zoomedVisible.length` of `uncappedZoomedVisible`, `revealIndex` to mount it —
and returns the row. Only when the focused row is the last mounted one does
`handleFocusNext` consult it; the reveal and the `setFocused` batch into one
render, so the row mounts already focused, the same reveal-then-focus the jump
path uses. Passing a callback rather than the uncapped list keeps the
`MountedBlocks` brand gate intact: nothing hands a command path a list it must
not walk.

Three cases in `use-block-action-orchestration.test.ts`. Red against a copy of
the hook:

```
# guard restored to `: null` (no reveal at the boundary)
expected "vi.fn()" to be called 1 times, but got 0 times — :222 (reveals and focuses the first row past the mount cap)
expected "vi.fn()" to be called 1 times, but got 0 times — :236 (stays a no-op at the true last row)

# reveal hoisted ahead of the in-list lookup
expected "vi.fn()" to not be called at all, but actually been called 1 times — :250 (does not reveal while mounted rows remain below the focused one)
```

The second and third are the arms that keep the first honest: the no-op at the
true last row still holds when the reveal returns null, and mid-list ArrowDown
never touches the mount cap at all.

## The doc paragraphs

`use-block-mount-limit.ts` carried two claims that were false when written and
false since: the file header said #2467's Measure phase "has not been run", and
`INITIAL_MOUNT_LIMIT`'s doc called it "Unmeasured". It was run. #2586 landed the
numbers in `docs/architecture/editor-and-content.md` § "Measured envelope (#2467
Measure phase)" — the fixture is
`src/components/editor/__tests__/BlockTree.scale-envelope.test.tsx`, and the
conclusion is that 500 is conservative with headroom above it. Both paragraphs
are gone, replaced with one line each pointing at that section. Both the section
heading and the fixture were confirmed present before citing them, and
`scripts/check-doc-code-paths.mjs` passes.

## Not done

`docs/FEATURE-MAP.md` was left alone: it does not mention the mount envelope,
the mount boundary, or keyboard navigation anywhere, so there was nothing to
update. `handleDeleteBlock` was left untouched — #4972 is open against the same
file and the edit here is confined to `handleFocusNext` and its parameter.

No e2e spec. The memo is a render-count property that only a profiling probe can
observe, and the boundary case needs a page past 500 collapse-visible rows; both
are pinned at the unit layer where the counts are exact.
