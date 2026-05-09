# PEND-30 — Frontend maintainability review: confirmed non-nit findings

> **Status (session 695):** ALL DECOMPOSITION ITEMS SHIPPED. M-1 / M-2 / L-1 / L-2 / L-4 / L-5 closed in session 660. **D-3** shipped session 694 (SearchPanel.tsx 672 → 590 LOC + reducer/popover-factory/alias hooks; +36 tests). **D-1 / D-2 / D-4** shipped session 695 in parallel: D-1 SortableBlock 32 → 14 props (context-first + `TestBlockActionsOverride` test wrapper), D-2 SpaceManageDialog 795 → 389 LOC outer + 5 sub-components in `SpaceManageDialog/` (journalTemplateInitializedRef flag eliminated; localStorage onboarding key promoted to stable token), D-4 useBlockSlashCommands 575 → 184 LOC + 4 category sub-hooks + biome-ignore exemption gone. **Only L-3 remains deferred** per third-party `react-day-picker .rdp` class blocker.

## Origin

Two-round JS/TS **maintainability** review run 2026-05-04 over the production
TypeScript/TSX under `src/` (~75 600 LOC across 442 files; tests, fixtures,
mocks excluded). **Round 1**: six parallel discovery subagents covering
disjoint slices —

1. `src/stores/` (Zustand stores)
2. `src/hooks/` part 1 (block / page / journal / property / batch hooks)
3. `src/hooks/` part 2 (sync / app / list / nav / graph / query hooks)
4. `src/components/ui/` + general top-level components
5. `src/components/` page-level views (PageBrowser, SearchPanel,
   HistoryView, GraphView, SortableBlock, SpaceManageDialog, …)
6. `src/lib/` + `src/editor/` + `src/workers/` + `App.tsx` / `main.tsx`

**Round 2**: three parallel validation subagents that re-read every cited
`file:line` against the actual source, looking for hallucinations,
exaggerations, missing context, mitigations the original reviewer missed,
React-19-specific carve-outs, and threat-model carve-outs (single-user,
local-first, no malicious peers, Tauri desktop with no SSR).

The two-round split caught a substantial number of factual errors in the
original review (see "Hallucinations rejected by Round 2 validation" at the
bottom). After validation, **5 hand-verified items survive as real
maintainability work**, plus **4 large-component / large-hook decomposition
opportunities** worth tracking even though they are not bugs.

> **Distinct from PEND-22 / PEND-29** (frontend *robustness* reviews): this
> session was scoped to **maintainability** — code shape, coupling,
> duplication, file size, prop count, decomposition opportunity. There is
> zero finding-level overlap with PEND-22 or PEND-29; both prior sessions'
> committed fixes were observed at HEAD and were not flagged again.

## TL;DR

