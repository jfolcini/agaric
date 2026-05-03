# PEND-16 — New daily journal page renders two empty blocks instead of one (and focus lands on the wrong / not-yet-mounted block)

## Symptom

Navigate to a date that has no daily journal page yet (e.g. "today" on first launch in a fresh space, or any past/future day the user has never opened) in **daily** mode. Expected: a single empty content block appears under the day heading, with the cursor immediately active inside it so the user can start typing. Actual: **two empty content blocks** are created back-to-back, and depending on render timing the cursor may not actually be inside either of them — the user has to click into a block before they can type.

The duplicate is reproducible from a clean state with no journal templates configured (i.e. the default for new users / new spaces). The bug also surfaces, less reliably, when a template *is* configured — in that case it manifests as an extra empty block tacked onto the end of the template-seeded blocks.

## Root cause — two independent auto-creators race for the same new page

There are two completely separate "auto-create the first block on a fresh daily page" paths in the frontend, and they fire in parallel against the same `pageId` without coordination:

### Path A — `useJournalAutoCreate` → `useJournalBlockCreation.handleAddBlock`

`<ref_snippet file="/home/javier/dev/agaric/src/hooks/useJournalAutoCreate.ts" lines="25-33" />`

In daily mode, when no page exists for `currentDate`, this effect calls `handleAddBlock(dateStr)` exactly once (guarded by `autoCreatedRef`).

`handleAddBlock` (in <ref_file file="/home/javier/dev/agaric/src/hooks/useJournalBlockCreation.ts" />) does:

1. `await createPageInSpace({ content: dateStr, spaceId: currentSpaceId })` — atomically creates the page block + `space` ref property (lines 83-90).
2. `setCreatedPages(...)` + `onPageCreated(...)` + `useResolveStore.set(...)` (lines 91-93). **These trigger React re-renders of `JournalPage` → `DaySection` while `handleAddBlock` is still mid-flight.**
3. Loads per-space `journal_template`, falls through to legacy `journal-template` page, falls through to a single empty block via `createBlock({ blockType: 'content', content: '', parentId: pageId })` (lines 96-148). The no-template fallback is the common path for new users.
4. `await pageBlockRegistry.get(pageId)?.getState().load()` — only no-ops if BlockTree hasn't mounted the per-page store yet; once BlockTree has mounted, this refetches.
5. `useBlockStore.setState({ focusedBlockId: block.id })`.

### Path B — `BlockTree`'s `autoCreateFirstBlock` effect

`<ref_snippet file="/home/javier/dev/agaric/src/components/BlockTree.tsx" lines="298-346" />`

Whenever a `BlockTree` finishes loading and finds `blocks.length === 0 && rootParentId !== null`, it creates an empty content block on its own and writes it into both the per-page store and `useBlockStore.focusedBlockId`. `DaySection` enables this path in daily mode:

`<ref_snippet file="/home/javier/dev/agaric/src/components/journal/DaySection.tsx" lines="160-168" />`

### How they collide

The race is forced by the React re-render that `setCreatedPages` triggers in the *middle* of `handleAddBlock`'s async sequence:

```text
t0   useJournalAutoCreate fires → handleAddBlock(today)
t0   handleAddBlock: await createPageInSpace(today)         ← yields
t1   createPageInSpace resolves → newPageId
t1   setCreatedPages / onPageCreated / useResolveStore.set  ← schedule renders
t1   handleAddBlock: await loadJournalTemplateForSpace(...) ← yields
t2   React flush → JournalPage re-renders → DaySection re-renders
t2   DaySection mounts <BlockTree parentId={newPageId} autoCreateFirstBlock={true} />
t2   BlockTree useEffect[parentId] → pageBlockStore.load() ← yields
t3   load() returns 0 blocks (handleAddBlock has not seeded any yet)
t3   blocks.length === 0 → BlockTree.autoCreateFirstBlock effect fires
t3   BlockTree: createBlock({ type:'content', parentId:newPageId })  ← BLOCK #1
t4   handleAddBlock template lookups resolve to nothing (no template configured)
t4   handleAddBlock: createBlock({ type:'content', parentId:newPageId })  ← BLOCK #2
t5   handleAddBlock: pageBlockRegistry.get(newPageId)?.getState().load()
t5   load() returns BOTH blocks → store re-renders with two children
```

Both `createBlock` IPCs commit; both ops are appended; both rows materialize. The user sees two empty blocks under the day heading.

### How the focus problem follows from the same race

Both paths also end with `useBlockStore.setState({ focusedBlockId: ... })` — but to **different** ids and at **different** times. Whichever resolves last wins. In the timeline above, Path B's `.then()` (line 333) fires first with `focusedBlockId = block-#1.id`; Path A's continuation runs later and overwrites with `focusedBlockId = block-#2.id`. The `useRovingEditor` hook then has to mount the TipTap editor on block #2, but block #2 only just appeared in the store — the editor instance may not be fully attached on the first paint, leaving the user with a visible cursorless caret position. The "should be immediately active" complaint is the visible side-effect of (a) focusing the wrong block and (b) focusing it before its node-view is mounted.

