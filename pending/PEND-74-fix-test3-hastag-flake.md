# PEND-74 — Fix TEST-3 HasTag popover flake under parallel load

Status: open
Owner: unassigned
First seen: pre-existing on `main` (not introduced by `pend-69-70-71-search-backend`)
Last hit: 2026-05-20 pre-push verification on the search-backend branch

## Symptom

`src/components/__tests__/BacklinkFilterBuilder.test.tsx:1283` — the
test `creates HasTag filter when tag is selected and Apply clicked`
intermittently sees `onFiltersChange` called with the **default** tag
(`tag_id: '01TAG_PROJ'`) instead of the clicked one (`'01TAG_REVW'`).
Passes solo, fails ~1 in N under the full parallel vitest run.

## Why the existing comment-block mitigation is insufficient

`HasTagFilterForm.handleSelect` does

```ts
setTagValue(tagId)
setTagSearchOpen(false)
```

The test waits for the popover to close (`waitFor(option == null)`) as
proof `handleSelect` ran, on the assumption that React 18 batches both
setStates. But the popover can also close via Radix's own
outside-click / focus-leave path (`onOpenChange={setTagSearchOpen}`),
which closes the popover **without** invoking `handleSelect`. So the
popover-closed check is not a sufficient witness for the tag update.

The likely race: the debounced `listTagsByPrefix` (150 ms) fires
mid-click under parallel load, `tagSearchResults` repopulates,
`items` flips from `tags` to `tagSearchResults`, the CommandItem
array re-renders, and the click misses the target option (or hits a
remounted node whose `onSelect` does not fire). Radix later closes
the popover via outside-click, satisfying the `waitFor` without
`setTagValue` having ever run.

## Fix options (pick one)

1. **Wait for the actual side-effect, not a proxy.** Replace the
   popover-unmount `waitFor` with one that checks the trigger label
   has flipped to "Review" (i.e. `tagValue` actually updated), or
   waits for `onFiltersChange` to have been called with the right
   tag after Apply.

2. **Stabilize `items` during selection.** Disable the debounced
   IPC while a click is in-flight, or hold the `items` array stable
   for one frame after a `CommandItem` click. Avoids the
   re-render-mid-click race entirely.

3. **Pre-seed `listTagsByPrefix` mock** in this specific test so the
   debounce returns the same `tagsData` (no array swap, no
   re-render). Cheapest, narrowest fix; keeps the production code
   alone.

Option 3 is the smallest change and most defensible. Option 1 is the
right test-contract fix. Option 2 is overkill unless production users
report a similar issue.

## How this got pushed past CI

`pend-69-70-71-search-backend` was pushed with `SKIP_CI_VERIFY=1`
because the flake is pre-existing on `main` and unrelated to the
search-backend work. GitHub CI on the resulting PR will re-run all
tests; if the flake hits there, the PR will need a rerun.