| ID | Severity | Title | Cost | Risk | Impact | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **M-1** | MEDIUM | `useBlockPropertiesBatch` has no staleness guard — rapid block-list changes can let an old `getBatchProperties` `.then` overwrite a newer fetch | trivial (~10 min) | low | medium | ready |
| **M-2** | MEDIUM | `tree-utils.buildFlatTree` has cycle detection but no depth limit — pathologically deep linear chains blow the stack (the markdown parser has the same defense, this one is missing) | trivial (~5 min) | low | medium | ready |
| **L-1** | LOW | `activeSpaceKey()` 3-line helper duplicated identically in four stores (`navigation.ts`, `journal.ts`, `tabs.ts`, `recent-pages.ts`) | trivial (~5 min) | low | low | ready |
| **L-2** | LOW | `useBacklinkResolution` per-component cache keyed on id only, not `(spaceId, id)` — within the 5-minute TTL window a backlink panel can show a title from another space after a space switch | trivial (~10 min) | low | low | ready |
| **L-3** | LOW | `useEditorBlur.EDITOR_PORTAL_SELECTORS` is a hardcoded list of 8 CSS selectors — every new editor overlay must remember to add itself, no automatic enrolment | S (~30 min) | low | low | ready |
| **L-4** | LOW | `cleanupOrphanedPopups` is exported and called *reactively* (on new-popup mount), but never from the roving editor's teardown path — a 5th defensive layer for the B-77 stack | trivial (~10 min) | low | low | ready |
| **L-5** | LOW | `PageBrowser`'s `useVirtualizer.estimateSize` is an inline arrow function recreated every render — wrap in `useCallback` | trivial (~5 min) | low | low | ready |
| ~~**D-1**~~ ✅ | DECOMP | ~~`SortableBlock` declares 32 props~~ — **shipped session 695** (32 → 14 props; context-first; `TestBlockActionsOverride` wrapper for tests; `mergeActions`/`mergeResolvers` deleted) | ~~M (3-5 h)~~ | low | medium | ✅ shipped |
| ~~**D-2**~~ ✅ | DECOMP | ~~`SpaceManageDialog.tsx` is 795 lines~~ — **shipped session 695** (834 → 389 LOC outer + 5 sub-components in `SpaceManageDialog/`; `journalTemplateInitializedRef` eliminated; localStorage key promoted to stable token; +42 tests) | ~~M-L (4-7 h)~~ | low | medium | ✅ shipped |
| ~~**D-3**~~ ✅ | DECOMP | ~~`SearchPanel.tsx` is 672 lines with 22 `useState` calls and 7 `useEffect` blocks~~ — **shipped session 694** (672 → 590 LOC; reducer + popover factory + alias hook; +36 tests) | ~~M-L (4-7 h)~~ | low | medium | ✅ shipped |
| ~~**D-4**~~ ✅ | DECOMP | ~~`useBlockSlashCommands.ts` is 575 lines~~ — **shipped session 695** (575 → 184 LOC + 4 category sub-hooks; `biome-ignore useExhaustiveDependencies` exemption eliminated; +62 tests) | ~~M (3-5 h)~~ | low | medium | ✅ shipped |

(M-1 / M-2 = real maintainability bugs worth fixing now. L-1 .. L-5 = real
but small enough to bundle as one cleanup commit. D-1 .. D-4 = decomposition
opportunities, **not bugs**, listed so they are tracked rather than
re-discovered every review.)

**Total cost ≈ 1 h** for M-1, M-2, L-1 .. L-5 as a single bundle.
**Decomposition (D-1 .. D-4) ≈ 14-24 h** if all four are taken; each is
independently scoped and can be picked off in isolation.

None of these require schema migrations, new op types, new stores, or any
architectural change.

---

## MEDIUM

### M-1 — `useBlockPropertiesBatch` has no staleness guard

**File:** <ref_snippet file="/home/javier/dev/agaric/src/hooks/useBlockPropertiesBatch.ts" lines="29-53" />

The effect fires on every change of the `blocks` prop. There is no
`let cancelled = false` flag, no `AbortController`, no last-write-wins
counter — so on rapid `blocks` mutations (virtualizer scroll, fast filter
changes, multi-select churn) an older `getBatchProperties(visibleIds).then`
can resolve *after* a newer one and overwrite the newer result, briefly
showing properties from a previous block set.

This is the same race shape that `useBlockLinkResolve.ts:91` already
defends against with the standard `let cancelled = false` pattern. Apply
the same idiom here.

**Fix:**

```ts
useEffect(() => {
  if (blocks.length === 0) return
  let cancelled = false
  const visibleIds = blocks.map((b) => b.id)
  getBatchProperties(visibleIds)
    .then((result) => {
      if (cancelled) return
      // ... existing mapping ...
      setBlockProperties(mapped)
    })
    .catch((err: unknown) => {
      if (cancelled) return
      logger.warn('BlockTree', 'Failed to load batch properties for blocks', undefined, err)
    })
  return () => {
    cancelled = true
  }
}, [blocks])
```

**Test:** unit test that fires two `getBatchProperties` calls back-to-back
with the older one resolving last; assert the result reflects the *newer*
visible-id set.

---

### M-2 — `tree-utils.buildFlatTree` has cycle detection but no depth limit

**File:** <ref_snippet file="/home/javier/dev/agaric/src/lib/tree-utils.ts" lines="62-73" />

The `dfs` function uses a `visited` set (correctly) to break cycles, so
infinite loops on corrupted data are impossible. What's *not* defended
against is a pathologically deep linear chain — `dfs` recurses via
`dfs(child.id, depth + 1)` and a depth-10 000 chain would blow the JS
stack.

Probability of hitting this with real user data is low (typical block
trees are <20 levels deep), but the markdown parser already ships the
exact same defense for the exact same reason — see
<ref_snippet file="/home/javier/dev/agaric/src/editor/markdown-parse.ts" lines="45-45" />
where `MAX_PARSE_DEPTH = 10`. Add a matching constant here.