If the user happens to win the other ordering (Path A's `createBlock` lands before BlockTree's `load()` returns), `BlockTree` sees `blocks.length === 1` and skips its own auto-create — yielding the correct one-block-with-focus result. The bug is genuinely racy, which is consistent with the user-reported "sometimes one, often two" pattern.

## Why the existing tests don't catch it

The auto-creation suite in <ref_file file="/home/javier/dev/agaric/src/components/**tests**/JournalPage.test.tsx" /> (`describe('auto-creation of first block', ...)` ~line 2755) only asserts that **`create_page_in_space` was called once**. There is no assertion on the number of `create_block` IPC calls or the number of blocks rendered. `BlockTree` itself is mocked away (line 27-28), so the second auto-creator never runs in those tests at all. The unit tests for `useJournalAutoCreate` and `useJournalBlockCreation` mock both sides of the boundary and therefore can't observe the cross-component race either.

## Proposed fix — single owner of "first block on a fresh daily page"

Two paths solve the duplication; pick one. The repo invariant from `AGENTS.md` ("[Code style] Default to writing compact code … share abstractions") favours collapsing to a single path rather than adding a coordination flag.

### Option 1 — Make `BlockTree` the single owner (recommended)

Drop the `else { createBlock(...) }` fallback in `useJournalBlockCreation.handleAddBlock` (the no-template path, lines 139-147). Let `handleAddBlock`'s job in the no-template case end at "create the page". Then `BlockTree` sees `blocks.length === 0`, fires its existing `autoCreateFirstBlock` effect, creates exactly one block, and sets focus.

For the **template** branches (lines 117-138) the same race still exists in theory — the `await insertTemplateBlocks…` resolves *after* the React flush from `setCreatedPages`. If `BlockTree` mounts and its `load()` returns 0 blocks before the template insertion lands, `BlockTree` will create a stray empty block ahead of the template seed. Two ways to close that:

