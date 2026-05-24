# PEND-78 — Recent-pages strip shows pages from a different space

The desktop "Recently visited" strip (`RecentPagesStrip`) can render pages that
belong to a *different* space than the active one. Worse than a display glitch:
the wrong-space entries get **persisted into the active space's slice**, so they
survive reloads until manually evicted.

## Symptom

After certain boot / space-rehydrate sequences, switching into space-A and
opening a page shows space-B's recent pages in the strip — and they stick.

## Root cause

The store keeps per-space MRU lists in `recentPagesBySpace` plus a flat
`recentPages` field that is *supposed* to mirror the active space's slice
(`src/stores/recent-pages.ts:37-50`). The whole design rests on one invariant:

> **flat `recentPages` == `recentPagesBySpace[currentSpaceId]` at all times.**

Two things break that invariant on the rehydrate path and then propagate it:

### Defect 1 — `recordVisit` reads the flat field (`recent-pages.ts:89-102`)

```ts
recordVisit: (ref) => {
  const state = get()
  const key = activeSpaceKey()
  const current = state.recentPages           // <-- flat field, NOT map[key]
  const next = [ref, ...current.filter(...)].slice(0, MAX_RETAINED)
  set({ recentPages: next, recentPagesBySpace: { ...map, [key]: next } })
}
```

It builds the new MRU list from the flat field and writes the result into
`recentPagesBySpace[key]` (the active space). If the flat field is stale (holds
another space's list), this **copies the foreign list into the current space's
slice and persists it** — turning a transient mismatch into durable corruption.
The inline comment justifies reading flat "so a partial `setState` in tests
still drives the next visit" — i.e. the defect exists to satisfy a test shortcut.

### Defect 2 — first-fire seed only reconciles `__legacy__` (`recent-pages.ts:152-178`)

The space subscriber (`createSpaceSubscriber`, `fireImmediately: true`) fires once
at subscribe time with `prevKey === newKey`. That branch only swaps/seeds when
`newKey === LEGACY_SPACE_KEY`:

```ts
if (prevKey === newKey) {
  if (newKey === LEGACY_SPACE_KEY && map[newKey] === undefined && flat.length > 0) {
    // seed legacy slot from flat
  }
  return   // <-- real space: does NOTHING, flat left as-is
}
```

On reload the flat field is rehydrated to whatever space was active when
persistence last ran. If `currentSpaceId` rehydrates to a *real* space (not
legacy) — or the space store's `refreshSpaces()` reconciles to a different space
than persisted (`src/stores/space.ts:126-135`) — the first fire leaves the flat
field holding the *previous* space's list while the active space is different.
The invariant is now broken, and Defect 1 bakes it into the active slice on the
next visit.

### Why the existing test doesn't catch it

`src/stores/__tests__/recent-pages.test.ts:241` ("switching from `__legacy__`
to a fresh real space does NOT seed the real space slot from the flat mirror")
only covers the **live** switch — a `useSpaceStore.setState` transition that runs
the subscriber's *diff*-branch (`prevKey !== newKey`), which correctly pulls
`flat = map[newKey] ?? []`. It never exercises a fresh **rehydrate** where the
flat field is preloaded with space-B's list and `currentSpaceId` is already a
real space at first-fire. That rehydrate/first-fire path is the gap.

## Affected reads

- `RecentPagesStrip` reads `selectRecentPagesForSpace(s, currentSpaceId)`
  (`RecentPagesStrip.tsx:67-68`). For a real `currentSpaceId` it returns the
  per-space slice — correct *once Defect 1 has corrupted that slice*.
- `selectRecentPagesForSpace(state, null)` returns the flat field
  (`recent-pages.ts:79-82`). During the pre-bootstrap window (`currentSpaceId ==
  null`) the strip shows the flat mirror = last-active space's list — a transient
  flash on top of the durable corruption.

## Proposed fix

1. **Make the per-space slice the single source of truth in `recordVisit`.**
   Derive `current` from `state.recentPagesBySpace[key] ?? []`, not the flat
   field, then write both `recentPagesBySpace[key]` and the flat mirror. This
   removes the write-time corruption path entirely — a stale flat field can no
   longer leak into a space's slice.

2. **Reconcile the flat mirror on first-fire for real spaces too**
   (`createSpaceSubscriber` callback). On `prevKey === newKey`, pull
   `recentPages = recentPagesBySpace[newKey] ?? []` for any key, keeping the
   existing legacy-seed as the one special case. `recentPagesBySpace` is
   persisted (`partialize`, `recent-pages.ts:115-118`), so in the normal cycle
   `map[newKey]` holds the right slice and the pull is lossless; the v0→v1
   migration path is handled separately in `migrate()`.

3. **(Optional hardening)** Have the null-space selector fall back to
   `recentPagesBySpace[LEGACY_SPACE_KEY] ?? []` instead of the flat field, so the
   pre-bootstrap window can't flash a foreign space either. Lower priority —
   #1+#2 already close the durable bug.

## Regression tests to add

- **Rehydrate into a real space with a foreign flat mirror.** Seed localStorage
  with `recentPages = [space-B pages]` and `recentPagesBySpace = { 'space-B':
  [...] }`, set `currentSpaceId = 'space-A'`, `await persist.rehydrate()`, then
  `recordVisit` a space-A page → assert `recentPagesBySpace['space-A']` contains
  ONLY the new page (no space-B bleed) and the strip selector returns no space-B
  entries.
- **First-fire reconciliation.** After rehydrate with `currentSpaceId` a real
  space, assert `recentPages` equals `recentPagesBySpace[currentSpaceId] ?? []`,
  not the persisted foreign flat list.
- Keep the existing live-switch test green (it exercises the diff-branch).

Note: fixing Defect 1 will break any test that drives `recordVisit` via a partial
`setState` of only `recentPages`; update those to seed the per-space slice.

## Sibling to audit

`src/lib/recent-pages.ts` is a *separate* localStorage-backed recent-pages system
(pinning, PEND-67) consumed by the command palette / search, with its own
`__legacy__` slot and migration. It is not what the strip reads, but it shares
the per-space-slot shape — audit it for the same flat-vs-slice class of bug while
here.

## Recommended action order

1. Add the failing rehydrate regression test (red).
2. Fix Defect 1 (`recordVisit` reads the per-space slice) — likely turns the test
   green on its own.
3. Fix Defect 2 (first-fire reconciliation) as defense-in-depth + its test.
4. Update partial-`setState` tests broken by #2.
5. Audit `src/lib/recent-pages.ts` for the same defect; fix if present.
6. (Optional) Harden the null-space selector fallback.

## Cost / Impact / Risk

- **Cost:** S (~2-4 h). Two small store changes + tests; no schema, no backend,
  no IPC.
- **Impact:** Fixes a visible, persistent data-correctness bug in the space
  boundary — and stops the strip from durably corrupting a space's MRU list.
- **Risk:** Low. FE-only, store-local. Main care point is updating the
  partial-`setState` tests so the suite reflects the new single-source-of-truth
  contract.