**Fix:**

```ts
const MAX_TREE_DEPTH = 1000

function dfs(parentId: string | null, depth: number): void {
  if (depth > MAX_TREE_DEPTH) {
    logger.warn('tree-utils', 'tree depth limit exceeded', { depth, maxDepth: MAX_TREE_DEPTH })
    return
  }
  const children = childrenMap.get(parentId)
  // ... rest unchanged
}
```

**Test:** synthetic linear chain of 2000 blocks — assert
`buildFlatTree` returns the first 1000 (or whatever the bound is) and
emits one warning, instead of throwing `RangeError: Maximum call stack
size exceeded`.

---

## LOW — bundle as a single commit

The remaining items are individually tiny and share a theme (duplication
removal, cache-key correctness, hook hygiene). Group them into one commit
**`refactor: frontend maintainability misc — dedup helper + cache-key
correctness + cleanup hygiene (PEND-30 LOW bundle)`**.

### L-1 — `activeSpaceKey()` duplicated identically in four stores

Same exact 3-line function:

```ts
function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}
```

…appears at:

* <ref_snippet file="/home/javier/dev/agaric/src/stores/navigation.ts" lines="97-99" />
* <ref_snippet file="/home/javier/dev/agaric/src/stores/journal.ts" lines="63-65" />
* <ref_snippet file="/home/javier/dev/agaric/src/stores/tabs.ts" lines="117-119" />
* <ref_snippet file="/home/javier/dev/agaric/src/stores/recent-pages.ts" lines="72-74" />

Extract to `src/lib/active-space.ts` (or `src/stores/_shared.ts`) and
import everywhere. If the space-store API ever changes, the rename is
one place instead of four.

---

### L-2 — `useBacklinkResolution` cache is per-component but not space-aware

**File:** <ref_snippet file="/home/javier/dev/agaric/src/hooks/useBacklinkResolution.ts" lines="120-150" />

```ts
const resolveCache = useRef<ResolveCache>(new Map())
```

Cache entries are keyed only by `id` (line 70: `cache.set(r.id, …)`).
A 5-minute TTL bounds the leak, but during the window the same hook
instance can serve a title from a previous space if the user
space-switches and a backlink panel re-runs against the same id (an
unlikely but possible cross-space ULID collision, or — more realistically
— a backlink that *exists in both spaces* with different titles, which
will become possible the moment cross-space refs are forbidden under
PEND-15).

**Fix (one-liner):** include `currentSpaceId` in the cache key, or add
an effect that calls `cache.current.clear()` when `currentSpaceId`
changes. The `useResolveStore` keying convention is
`${spaceId}::${ulid}` — match that.

---

### L-3 — `useEditorBlur` portal selectors are a hardcoded manual list

**File:** <ref_snippet file="/home/javier/dev/agaric/src/hooks/useEditorBlur.ts" lines="35-44" />

`EDITOR_PORTAL_SELECTORS` is an 8-entry CSS-selector array that the
hook scans against `relatedTarget` to decide whether a blur should
collapse the editor. The comment explicitly warns "keep selectors here
in sync when adding new editor-side overlays" — but there is no
automated check, just discipline.

The two failure modes are symmetric:

* Add a new overlay, forget the selector → the editor collapses
  prematurely when the user clicks into the new picker, losing the
  draft.
* Rename a CSS class on an existing overlay → same failure, but
  silent until a user reports it.

**Fix:** convert to a `[data-editor-overlay]` attribute pattern. New
overlays opt in via markup (`<div data-editor-overlay>…`) instead of by
editing this list. Migrate the 8 existing portals to attach the
attribute and replace the selector loop with a single
`relatedTarget.closest('[data-editor-overlay]')` test.

---

### L-4 — `cleanupOrphanedPopups` not called from roving-editor teardown

**File:** <ref_snippet file="/home/javier/dev/agaric/src/editor/suggestion-renderer.ts" lines="100-115" />

`cleanupOrphanedPopups()` exists, is exported, and is called from
`use-roving-editor.ts:421` (mount) and the suggestion plugin's
`onExit`. It is **not** called when the roving editor is destroyed
(unmount path of the host component). If any path tears down the
editor instance without going through `onExit` — for example, an
exception during render that swaps the tree — popups leak as orphan
DOM. This was the explicit motivation for the B-77 multi-layer cleanup
strategy; this is the missing 5th layer.

