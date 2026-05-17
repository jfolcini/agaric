# PEND-51 — Search palette dialog (Cmd+K) — navigation surface

> Adds a Cmd+K-style search palette as a **second** search surface, coexisting with the existing `SearchPanel` view. Two surfaces, two jobs: **palette for quick navigation** (this plan), **find-in-files view** for systematic search (`pending/PEND-50-search-vscode-ux.md`, which reshapes the existing view).
>
> Closes the "Ctrl+F destroys my context" papercut — the palette overlays the current view, jumps on Enter or click, and closes on Escape. Matches Linear / Raycast / Notion / VSCode's quick-open pattern. Mobile: opens as a Sheet (full-height, thumb-typing comfort).

## Architecture — two coexisting surfaces

| Surface | Open via | Job | Filters | Toggles | Result cap | Pagination |
|---|---|---|---|---|---|---|
| **Palette dialog** (this plan) | `Cmd/Ctrl+K` | Quick navigation jump | none | none | 8 page-groups × 2 matches | none (top-N) |
| **Find-in-files view** (PEND-50 foundation + PEND-54 chips + PEND-55 toggles) | `Ctrl+Shift+F` *(rebind via PEND-52)* | Systematic search | PEND-54's inline syntax + chips | PEND-55's `Aa` / `Ab\|` / `.*` | unbounded | flat cursor `(rank, block_id)` |
| **In-page find** (PEND-52) | `Ctrl+F` *(reclaimed)* | Find inside current page | none | matching `Aa` / `Ab\|` / `.*` (per-page) | n/a | `F3` / `Shift+F3` |

Both surfaces:

- Hit the same `searchBlocks` IPC.
- Render results with the **same `<SearchResultGroup>` component** (see PEND-50 Phase 0 — shared).
- Group results by page (page header + match count + indented block rows; matches VSCode's grouped-by-file layout).

The "Search in all pages with toggles →" footer in the palette is the **escalation path**: it opens the find-in-files view with the current query pre-filled. That seam is what makes the two-surface coexistence feel like one product instead of two competing search UIs.

## Design

### UX

**Empty state** (palette opened, no query yet):

```text
┌────────────────────────────────────────────────────────┐
│  🔍  Type to search a page or a block…                 │
├────────────────────────────────────────────────────────┤
│  Recent                                                 │
│  📄 Project Alpha                                       │
│  📄 Daily 2026-05-14                                    │
│  📄 Reading list                                        │
└────────────────────────────────────────────────────────┘
```

**With query**:

```text
┌────────────────────────────────────────────────────────┐
│  🔍  alpha                                              │
├────────────────────────────────────────────────────────┤
│  ▼ 📄 Project Alpha                            ← ↵     │  ← exact-title match
│        🧩  …kicked off the alpha review on Friday…      │
│        🧩  …alpha builds gate on this PR…               │
│        +1 more in this page                             │
│  ▼ 📄 Alpha test plans                                  │  ← prefix-title match
│        (no content matches)                             │
│  ▼ 📄 Roadmap                                           │  ← content-only match
│        🧩  …mentions alpha cohort under Q3 plans…       │
│                                                         │
│  Search in all pages with toggles →                Ctrl+F │  ← escalation footer
└────────────────────────────────────────────────────────┘
```

**Locked-in design choices** (the eight Q's from the original draft, resolved):

1. **Keyboard binding.** `Cmd/Ctrl+K` opens the palette. **`Ctrl+F` is reclaimed by PEND-52 for in-page find; the find-in-files view moves to `Ctrl+Shift+F`** (matching VSCode). PEND-52 owns the rebind; this plan only references the post-rebind state in the keyboard table and escalation footer.
2. **Filters in palette.** **None.** No filter chips, no sigil syntax. Filters and toggles live exclusively in PEND-50's view. The palette stays minimal — type, see results, jump.
3. **Result shape.** Page-grouped (shared with PEND-50). Ordering within the grouped list: **exact title match → prefix title match → contains-in-title → content-only match, FTS rank within each band.**
4. **Pagination.** **Two parallel capped queries**, merged client-side. No cursor in the palette; no "Load more". Escalation to the view is the answer to "I need more depth".
5. **Legacy code.** **Keep the view.** `SearchPanel.tsx`, `searchFilterReducer.ts`, `usePopoverEntity.ts`, `useAliasResolution.ts` all stay; PEND-50 reshapes them. No deletion, no migration.
6. **Mobile.** `useDialogOrSheet()` — Dialog on desktop, Sheet on mobile (existing pattern from `ConfirmDialog`).
7. **Empty state.** Recent pages (same data path as today's `SearchPanel`, just rendered in the palette container).
8. **Click behaviour.** **Plain click navigates the active tab. Cmd/middle-click opens a new tab.** Matches every browser convention; lowest surprise.

### Result grouping — shared component contract

Both surfaces render `<SearchResultGroup>` from PEND-50 Phase 0:

- Header row: page glyph + title + breadcrumb (namespace path) + match count.
- Child rows: indented block hits with 2-3 line snippet.
- Pages with **name-only match**: header alone, no expand affordance.
- Pages with **content matches**: header expandable, child rows beneath.
- **Palette caps each group's child rows at 2** via the `cap` prop; surplus matches render as a "+N more in this page" pill that links to the find-in-files view (escalation per design choice 4).
- **Palette caps the total page-group count at 8.** Surplus pages are not rendered; the escalation footer is the user's path to more.
- Expanded by default in both surfaces. Palette collapse state is **ephemeral** — resets on close. View collapse state lives in component state for the current search session (PEND-50 spec).

### Input debounce — palette deviates from the 300 ms canonical

The view uses `useDebouncedCallback(300ms)`, the canonical debounce enshrined at `AGENTS.md:195` after PERF-28. The palette **overrides this to ~80 ms** because palette UX is type-ahead — the user types `alp` and expects "Alpha" to appear in <100 ms, not a third of a second later. **Deviation justification, to land in AGENTS.md alongside the 300 ms rule**:

> The 300 ms canonical applies to *deliberate* search where each keystroke is a query refinement. Palette UX is *type-ahead navigation* where the user is composing a single instruction and the result list is part of the visual feedback. Linear / Raycast / VSCode `Cmd+P` all run sub-100 ms debounces; matching their feel is the design goal. The palette's `search_blocks_partitioned` IPC adds the stale-response guard (gen counter) so faster-than-IPC typing doesn't surface stale results.

The palette's 80 ms is **measured in CI** before locking it in: a benchmark asserts p99 round-trip latency stays under 50 ms on the trigram index for representative vault sizes. PERF-28 should not silently regress.

### Fuzzy ranking on top of FTS

The FTS5 trigram tokenizer matches *substrings* but is not edit-distance-tolerant — a typo like `alfa` (transposed/missing letter) doesn't match `Alpha`. Palettes (Linear, Raycast, VSCode's `Cmd+P`) feel telepathic specifically because they forgive typos. Add a post-FTS fuzzy re-score using **`match-sorter`** (already imported at `package.json:83`, used by `useBlockResolve`, `slash-commands`, `CodeLanguageSelector`):

- After `search_blocks_partitioned` returns, run `matchSorter(candidates, query, { keys: ['content', 'title'], threshold: matchSorter.rankings.CONTAINS })`.
- **Fuzzy is an additive scorer, not a filter.** Candidates that FTS already matched stay in; `match-sorter`'s ranking groups (`EQUAL`, `STARTS_WITH`, `WORD_STARTS_WITH`, `CONTAINS`, `ACRONYM`, `MATCHES`) blend with the FTS rank to reorder. Items FTS didn't match are not surfaced.
- **`match-sorter`'s rank groups map 1:1 to the 4-band ordering** (exact title → prefix → contains → content-only): EQUAL → exact, STARTS_WITH → prefix, CONTAINS → contains.
- **No backend change.** Pure frontend post-pass. **No new dep** — `match-sorter` is already in the bundle.

### `[[page]]` autocomplete trigger

When the user types `[[` followed by ≥ 1 character, the palette switches into **page-resolver mode**: only the pages query fires (skip the blocks query), and the input renders a thin "linking to page" badge so the user knows they're in a different mode. Pressing `Enter` inserts the resolved page as a `[[Page Title]]` link into the **previously focused block**, then closes the palette — this is Roam/Obsidian's standard pattern.

- Triggered by literal `[[` at the start of input (or after a space — TBD; start strict).
- Cancelled by `Esc` or by deleting back to before the `[[`.
- If no page matches, the palette shows "No page named `<query>` — create page?" as a single actionable row (matches Notion's pattern).
- **Requires a previously-focused block context** — if the palette is opened cold (no editor focus), the `[[page]]` mode is disabled with a tooltip "Open a page to insert a link." Phase 3 work; not blocking the core palette ship.

### Backend — one new command, one FTS round-trip

**Problem with two parallel `searchBlocks` calls**: both run FTS5 MATCH on the same query string, which is the expensive part. The blocks query's result set is a superset of the pages query's. Running both wastes ~half the FTS work and doubles SQLite pool pressure.

**Solution**: one new Tauri command `search_blocks_partitioned` returns both sets in a single round-trip:

```rust
#[tauri::command]
#[specta::specta]
pub async fn search_blocks_partitioned(
    pool: tauri::State<'_, SqlitePool>,
    query: String,
    page_limit: u32,
    block_limit: u32,
    filter: SearchFilter,
) -> Result<PartitionedSearchResult, AppError> { ... }

pub struct PartitionedSearchResult {
    pub pages: Vec<SearchBlockRow>,
    pub blocks: Vec<SearchBlockRow>,
}
```

Inside, one FTS MATCH yields a candidate set; the function partitions by `block_type` and applies the two caps. Single SQL, single pool acquire, single sanitisation.

The frontend palette consumes:

```typescript
const result = await searchBlocksPartitioned({
  query,
  pageLimit: 8,
  blockLimit: 40,
  filter: {},  // empty SearchFilter — palette has no filters by design
})
```

Then merges client-side by `page_id`:

1. For each row in `result.pages`, create a `<SearchResultGroup>` (matches list initially empty).
2. For each row in `result.blocks`, append to the existing group keyed by `block.page_id`; if no group exists, create one (content-only match).
3. Sort groups by the 4-band ordering rule above.
4. Slice to the top 8 groups.
5. Within each group, slice matches to the top 2 (`cap` prop renders "+N more" pill).

**Stale-response guard**: a generation counter (incremented per keystroke) is checked on response; stale responses are discarded. Pattern matches `hooks/usePaginatedQuery.ts:75-122`'s `requestIdRef`.

### Keyboard

| Key | Action |
|---|---|
| `Cmd/Ctrl+K` | Open palette |
| `Esc` | Close palette |
| `↑` / `↓` | Move focus through visible result tree (page header → block rows → next page header) |
| `Enter` | Activate focused result (page or block) — navigates active tab |
| `Cmd/Ctrl+Enter` | Activate in new tab |
| `Cmd/Ctrl+F` | (Existing, unchanged) Open find-in-files view |

Focus management: the first page-group's header is auto-focused on mount; arrow keys cycle through the flattened (expanded) tree. The escalation footer is reachable via Tab from the input.

### Component layout

- **New** `src/components/SearchDialog.tsx` — top-level container, mounted at App shell. Wraps `useDialogOrSheet('dialog')` (the `'dialog'` discriminator, not `'alert'` — palette is dismissible, not action-confirming).
- **Reuses** `SearchInput` from the view's chain (same component, mounted in two surfaces).
- **Renders** a stack of `CollapsibleGroupList` instances (PEND-50's reused grouped renderer) wrapping `<SearchResultBlockRow>` (PEND-50), with `cap={{ matchesPerGroup: 2 }}` enforced client-side before construction.
- **State** in a new `useSearchDialogStore` (Zustand): `{ open: boolean, query: string, pendingViewQuery: string | null }`. Minimal; the transient `pendingViewQuery` slot powers escalation handoff.
- **Keyboard binding** in `src/hooks/useAppKeyboardShortcuts.ts:221` — bind `Cmd/Ctrl+K` to `useSearchDialogStore.getState().open()`. PEND-52 carries the `Ctrl+F` rebind (to in-page find) and the new `Ctrl+Shift+F` binding for the view.

### Escalation to the find-in-files view

When the user clicks the "Search in all pages with toggles →" footer (or presses `Ctrl+Shift+F` while the palette is open):

1. Read the current query from `useSearchDialogStore`.
2. Write the query into a **transient handoff slot** on `useSearchDialogStore` (`pendingViewQuery: string | null`). The view reads and clears this slot on mount via `useEffect`.
3. Close the palette (`setOpen(false)`).
4. `useNavigationStore.getState().setView('search')` (the `'search'` case is at `ViewDispatcher.tsx:142`).
5. `SearchPanel` on mount checks `useSearchDialogStore.getState().pendingViewQuery`; if non-null, calls `setQuery(pendingViewQuery)` and clears the slot.
6. View opens with toggles default-off and the chip row reflecting any filter syntax in the handed-off query.

**Why the transient handoff slot instead of lifting `SearchPanel`'s `useState`**: lifting the view's query into Zustand would change PEND-54's "query lives in `SearchPanel.useState`" decision and force every chip/autocomplete component to consume the store. The handoff slot is a one-shot affordance — written by the palette, consumed by the view exactly once, then cleared. No global query state, no shared reactivity surface.

## Phase split

**Pre-requisite: PEND-50 must land first** (it provides `CollapsibleGroupList`-driven grouped rendering + `<SearchResultBlockRow>` + the `SearchFilter` IPC struct that this plan defaults). No Phase 0 in this plan — the foundation is PEND-50's deliverable.

### Phase 1 — Palette dialog core (M, ~7-10 h)

- `SearchDialog.tsx` + `useSearchDialogStore` + `useAppKeyboardShortcuts` binding for `Cmd/Ctrl+K`.
- **New backend command** `search_blocks_partitioned` (one FTS round-trip, returns `{ pages, blocks }`); frontend caller via `src/lib/tauri.ts` wrapper.
- Stale-response guard via generation counter (matches `hooks/usePaginatedQuery.ts:75-122` pattern).
- Recent-pages empty state (reuse existing `recentPages` data path from `src/lib/recent-pages.ts`).
- `useDialogOrSheet('dialog')` integration for the desktop/mobile shape.
- Result list rendering reuses PEND-50's `CollapsibleGroupList` + `<SearchResultBlockRow>` with `cap={{ matchesPerGroup: 2 }}` and "+N more" pill.
- `match-sorter` re-scorer on the merged candidate set (no new dep; already imported).
- Escalation footer button + transient `pendingViewQuery` handoff to the view.
- `[[page]]` mode trigger (Phase 3 work; not in Phase 1).
- Keyboard navigation through the result tree (arrow keys, Enter, Cmd-Enter).
- Tests: open / close / Esc / Enter / Cmd-Enter / arrow nav / Sheet on mobile breakpoint / empty state shows recents / escalation pre-fills view input / page-grouped rendering / cap=2 with "+N more" pill / stale-response guard discards old responses.

### Phase 2 — Docs (S, ~0.5 h)

- `KeyboardShortcuts` help dialog: add `Cmd/Ctrl+K` row + clarify `Ctrl+F` still opens the view.
- `README.md`: one-line entry under *Search* — "Cmd+K for quick jump, Ctrl+F for find-in-files."
- No new architecture doc; PEND-50's `docs/architecture/search.md` covers both surfaces.

## Cost / Impact / Risk

- **Cost:** Phase 0 ~2-3 h (counted once across this plan + PEND-50). Phase 1 ~6-9 h. Phase 2 ~0.5 h. **Total M (~1-1.5 days).**
- **Impact:** **High.** Closes the "Ctrl+F destroys my context" papercut without losing the find-in-files surface. Matches every modern editor's Cmd+K convention — users coming from Linear, Raycast, Notion, VSCode get exactly what they expect. Mobile gets a usable search for the first time (the existing full-takeover view is unusable on a phone).
- **Risk:** **Low.** Two-surface coexistence is reversible at every step. No legacy code deleted; the new dialog is purely additive. Phase 0 (the shared render component) touches existing-view rendering shape but is a refactor inside `SearchPanel`, not behaviour change. The riskiest seam is the parallel-query rank merge — but the top-N cap + the explicit 4-band ordering rule keep result ordering predictable and testable.

## Coherence with PEND-50

| Artifact | Owner | Used by |
|---|---|---|
| `<SearchResultGroup>` render component | Phase 0 (shared) | Both |
| Page-grouped result shape (4-band ordering) | Spec'd identically in both plans | Both |
| `SearchFilter` struct + `SearchBlockRow` struct | Owned by PEND-50 (foundation); palette uses defaults (no filters) | Both |
| `search_blocks_partitioned` command | **New** — owned by this plan. Single FTS round-trip; returns `{ pages, blocks }`. | Palette only; view uses `search_blocks` |
| `AppError` `{kind, message}` shape | Existing (`error.rs:152-165`); validation errors flow through with `kind: "validation"` and a `<Variant>:` message prefix | All plans (PEND-54 uses `InvalidGlob:`, PEND-55 uses `InvalidRegex:`) |
| `useDialogOrSheet()` mobile pattern | Existing (`ConfirmDialog`) | This plan only |
| `recentPages` data path | Existing | Both surfaces' empty state |

**Either plan can ship first.** If this plan ships first: Phase 0 is owned here, and PEND-50 inherits the component when it lands. If PEND-50 ships first: same, but the dependency direction reverses. The phase numbers stay the same in both plans.

## Related

- `pending/PEND-50-search-vscode-ux.md` — the find-in-files surface this plan pairs with. Shares Phase 0.
- `src/components/SearchPanel.tsx` — the existing view; reshaped (not deleted) by PEND-50.
- `src/components/ConfirmDialog.tsx` → `useDialogOrSheet()` — the mobile pattern reused here.
- `src/hooks/useAppKeyboardShortcuts.ts:221` — site for the new `Cmd/Ctrl+K` binding.
- `src/components/ViewDispatcher.tsx:144` — existing `'search'` view case; **stays untouched** (the view remains the find-in-files surface).