- **1a.** Move the `setCreatedPages(...) / onPageCreated(...) / useResolveStore.set(...)` block from line 91-93 to **after** the template insertion (or after the no-template page-creation, in option 1's variant). The page won't appear in the JournalPage render tree until its seed blocks are already in the database. Cost: page indicator UI is delayed by one extra round-trip; this is on the order of tens of ms in practice and is the price of removing the race entirely.
- **1b.** Keep the early `setCreatedPages` (so the day section appears immediately), but disable `BlockTree.autoCreateFirstBlock` only when the JournalPage knows a `handleAddBlock` is in flight for this `pageId`. Implementation: track an in-flight set in `useJournalBlockCreation`, expose it via the hook's return, thread it down to `DaySection` → `BlockTree`. Adds a coordination prop to `BlockTree` and a small piece of shared state.

**1a is simpler and removes the timing dependency entirely.** 1b preserves the perceived-latency win at the cost of one extra prop on a widely-used component.

### Option 2 — Make `handleAddBlock` the single owner

Pass `autoCreateFirstBlock={false}` from `DaySection` unconditionally (or in daily mode), keeping `handleAddBlock`'s explicit `createBlock` for the no-template case. `BlockTree`'s auto-create stays for the `PageEditor` case (non-journal page editor still relies on it — see <ref_snippet file="/home/javier/dev/agaric/src/components/PageEditor.tsx" lines="158-158" />).

**Risk for Option 2:** if a daily page already exists in `pageMap` with zero child blocks (e.g. user manually deleted everything, or a sync delivered an empty page), `useJournalAutoCreate`'s guard (`pageMap.has(dateStr)` short-circuits, line 30 of `useJournalAutoCreate.ts`) means `handleAddBlock` will not run, AND `BlockTree.autoCreateFirstBlock` is now disabled — so the user sees an empty `BlockTree` with no blocks and no obvious affordance. The "Add block" button in `DaySection`'s `EmptyState` only shows when `entry.pageId == null`, not when the page exists but has no children. We'd need to extend the empty-state UI to cover "page exists, has no blocks".

**Option 1 (variant 1a) is cleaner.** It keeps `BlockTree.autoCreateFirstBlock` as the single source of "every empty page gets one editable block", regardless of how the page got there. `handleAddBlock`'s job becomes "create the page; if a template applies, seed the template blocks; otherwise let the empty-page invariant fire downstream". Focus is owned by whichever path actually creates blocks, no longer set in two places for the same situation.

## Regression test

Add to `src/components/__tests__/JournalPage.test.tsx` inside the existing `describe('auto-creation of first block', ...)` block:

```ts
it('creates exactly one content block when auto-creating a fresh daily page', async () => {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'create_page_in_space') return 'DP_NEW'
    if (cmd === 'create_block') {
      return makeBlock({ id: `BLK_${cryptoRandomId()}`, blockType: 'content', parentId: 'DP_NEW' })
    }
    if (cmd === 'list_blocks_paginated' || cmd === 'query_by_property') return emptyPage
    if (cmd === 'get_properties') return []
    return emptyPage
  })

  renderJournal()

  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', expect.any(Object)))

  // Flush all pending microtasks — both auto-creators must have settled.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

  const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
  expect(createBlockCalls).toHaveLength(1) // ← currently fails: receives 2
})
```

The current test suite mocks `BlockTree` away (<ref_snippet file="/home/javier/dev/agaric/src/components/**tests**/JournalPage.test.tsx" lines="26-30" />), which is exactly why the race is invisible to it. The regression test must **render the real `BlockTree`** for the day's page so both auto-creators can execute. Two options:

- Keep the global `BlockTree` mock for everything except this specific test; use `vi.unmock('../BlockTree')` + `vi.resetModules()` + a re-import inside the `it()`. Awkward but localised.
- Move this test into `src/components/__tests__/JournalPage.integration.test.tsx` (new file) which doesn't carry the mock. Cleaner and signals intent (an integration-level regression vs. the unit-level layout tests).

Either way, also add a focus-on-correct-block assertion:

```ts
expect(useBlockStore.getState().focusedBlockId).toBe(createBlockCalls[0]?.[1]?.parentId
  ? /* the id returned by the (single) create_block call */
  : null)
```

The exact assertion shape depends on which fix is taken (Option 1 → focus is whatever `BlockTree.autoCreate` set; Option 2 → focus is whatever `handleAddBlock` set), but the count assertion (`toHaveLength(1)`) is fix-agnostic and is the headline regression guard.

## Cost

**S (2-4 hours)** for the recommended fix:

| Step | Time |
| --- | --- |
| Move `setCreatedPages / onPageCreated / useResolveStore.set` to after the template/no-template branch resolves in `handleAddBlock` | 30 min |
| Drop the `else { createBlock(...) }` fallback (Option 1) | 15 min |
| Update the existing `useJournalBlockCreation` unit tests for the new ordering (template-vs-fallback paths still need their assertions) | 45 min |
| Add the integration-level "exactly one `create_block`" regression test (with real `BlockTree`) | 1 h |
| Run `npm run test`, `cargo nextest run`, e2e spot-check on `e2e/journal*.spec.ts` | 30 min |
| Buffer for fallout (e.g. day section spinner appears for a beat longer; tweak `loading` UX) | 30-60 min |

If Option 1b (in-flight coordination prop) is preferred over 1a, add ~1 hour for the prop plumbing through `JournalPage → DaySection → BlockTree` and the corresponding test updates.

## Impact

- **User-visible severity: medium.** Every brand-new daily page is currently a small papercut: an extra empty block to delete, plus the "click here before you can type" friction. For a daily-driver journal this is felt every day until the user accumulates pre-existing pages.
- **Correctness severity: medium.** Two redundant `CreateBlock` ops are appended to the op log, materialized, indexed in FTS, dispatched to materializer cache rebuilds, and (when sync is on) synced to peers. It's not corruption, but it's pure waste in the steady state and pollutes the op log forever.
- **Cleanup cost: zero.** The fix is local to two files (`useJournalBlockCreation.ts`, `DaySection.tsx` or `BlockTree.tsx` depending on option). No schema, no new op type, no store changes — fully within the architectural-stability boundary in `AGENTS.md`.

## Risk

- **Low for the fix.** Option 1 removes a duplicate code path; the remaining path (`BlockTree.autoCreateFirstBlock`) is already exercised by `BlockTree.test.tsx` for the non-journal `PageEditor` case, so we know it's solid.
- **Low for users in flight.** Op log entries from past double-creates are not corrupt — they're just pairs of empty blocks. Existing daily pages with two empty blocks won't be auto-cleaned by this fix; that's a separate one-shot cleanup if desired (likely not worth it).
- **Watch for:** the `useJournalAutoCreate.autoCreatedRef` guard interacts with date navigation (next/prev day). The fix must not regress the existing test `re-triggers auto-creation when navigating to a new date` (JournalPage.test.tsx:2899).

## Open questions

1. **Should `useJournalBlockCreation` also apply Option 1's reordering to the existing-page "Add block" branch (lines 149-157)?** That branch runs when the user clicks "Add block" on a *pre-existing* daily page; it does not race against `BlockTree.autoCreateFirstBlock` because the page already has at least one block (otherwise auto-create-first would have fired earlier). Likely no change needed there — but worth eyeballing while in the file.
2. **Does the fix need a corresponding e2e test?** `e2e/journal*.spec.ts` exists; one new spec that opens a fresh daily page and asserts `await expect(page.locator('[data-block-id]')).toHaveCount(1)` would cover the integration path end-to-end. Recommend adding it; cost is ~30 min and it matches the repo's existing journal spec style.
3. **Should `BlockTree.autoCreateFirstBlock` log a warning when it fires for a page that was just created via `createPageInSpace`?** That's a defensive belt-and-braces against the same class of bug recurring elsewhere — but it's noise in the steady state. Recommend **no** — the regression test is the right guard.