**Fix:** add a single call inside the host component's `useEffect`
cleanup function alongside `editor?.destroy()`. ~3 LOC.

---

### L-5 — `PageBrowser` virtualizer's `estimateSize` is recreated every render

**File:** <ref_snippet file="/home/javier/dev/agaric/src/components/PageBrowser.tsx" lines="262-277" />

```ts
const virtualizer = useVirtualizer({
  count: virtualItemCount,
  getScrollElement: () => listRef.current,
  estimateSize: (index) => {
    const row = groupedRows[index]
    if (row?.kind === 'header') return HEADER_ROW_HEIGHT
    return PAGE_ROW_HEIGHT
  },
  overscan: 5,
})
```

`estimateSize` is an inline arrow recreated every render. TanStack
Virtual treats option-identity changes as a re-measure trigger, so this
nudges the virtualizer to do extra work on re-renders that don't
actually change `groupedRows`. Wrap in `useCallback([groupedRows])`.

> **Note on the original review's claim about `pageIndexToRowIndex`:**
> the validator confirmed `pageIndexToRowIndex` *is* already memoized
> via `usePageBrowserGrouping` — only `estimateSize` is the real
> problem. The original review conflated the two.

---

## DECOMPOSITION OPPORTUNITIES (not bugs)

These are tracked here so the next maintainability review doesn't
re-discover them. Each is independently scoped; there is no urgency.
Leave them alone unless the area is being touched anyway.

### ~~D-1 — `SortableBlock` has 32 props + `mergeActions` / `mergeResolvers` boilerplate~~ — shipped session 695

`SortableBlockProps` dropped from 32 → 14 fields. The 14 action callbacks + 4 resolvers were removed; `SortableBlock` now reads `BlockActionsContext` and `BlockResolversContext` directly. `mergeActions` and `mergeResolvers` deleted entirely (verified zero callers post-refactor). Tests that need to inject specific callbacks wrap `<SortableBlock>` in a new `<TestBlockActionsOverride actions={…} resolvers={…}>` component (45 such tests migrated). `SortableBlock.tsx`: 529 → 408 LOC (-121).

### ~~D-2 — `SpaceManageDialog.tsx` is 795 lines~~ — shipped session 695

Decomposed into a sibling `src/components/SpaceManageDialog/` folder with 5 focused sub-components:

* `SpaceNameEditor.tsx` (96 LOC) — inline name editing with blur / Enter commit.
* `SpaceAccentPicker.tsx` (117 LOC) — 6-swatch picker with debounced save.
* `SpaceJournalTemplateEditor.tsx` (161 LOC) — markdown textarea using `useState` lazy initializer; **the `journalTemplateInitializedRef` flag is GONE** (the gate moved to the parent `SpaceRowEditor`, which renders the editor only when `initialJournalTemplate !== undefined`).
* `SpaceDeleteButton.tsx` (168 LOC) — delete button + emptiness probe + confirmation dialog.
* `SpaceOnboardingHint.tsx` (128 LOC) — onboarding banner with `ONBOARDING_STORAGE_KEY = 'agaric:space-onboarding-seen-v1'` as a stable token (preserves the historical i18n-derived key value, so existing dismissals carry over).

The slimmed `SpaceManageDialog.tsx` is 389 LOC (was 834); `SpaceRowEditor.tsx` rump is 79 LOC. +42 new sub-component tests.

### ~~D-3 — `SearchPanel.tsx` is 672 lines, 22 `useState`, 7 `useEffect`~~ — shipped session 694

Final shape (`src/components/SearchPanel/`):

* `searchFilterReducer.ts` — `SearchFilterState` + `SearchFilterAction` discriminated union covers the 4 applied-filter slots (`filterPageId / filterPageTitle / filterTagIds / filterTagNames`). Popover-internal state is *not* in the reducer (review confirmed: separate state machine with natural temporal boundaries).
* `usePopoverEntity<T>({searchFn, logLabel, extraDeps})` — factory hook drives both page + tag popovers. Adds an in-flight cancellation flag the original lacked (review found this is exercised by a load-bearing test).
* `useAliasResolution(query, results, currentSpaceId)` — alias-match logic with synchronous empty-query guard (no 1-frame stale flash; review caught + fixed).

