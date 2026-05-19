# PEND-72 — Segment-switch seed → palette IPC sync

> Surfaced by the 2026-05-19 round-3 review on PEND-62. The mobile search sheet's bridge mirrors the active segment's query into `useSearchSheetStore.query`, then seeds the new segment's store on switch. The PaletteBody side has a partial fix (a `useState` initializer that reads `useCommandPaletteStore.query` on mount), but that only covers the case where PaletteBody mounts AFTER the bridge has set the seed. Segment-switch races the bridge's `setQuery` against PaletteBody's mount: PaletteBody's `useState` init reads `palette.query = ''` (the bridge hasn't run yet), then the bridge sets `palette.query = 'beta'` AFTER mount, but `debouncedQuery` stays empty so the IPC never fires.

## TL;DR

- Visible behavior today: user types "beta" in the in-page-find segment, switches to "all-pages", sees the palette input pre-filled with "beta", but **no results appear** until they press another character (which triggers the normal debounce → IPC flow).
- The fix needs a user-initiated vs externally-set distinction in `PaletteBody` so external query changes sync `debouncedQuery` immediately without defeating the 80 ms debounce for user typing.

## Current state — verified

- `src/components/CommandPalette.tsx:367-373` — `useState(() => useCommandPaletteStore.getState().query.trim())` initialises `debouncedQuery` from the store. Covers the *mount-after-seed* case (desktop Cmd+K with pre-existing store query), NOT the *mount-then-seed* case (segment switch).
- `src/components/SearchSheet.tsx:61` + `src/hooks/useSearchSheetBridge.ts:69-95` — bridge seeds the new segment's store AFTER `paletteBridge.open()`, which itself fires AFTER React has rendered PaletteBody.
- Trace order at segment switch:
  1. User clicks 'all-pages' → `setMode('all-pages')` → re-render.
  2. SearchSheet renders; body branches to PaletteBody (mount).
  3. PaletteBody's `useState` init reads `palette.query` — still `''` because the bridge hasn't run yet.
  4. React commits; effects run; the bridge's `[open, mode]` effect fires: `open$()` + `setQuery(seed)`.
  5. PaletteBody subscribes to `palette.query`, sees it change to `'beta'`, re-renders.
  6. **But** `debouncedQuery` state is still `''` (no `useEffect` syncs it).
  7. The IPC-driving effect at `CommandPalette.tsx:412-465` keys on `debouncedQuery`, not `query` — so it never fires for the seeded value.

## Design

Add a user-initiated tracker ref in `PaletteBody`:

```ts
// Track the most recent query value we set via the input. External
// changes (e.g., the search sheet bridge seeding the store on
// segment switch) bypass the debounce because the user didn't type —
// the IPC should fire immediately.
const lastUserQueryRef = useRef(query)

function handleInputChange(value: string) {
  lastUserQueryRef.current = value
  setQueryStore(value)
  // ... existing debounce schedule unchanged
}

useEffect(() => {
  if (query === lastUserQueryRef.current) return
  lastUserQueryRef.current = query
  const trimmed = query.trim()
  setDebouncedQuery(
    trimmed.length === 0 || isCommandsModeInput(trimmed) ? '' : trimmed,
  )
}, [query])
```

This effect runs after every render where `query` changes. When the user types via the input, `lastUserQueryRef` is updated synchronously inside `handleInputChange`, so the effect's equality check short-circuits — the normal debounce path applies. When the bridge externally writes `palette.query`, `lastUserQueryRef` is stale → the effect syncs `debouncedQuery` immediately, the IPC effect fires next tick.

## Tests

- New: `palette body fires IPC immediately for externally-seeded query` — set `useCommandPaletteStore.query = 'alpha'` via `setState`, mount PaletteBody, assert `searchBlocksPartitioned` is called within one tick.
- New: `palette body respects the 80 ms debounce for user typing` — simulate `userEvent.type('alpha')`, assert the IPC fires once with the final value, not three times.
- Update existing in `SearchSheet.test.tsx` — re-enable the segment-switch seed test removed during PEND-62 round 3 cleanup. Reference the existing test stub at the relevant comment.

## Acceptance criteria

- Segment-switch with non-empty bridge query fires the partitioned IPC immediately (no extra keystroke needed).
- User typing still debounces at 80 ms.
- Existing 65 CommandPalette tests still pass without modification.
- `cargo nextest` and `prek run --all-files` green.

## Open questions

1. **Does the user-vs-external distinction belong inside PaletteBody, or should the bridge route through `handleInputChange`?** Recommendation: keep inside PaletteBody. Routing through `handleInputChange` requires PaletteBody to expose it, which leaks an internal concern. The ref pattern is cheap and contained.
2. **Should the bridge wait for PaletteBody to mount before seeding?** No — that's a layering inversion. The seed-then-sync pattern is the React way.

## Out of scope

- Other surfaces that consume `useCommandPaletteStore.query`. As of PEND-62, only `PaletteBody` reads `debouncedQuery`; other consumers read `query` directly.

## Cost / impact

- **Cost:** XS (~1-2 h). ~10 LOC in PaletteBody + 2 new tests + un-skip the existing SearchSheet test.
- **Impact:** Closes a visible UX gap on the mobile sheet's segment-switch flow. Zero impact on existing surfaces.
- **Risk:** Low. The ref pattern is well-trodden React idiom; the effect's equality short-circuit guarantees no double-fires for user typing.

## Related

- PEND-62 (shipped) — introduced the seed-on-switch behavior; this PEND completes the IPC-fire path.
- `src/components/CommandPalette.tsx:367-373` — partial fix landed here.
- `src/components/SearchSheet.tsx:61` + `src/hooks/useSearchSheetBridge.ts:69-95` — the bridge's setQuery call site.
- `src/components/__tests__/SearchSheet.test.tsx` — comment near the removed test marks the entry point for the regression suite.
