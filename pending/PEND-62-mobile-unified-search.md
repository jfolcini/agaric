# PEND-62 — Unified mobile search UX (one icon, scope toggle)

> Mobile UI redesign for search. Desktop today has three keybinding-driven surfaces (`Ctrl+F` in-page, `Ctrl+Shift+F` find-in-files, `Cmd+K` palette); pure-touch users have **no entry point at all** to in-page find (PEND-52 deferred). This plan **collapses the three surfaces into one mobile UI**: a single search icon in the top app bar opens a sheet with a segment control — `In this page` / `Across all pages` — context-aware default. Matches Notion's mobile pattern; the most-intuitive UX for the three-surface story.
>
> Depends on **PEND-59** (cmdk foundation) and **PEND-61** (palette as cmdk shell — the mobile sheet IS a cmdk shell in a different chrome).

## TL;DR

- **Mobile-only surface change.** Desktop keybindings unchanged.
- **One mobile search icon** in the top app bar (existing place). Tap → opens a sheet.
- **Sheet has a segment control** at top: `In this page` / `Across all pages`. Default: "In this page" when the user is on a page; "Across all pages" elsewhere.
- **In-page sub-surface** wraps the existing PEND-52 toolbar — input + toggles + counter + arrows — sized for touch.
- **Across-all-pages sub-surface** wraps the PEND-61 palette in search mode — fuzzy results, page-grouped, escalation to find-in-files.
- **Find-in-files (PEND-50) view** stays accessible on mobile via the segment's "Across all pages" deep-mode hand-off (tap "Search with toggles" footer → opens the find-in-files view as a full-screen route).
- **Pure-touch users now have access** to all three surfaces; the mental model is one search action with scope.

## Current state — verified

- Mobile entry to **in-page find**: none. PEND-52 deferred mobile entry; only desktop `Ctrl+F` opens it.
- Mobile entry to **find-in-files**: the existing sidebar nav has a Search item — that works on mobile.
- Mobile entry to **palette**: none (Cmd+K is desktop-only).
- App bar: `src/components/AppShell.tsx` or similar — verify the exact location during Phase 1. The bar has space for one search icon next to the existing avatar / menu items.
- `useDialogOrSheet()` hook exists; Radix Sheet wraps the dialog on mobile.

## Design

### App-bar icon

A magnifying-glass icon between the page title (or current view name) and the avatar / menu. Tap fires a new `useSearchSheetStore.open$()`.

### Search sheet

```text
┌─────────────────────────────────────────────────────────┐
│ ✕                Search                                  │  ← sheet header
├─────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────┐  │
│  │ In this page  │  Across all pages                 │  │  ← segment control
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│ 🔍 [search term…              ] [Aa] [Ab|] [.*]  3/12   │  ← in-page mode
│                                                          │
│ Matches highlighted in the page beneath the sheet        │
│                                                          │
│ [↑] [↓] [✕]                                              │
└─────────────────────────────────────────────────────────┘
```

```text
┌─────────────────────────────────────────────────────────┐
│ ✕                Search                                  │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────┐  │
│  │ In this page  │  Across all pages                 │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│ 🔍 [alpha                                       ]       │
├─────────────────────────────────────────────────────────┤
│ ▼ 📄 Project Alpha                              ↩       │
│      🧩  …alpha review…                                 │
│ ▼ 📄 Roadmap                                            │
│      🧩  …alpha cohort…                                 │
├─────────────────────────────────────────────────────────┤
│ Search with toggles →                                    │  ← footer escalation
└─────────────────────────────────────────────────────────┘
```

### Context-aware default

- User is reading a page (Journal entry / page view) → default segment = "In this page".
- User is on Pages list / Trash / Settings / etc. → default segment = "Across all pages".

The detection lives in `useSearchSheetStore`: it reads the current navigation view and picks the default.

### "Across all pages" → find-in-files escalation

The footer "Search with toggles →" handoff (same pattern as PEND-51's escalation) closes the sheet and navigates to the find-in-files view (`/search` route, PEND-50) with the current query pre-filled.

### Behaviour

- **Sheet open**: page content stays visible behind the sheet (translucent backdrop). In "In this page" mode, the highlights paint on the page beneath the sheet via the existing PEND-52 CSS Highlight Registry pipeline.
- **Esc / sheet close**: dismisses the sheet; if in "In this page" mode, also closes the find session (clears highlights).
- **Segment switch**: changes the sheet body but does NOT clear the input — query persists across modes for one-tap re-scope.

## Phase split

### Phase 1 — App-bar icon + sheet shell (S, ~3-4 h)

- Add the magnifying-glass icon in the mobile app bar.
- New `useSearchSheetStore` (Zustand: `open`, `mode`, `query`).
- New `<SearchSheet>` component — Radix Sheet + segment control header.
- Hook into existing `useDialogOrSheet` for mobile/desktop responsive behaviour (sheet on mobile; on desktop the icon is hidden because the three keybindings cover it).

### Phase 2 — In-page sub-surface (S, ~2-3 h)

- Embed the PEND-52 in-page-find UI inside the sheet's "In this page" body.
- Reuse `useInPageFindStore`; tie its `open` state to the sheet's segment.
- Verify CSS Highlight Registry paints on the page beneath the sheet (the sheet's backdrop must not interfere with the page DOM).

### Phase 3 — Across-all-pages sub-surface (S, ~2-3 h)

- Embed the PEND-61 palette search mode inside the sheet's "Across all pages" body.
- Reuse `useCommandPaletteStore`; tie its query to the sheet's input.
- Escalation footer routes to the find-in-files view.

### Phase 4 — Tests + docs (S, ~2 h)

- Component: open/close/segment-switch/mode-persistence-of-query/context-aware-default.
- E2E (mobile viewport): tap icon → sheet opens → switch segment → highlights paint / results render → tap escalation footer → find-in-files view opens.
- `vitest-axe` audit on both segment states.
- `docs/SEARCH.md`: new "Mobile" subsection.

## Tests

- `useSearchSheetStore.test.ts` — open/close, mode switching, context-aware default.
- `SearchSheet.test.tsx` — render, segment switch, query persistence across segments, axe.
- E2E (Playwright with iPhone viewport): full user flow per Phase 4.

## Open questions

1. **Where exactly the icon lives** — depends on the current app-bar layout. Verify in Phase 1 before committing to placement.
2. **Sheet height on iOS** — Radix Sheet uses `dvh` units which handle the soft keyboard. Verify on real iOS Safari before locking the design.
3. **Long-press the icon** — could open the palette mode directly (skip the segment). Optional polish; defer if not high-signal.
4. **Tablet (iPad-with-keyboard)** — should it use the desktop keybindings or the mobile sheet? Recommendation: detect a connected keyboard (`navigator.keyboard` API or just the existence of a hardware keyboard event) and prefer the desktop UI when present.

## Acceptance criteria

- Pure-touch user can open in-page find without a hardware keyboard.
- The single mobile search icon opens a sheet with two segments.
- Default segment depends on current view context.
- Query persists across segment switches.
- In-page find highlights paint correctly while the sheet is open.
- Across-all-pages segment can escalate to the find-in-files view via the footer.
- `vitest-axe` passes on both segments.

## Related

- `pending/PEND-59-cmdk-foundation.md` — cmdk wrapper used by the across-all-pages segment.
- `pending/PEND-61-palette-multimode.md` — palette refactor consumed by this PEND.
- PEND-52 (landed) — in-page find consumed by this PEND's "In this page" segment.
- PEND-50 (landed) — find-in-files view consumed via escalation.
- `src/components/AppShell.tsx` (or current top-bar host) — icon mount site.