`SearchPanel.tsx`: 672 → 590 LOC (12%; the audit's 40% target was undercut by JSDoc preserved verbatim + the chip-bar/status JSX block which isn't a state-extraction target). +36 new tests across 3 files.

### ~~D-4 — `useBlockSlashCommands.ts` is 575 lines~~ — shipped session 695

Split into 4 sub-hooks under `src/hooks/useBlockSlashCommands/` by command category: `useSlashCommandTemplate.ts` (45 LOC), `useSlashCommandDate.ts` (27), `useSlashCommandProperty.ts` (262), `useSlashCommandStructural.ts` (88). Plus shared `types.ts` (57) + `helpers.ts` (70) + `types-public.ts` (35).

Top-level `useBlockSlashCommands.ts`: 575 → 184 LOC. The dispatcher's `useCallback` deps are `[focusedBlockId]` only (the rest flow through a single bundled `inputsRef` retained at the dispatcher boundary for MAINT-10 identity-stability). **The `biome-ignore lint/correctness/useExhaustiveDependencies` exemption is GONE** — each sub-hook returns a `useMemo`-stable dispatch table with empty deps. Heading h1-h6 encoded as 6 exact entries (not regex). +62 new tests.

---

## Out of scope

Items that surfaced in the review but are **not worth a commit on their
own** — listed for audit completeness so they are not re-litigated:

* **`useResolveStore.preload` flips `_preloaded: true` on failure.** The
  catch block at <ref_snippet file="/home/javier/dev/agaric/src/stores/resolve.ts" lines="206-209" />
  intentionally sets the flag on failure. The original reviewer claimed
  this "masks errors and prevents retries", but: (a) the explicit test
  `it('sets _preloaded on error', …)` at
  `src/stores/__tests__/resolve.test.ts:141` documents this is intended
  behavior, (b) the field's docstring at
  `resolve.ts:88` is `Whether preload has been called at least once`
  ("called", not "succeeded" — the name matches the semantics), and
  (c) the only production call site at
  `src/hooks/useAppSpaceLifecycle.ts:40` invokes `preload()`
  unconditionally on every `currentSpaceId` change, so the flag does
  not gate retry. No production caller reads `_preloaded` at all —
  it is consumed only by tests. Demoted to "naming nit, not worth a
  commit"; if anyone touches this file for unrelated reasons,
  consider renaming to `_preloadAttempted` for clarity.

* **`usePropertyKeysCache` Tauri listener never unregistered.** The
  module-level docstring at
  <ref_snippet file="/home/javier/dev/agaric/src/hooks/usePropertyKeysCache.ts" lines="20-22" />
  explicitly documents this is intentional: *"The Tauri listener
  registers itself lazily on the first hook mount and lives for the
  rest of the process — there is no per-mount teardown, which is the
  whole point of the cache."* Validator caught the original reviewer
  missing the docstring. Not a bug.

* **`useDraftAutosave` cleanup calls `flushDraft` unconditionally.**
  Cleanup at
  <ref_snippet file="/home/javier/dev/agaric/src/hooks/useDraftAutosave.ts" lines="39-53" />
  calls `flushDraft(blockIdRef.current)` on every unmount, guarded
  only by `blockIdRef.current` truthiness (not by "did we ever save").
  The reviewer flagged this as a potential source of orphan rows or
  IPC errors on rapid mount/unmount. In practice `flushDraft` is
  idempotent on the backend (no-op if no draft row exists), so the
  cost of the unconditional call is one extra IPC and zero observable
  symptoms. Not worth the guard logic.

* **Markdown parser depth-10 truncation is "silent".** The
  `MAX_PARSE_DEPTH = 10` defense at
  <ref_snippet file="/home/javier/dev/agaric/src/editor/markdown-parse.ts" lines="45-45" />
  was flagged as needing a user-facing toast. There is no evidence any
  real user file hits depth 10 (typical content is depth ≤4). Fine as
  a debug-log-only safety net.

* **Logger silent `.catch(() => {})` on IPC bridge.** Documented
  intentional at <ref_snippet file="/home/javier/dev/agaric/src/lib/logger.ts" lines="155-157" />
  to prevent recursion (logging the logger's own IPC failure would
  re-enter the same bridge). The original reviewer's suggestion to add
  a `console.warn` fallback is reasonable but optional.

