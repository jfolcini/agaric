# PEND-51 — Search palette dialog (Cmd+K) — navigation surface

> Adds a Cmd+K-style search palette as a **second** search surface, coexisting with the existing `SearchPanel` view. Two surfaces, two jobs: **palette for quick navigation** (this plan), **find-in-files view** for systematic search (`pending/PEND-50-search-vscode-ux.md`, which reshapes the existing view).
>
> Closes the "Ctrl+F destroys my context" papercut — the palette overlays the current view, jumps on Enter or click, and closes on Escape. Matches Linear / Raycast / Notion / VSCode's quick-open pattern. Mobile: opens as a Sheet (full-height, thumb-typing comfort).

## Architecture — two coexisting surfaces

| Surface | Open via | Job | Filters | Toggles | Result cap | Pagination |
|---|---|---|---|---|---|---|
| **Palette dialog** (this plan) | `Cmd/Ctrl+K` | Quick navigation jump | none | none | 8 page-groups × 2 matches | none (top-N) |
| **Find-in-files view** (PEND-50) | `Ctrl+F` *(unchanged)* | Systematic search | PEND-50's glob include/exclude | `Aa` / `Ab\|` / `.*` | unbounded | flat cursor `(rank, block_id)` |

Both surfaces:

- Hit the same `searchBlocks` IPC.
- Render results with the **same `<SearchResultGroup>` component** (see PEND-50 Phase 0 — shared).
- Group results by page (page header + match count + indented block rows; matches VSCode's grouped-by-file layout).

The "Search in all pages with toggles →" footer in the palette is the **escalation path**: it opens the find-in-files view with the current query pre-filled. That seam is what makes the two-surface coexistence feel like one product instead of two competing search UIs.

## Design

### UX

**Empty state** (palette opened, no query yet):

```
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

```
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

1. **Keyboard binding.** `Cmd/Ctrl+K` opens the palette. `Ctrl+F` keeps opening the find-in-files view, **unchanged**. Coexistence, no migration cost for existing users.
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

### Backend pagination — two parallel capped queries

On every (debounced) input change:

```text
Promise.all([
  searchBlocks({ query, blockTypeFilter: 'page', limit: 8, cursor: null }),  // page hits
  searchBlocks({ query, limit: 40, cursor: null }),                          // block hits
])
```

Merge client-side by `page_id`:

1. For each page hit, create a `<SearchResultGroup>` (matches list initially empty).
2. For each block hit, append to the existing group keyed by `block.page_id`; if no group exists for that page, create one (this is the "content-only match" case).
3. Sort the groups by the 4-band ordering rule above.
4. Slice to the top 8 groups.
5. Within each group, slice block matches to the top 2 (the `cap` prop on `<SearchResultGroup>` handles the "+N more" pill).

**No new IPC command.** Reuses `searchBlocks`. The pages-first query needs one new optional field on `SearchFilter`: `block_type_filter: Option<String>` — added by this plan's Phase 1, `#[serde(default)]` so existing callers (including PEND-50's view) are unaffected. Frontend uses `block_type_filter: Some("page")` for the pages query and `None` for the blocks query. The new field auto-flows through `tauri-specta` into `src/lib/bindings.ts`.

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

- **New** `src/components/SearchDialog.tsx` — top-level container, mounted at App shell. Wraps `useDialogOrSheet()` for desktop/mobile shape.
- **Reuses** `SearchInput` from the view's chain (same component, mounted in two surfaces).
- **Renders** `<SearchResultList>` → a stack of `<SearchResultGroup>` instances (PEND-50 Phase 0 component), all driven by the merged result list.
- **State** in a new `useSearchDialogStore` (Zustand): `{ open: boolean, query: string, prefillQueryOnEscalate: (query) => void }`. The store is minimal; query lives here only so the escalation handoff to the view can read it.
- **Keyboard binding** in `src/hooks/useAppKeyboardShortcuts.ts:221` — bind `Cmd/Ctrl+K` to `useSearchDialogStore.getState().open()`. Existing `Ctrl+F` → view binding stays.

### Escalation to the find-in-files view

When the user clicks the "Search in all pages with toggles →" footer (or presses `Ctrl+F` while the palette is open):

1. Read the current query from `useSearchDialogStore`.
2. Close the palette (`setOpen(false)`).
3. `useNavigationStore.setView('search')` (existing path).
4. Pre-fill the view's input with the query.
5. View opens with toggles default-off and glob filter section collapsed (PEND-50 default).

This is the seam that makes the two surfaces feel like one workflow. The user can start in the palette ("just typing to find a page") and graduate to the view ("I need regex / filters") without losing their query.

## Phase split

### Phase 0 — Shared `<SearchResultGroup>` component (S, ~2-3 h)

**Owned by PEND-50 OR this plan, whoever ships first.** See PEND-50 Phase 0 for the contract. Both plans inherit it.

### Phase 1 — Palette dialog core (M, ~6-9 h)

- `SearchDialog.tsx` + `useSearchDialogStore` + `useAppKeyboardShortcuts` binding for `Cmd/Ctrl+K`.
- Two-parallel-query merge logic (client-side `block_type` partitioning until PEND-50 lands a `block_type_filter` IPC param).
- Recent-pages empty state (reuse the existing `recentPages` data path from `SearchPanel`).
- `useDialogOrSheet()` integration for the desktop/mobile shape.
- Result list rendering using Phase 0's `<SearchResultGroup>` with `cap={{ matchesPerGroup: 2 }}`.
- Escalation footer button + handoff to the view with query pre-fill.
- Keyboard navigation through the result tree (arrow keys, Enter, Cmd-Enter).
- Tests: open / close / Esc / Enter / Cmd-Enter / arrow nav / Sheet on mobile breakpoint / empty state shows recents / escalation pre-fills view input / page-grouped rendering / cap=2 with "+N more" pill.

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
| `searchBlocks` IPC command | Existing; both plans add optional `#[serde(default)]` fields to its `SearchFilter` input struct (PEND-50: `include_page_globs` / `exclude_page_globs` / `case_sensitive` / `whole_word` / `is_regex`; this plan: `block_type_filter`). No new commands. | Both |
| `SearchFilterError` typed errors | PEND-50 adds `InvalidGlob(String)` + `InvalidRegex(String)`; this plan adds none | Both via `src/lib/bindings.ts` (auto-regenerated via tauri-specta) |
| `useDialogOrSheet()` mobile pattern | Existing (`ConfirmDialog`) | This plan only |
| `recentPages` data path | Existing | Both surfaces' empty state |

**Either plan can ship first.** If this plan ships first: Phase 0 is owned here, and PEND-50 inherits the component when it lands. If PEND-50 ships first: same, but the dependency direction reverses. The phase numbers stay the same in both plans.

## Related

- `pending/PEND-50-search-vscode-ux.md` — the find-in-files surface this plan pairs with. Shares Phase 0.
- `src/components/SearchPanel.tsx` — the existing view; reshaped (not deleted) by PEND-50.
- `src/components/ConfirmDialog.tsx` → `useDialogOrSheet()` — the mobile pattern reused here.
- `src/hooks/useAppKeyboardShortcuts.ts:221` — site for the new `Cmd/Ctrl+K` binding.
- `src/components/ViewDispatcher.tsx:144` — existing `'search'` view case; **stays untouched** (the view remains the find-in-files surface).