* **`tabs.ts` reaches into `useNavigationStore.setState`** at
  <ref_snippet file="/home/javier/dev/agaric/src/stores/tabs.ts" lines="186-200" />.
  The cross-store coupling exists by design; the symmetry is documented
  inline. Not a bug, just an architectural choice. If the navigation
  store ever grows middleware that breaks the synchronous-`set`
  assumption, this becomes a real problem; until then, leave it alone.

* **`PageBlockStoreProvider` registry race.** The cleanup-effect at
  <ref_snippet file="/home/javier/dev/agaric/src/stores/page-blocks.ts" lines="540-586" />
  already includes the identity-based guard
  `if (pageBlockRegistry.get(pageId) === store) registry.delete(pageId)`.
  The original reviewer's criticism was about the *comment* being
  fragile (acknowledging React batching as the safety net), not about
  the code itself. Comment quality, not code quality.

* **`useUndoStore.redo` "stale closure".** `pageState` is captured
  from `get().pages` before the async redo loop. The original
  reviewer flagged this as stale because the loop calls `set()`. But
  Zustand's immutable-update model means the captured reference still
  represents *valid pre-loop state*, and the post-loop decision logic
  at lines 345-351 already re-reads via `set((state) => …)`. Not a
  bug; readable refactor (re-read after the loop for clarity) is
  optional.

* **`useBlockDatePicker` / `useBlockResolve` ref mutation race.** Both
  hooks mutate `pagesListRef.current` inside async handlers. There IS
  a pre-IPC space-validity check (`useBlockResolve.ts:393-402`,
  `useBlockDatePicker.ts:137`). The race window is much narrower than
  the original review suggested. Not bundled.

* **`useLocalStoragePreference` `serialize`/`source` deps relegated to
  a `biome-ignore`.** Real but stylistic; no observed bug. Demoted to
  comment-only nit.

### Hallucinations rejected by Round 2 validation

Listed for audit completeness; do not re-litigate:

* **Missing `forwardRef` on `Input`/`Label`/`Badge`/`Spinner`.**
  This codebase is on **React 19**; `ref` is a regular prop on
  function components and `React.forwardRef()` is deprecated. The
  current pattern is correct. The original reviewer applied
  React-18-era guidance to a React-19 codebase.

* **`RichContentRenderer` template-string className "bypasses `cn()`".**
  `language-${lang}` and `hljs` are highlight.js classes, not Tailwind.
  `cn()` (which exists for Tailwind class-merging via `tailwind-merge`)
  would be inappropriate here.

* **`useSyncTrigger` missing `visibilitychange` listener.** The hook
  already implements `onVisibilityChange` checking `!document.hidden`
  at lines 78-85, identical to the `usePollingQuery` pattern.

* **`usePaginatedQuery` doesn't reset items on `queryFn` change.** It
  does — `load()` calls `setItems(resp.items)` after the cursor reset.

* **`useCheckboxSyntax` optimistic-update ordering bug.** The ordering
  is intentional (IPC fire-and-revert-on-error). The original review's
  reasoning was confused.

* **`useGraphSimulation` missing `edges` dependency.** `renderElements`
  *is* in the dep array and closes over `edges` (recreated when edges
  change), so the effect *does* re-run on edge changes. The comment in
  the code is correct.

* **`formatCompactDate` returns December for `m === 0`.** False —
  `arr[-1]` returns `undefined` in JavaScript (arrays do not support
  negative indexing as in Python), so the `?? 'Jan'` fallback fires
  correctly.

* **`query-utils` unescape regex misses parens that the serializer
  escapes.** Sets actually match — parens are only escaped in
  `escapeUrl` for unbalanced cases inside URL text, never in body
  text by `escapeText`.

* **`useCalendarPageDates` module-level cache "never invalidated".**
  Misread — it is an *in-flight dedup map* cleared on settle
  (`promise.then(clear, clear)`), not a result cache.

* **TipTap extension command-name collisions are not validated.**
  `blockLink` / `blockRef` / `tagRef` / etc. are unique. Speculative
  concern with no real instance.

* **`bug-report-zip` lacks PII redaction.** Per AGENTS.md threat model
  (single-user, no malicious actor), user-initiated bug reports
  inherently include the user's data — that is the design.

* **SSR guards missing in `useTheme` / `useIsMobile` / `useOnlineStatus`
  / `useWeekStart`.** This is a Tauri desktop app — pure client-side
  React, no SSR build target. SSR guards are inapplicable.

* **`SortableBlock` "has 56 props".** Validator over-counted by
  pattern-matching unrelated lines; the real count is **32** (still a
  smell, see D-1, but the headline number was wrong).

* **`SearchPanel` "has 13 useState + 6 useEffect".** Real counts are
  **22 useState + 7 useEffect** (validated). Conclusion stands; the
  numbers were undercounted.

* **`SpaceManageDialog` "is 655 lines".** Real count is **795** lines
  (validated).

## Step-by-step plan

**Phase 1 — M-1, M-2 plus L-1 .. L-5 bundle (the only commit that ships):**

1. Apply each fix in its own surgical edit:
   * M-1: add `let cancelled = false` + cleanup return.
   * M-2: introduce `MAX_TREE_DEPTH = 1000` constant + early-return.
   * L-1: extract `activeSpaceKey()` to `src/lib/active-space.ts`,
     update the four callers.
   * L-2: include `currentSpaceId` in the `useBacklinkResolution`
     cache key.
   * L-3: replace `EDITOR_PORTAL_SELECTORS` with a
     `[data-editor-overlay]` attribute scan, migrate the 8 existing
     overlays.
   * L-4: add `cleanupOrphanedPopups()` call to the roving editor's
     unmount cleanup.
   * L-5: wrap `estimateSize` in `useCallback([groupedRows])`.
2. Add the focused tests:
   * M-1: race test asserting newer fetch wins.
   * M-2: synthetic 2000-block linear chain returns first 1000 + one
     warning, no `RangeError`.
   * L-2: assert the cache returns different titles for the same id
     in two different spaces within the TTL window.
   * L-4: assert `cleanupOrphanedPopups` is called exactly once on
     editor unmount.
3. Run `npm run test` (vitest, 9000+ tests) — all green.
4. Run `prek run --all-files` — Biome + parity hooks clean.
5. Commit subject: `refactor: frontend maintainability misc — staleness guards, tree depth limit, dedup helper, cache-key correctness, cleanup hygiene (PEND-30)`.

**Phase 2 — D-1, D-2, D-3, D-4 (deferred, schedule as they come up):**

These are **not part of this plan's commit**. They are tracked here
so the next maintainability pass does not re-discover them. Each is
independently scoped — pick one off when its area needs to change
for an unrelated reason.

## Cost / risk / impact

| Dimension | M-1, M-2 | L-1 .. L-5 bundle | D-1 .. D-4 (not committed) |
| --- | --- | --- | --- |
| Cost | trivial (~15 min) | S (~1 h) | M-L per item, 14-24 h total if all four taken |
| Risk | low (each fix is surgical and additive) | low (cache-key + extract + attribute migration are mechanical) | medium per item (refactors to large files / hot paths) |
| Impact | medium — closes a real (if rare) race + adds a missing safety bound | low individually, medium aggregated — eliminates duplication, tightens cache correctness, removes hardcoded selector list | medium — large readability + testability win, but no behavioural change |

## Provenance

Two-round JS/TS maintainability review run 2026-05-04 over ~75 600 LOC of
production TS/TSX. Round 1: 6 parallel reviewers covering disjoint
slices, ~50 raw findings. Round 2: 3 parallel validators re-checked
every cited file:line; React-19 carve-outs (no `forwardRef`),
threat-model carve-outs (no SSR, no malicious peers), and intentional
documented patterns (`usePropertyKeysCache` listener,
`logger.ts` silent catch, `useResolveStore._preloaded` semantics) were
applied to demote false positives.

Final verdict distribution: **~12 hallucinations or React-version /
threat-model violations, ~15 demoted to nit / out-of-scope, 7 confirmed
non-decomposition fixes (this file's M-1, M-2 + L-1 .. L-5), 4
decomposition opportunities (D-1 .. D-4) tracked but not bundled**.

The validators caught two notable false positives in the discovery
output: the `forwardRef` finding (pre-React-19 guidance applied to a
React-19 codebase) and the `formatCompactDate` "negative-indexing bug"
(applied Python's array semantics to JavaScript).
