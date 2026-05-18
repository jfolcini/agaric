# PEND-60 — Caret-anchored autocomplete on cmdk

> **Status (2026-05-18):** Phase 1 + ARIA combobox polish + Phase 2 shipped on branch `pend-60-phase1-caret-autocomplete`. The full feature now ships:
>
> - Caret-anchor utility (`src/lib/caret-anchor.ts`), popover component (`src/components/search/AutocompletePopover.tsx`), SearchPanel wire-up.
> - Static value lists for `state:` / `priority:` / `due:` / `scheduled:`.
> - Full ARIA 1.1 combobox-with-listbox wiring on the input (role / aria-autocomplete / aria-haspopup / aria-expanded / aria-controls / aria-activedescendant).
> - Dynamic value sources: `tag:` (via existing `listTagsByPrefix` IPC, 150 ms debounce + request-id cancellation), `prop:` (via existing `listPropertyKeys` IPC, session-scoped cache), and `path:` / `not-path:` (per-space localStorage MRU recorded on submit).
>
> 51 frontend tests cover the surface (7 caret-anchor unit + 10 path-history unit + 11 useAutocompleteSources unit + 9 popover component + 14 SearchPanel integration). Phase 3 (Playwright e2e + `docs/SEARCH.md` autocomplete subsection) remains open.
>
> Ships the autocomplete popover that **PEND-54 deferred**. When the user types `tag:`, `state:`, `priority:`, `prop:`, etc. in the SearchPanel input, a small popover anchors next to the caret showing value suggestions; Enter / click inserts the value via the existing `applyAutocompleteReplacement` helper (already shipped + unit-tested). PEND-55's history-recall arrow keys and PEND-53's value lists both consume the same popover.
>
> Depends on **PEND-59** (cmdk foundation). The popover is one consumer of the new `<Command>` wrapper.

## TL;DR

- **Frontend only.** ~M (~6-8 h). One new component `<AutocompletePopover>` + wire-up in `SearchPanel.tsx`.
- **No new backend.** The pure detection + replacement primitives (`detectAutocompleteAnchor`, `applyAutocompleteReplacement`) are shipped in `src/lib/search-query/autocomplete.ts` and unit-tested.
- **No new deps.** Builds on cmdk (PEND-59) + Radix Popover + `@floating-ui/react` (already in deps via `@floating-ui/dom`).
- **Value lists baked in.** Static lists for `state:` (TODO / DOING / DONE), `priority:` (A / B / C / none), `due:` / `scheduled:` (the 8 bucket keywords). Dynamic lists for `tag:` (recent + matched tags) and `prop:` (known property keys from `block_properties`).

## Current state — verified

- `src/lib/search-query/autocomplete.ts` — `detectAutocompleteAnchor(input, cursorPos)` returns `AutocompleteAnchor | null` (the token prefix the cursor sits on); `applyAutocompleteReplacement(input, anchor, replacement)` produces the new input + new cursor pos. Both pure functions, ~12 tests.
- `src/components/SearchPanel.tsx` — the input is in scope. PEND-55's `useSearchHistoryCycling` already owns `↑` / `↓` when input is empty.
- PEND-59 `<Command>` wrapper exists.
- Token vocabulary (consumed by this PEND): `tag:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:`.

## Design

### Trigger

The popover opens when:

1. The input has focus, AND
2. `detectAutocompleteAnchor(input.value, input.selectionStart)` returns non-null, AND
3. The anchor's prefix has at least one known value (tag list, state list, etc.).

It closes when:

- The user presses Esc.
- The cursor moves outside the anchor.
- The input loses focus.
- The user picks a value (replacement applied, popover dismisses).

### Anchoring

Caret position → screen coordinates via a hidden `<span>` mirror of the input contents up to the cursor. The mirror lives off-screen with `visibility: hidden`; its bounding rect is the anchor for Radix `Popover`'s virtual ref. This is the textbook approach for caret-anchored popovers in text inputs (Tweet composer, GitHub mention picker, etc.).

### Value sources

| Prefix | Source | Notes |
|---|---|---|
| `tag:` | Recent tags (PEND-12 if it lands) + tag-id batch resolution | Dynamic; fetched on-open via existing `batchResolve` |
| `state:` | Static: `TODO`, `DOING`, `DONE`, `WAITING`, `CANCELLED`, `none` | + any custom states the user has used; future plan can add custom-state discovery |
| `priority:` | Static: `A`, `B`, `C`, `none` | |
| `due:` / `scheduled:` | Static bucket list: `today`, `yesterday`, `overdue`, `this-week`, `this-month`, `next-week`, `older`, `none` | |
| `prop:` | Known property keys from `block_properties` | Fetched via new `list_property_keys_inner` IPC if it doesn't exist; capped at 50 most-frequent keys |
| `path:` / `not-path:` | Recent page-name globs from history; no full enumeration | |

### Keyboard model

- Arrow up / down — navigate popover items (cmdk-native).
- Enter — select item, apply replacement.
- Tab — same as Enter (UX convention).
- Esc — close popover, restore focus to input.
- Typing — filters cmdk's list (with `shouldFilter` enabled this time — cmdk's built-in fuzzy scorer is fine for small value lists).

**Precedence with PEND-55 history recall:** the AGENTS.md invariant is autocomplete-open wins; history recall only fires when the input is empty AND the popover is closed.

## Phase split

### Phase 1 — Caret-anchor utility + popover shell (M, ~3-4 h)

- New `src/lib/caret-anchor.ts` — pure utility: takes an `<input>` ref + cursor position, returns a `DOMRect` for the caret pixel position. Tested via DOM fixtures.
- New `src/components/search/AutocompletePopover.tsx` — uses cmdk `<Command>` + Radix Popover with virtual ref. Static value lists for state / priority / due / scheduled.
- Wire into `SearchPanel.tsx`: `onChange` / `onKeyDown` / `onSelectionChange` detect anchor; mount popover at caret rect.

### Phase 2 — Dynamic value sources (S, ~2 h)

- Tag list: existing `batchResolve` + recent tags (defer recent-tags-fetch implementation if not in scope today).
- Property keys: new `list_property_keys_inner` IPC if needed; ~30 LOC backend.
- Path globs: read from history store (per-space MRU of past `path:` strings).

### Phase 3 — Tests + docs (S, ~1-2 h)

- Component tests: open/close/select/Esc/arrow/Tab; axe audit; precedence with history recall.
- E2E (Playwright): type `state:`, see popover with TODO/DOING/DONE, click TODO, assert input now reads `"state:TODO "` (with the trailing space).
- `docs/SEARCH.md` filter syntax section: add "Autocomplete" subsection.

## Tests

- `caretAnchor.test.ts` — DOM fixtures with various cursor positions.
- `AutocompletePopover.test.tsx` — opens on prefix detect; closes on Esc / blur / cursor-move-out; replacement updates input + cursor.
- `SearchPanel.autocomplete.test.tsx` — integration: typing `state:` shows TODO; arrow + Enter inserts.
- `vitest-axe` audit on the popover with results rendered.

## Open questions

1. **Mobile** — caret-anchored popover is awkward on touch (no caret to track on iOS). PEND-62 (unified mobile search) decides whether autocomplete renders at all on mobile.
2. **Custom states discovery** — should `state:` autocomplete include states the user has actually used (via a `DISTINCT todo_state FROM blocks`)? Defer; static list is fine for v1.
3. **Property-key MRU** — should `prop:` autocomplete prioritise recently-used property keys? Defer; alphabetical or frequency-based both work.

## Acceptance criteria

- Typing `state:` in SearchPanel opens a popover with TODO / DOING / DONE / WAITING / CANCELLED / none.
- Picking a value inserts it correctly; the cursor lands after the inserted value + a trailing space.
- Esc closes the popover and restores focus to the input.
- PEND-55 history recall does NOT fire while the popover is open (precedence enforced).
- `vitest-axe` passes on the rendered popover.
- IPC error-path: `list_property_keys` rejection doesn't crash; popover falls back to no `prop:` suggestions.

## Related

- `pending/PEND-59-cmdk-foundation.md` — must land first.
- `pending/PEND-54` (landed) — provides the parser + autocomplete primitives.
- `pending/PEND-55` (landed) — `↑`/`↓` precedence contract.
- `pending/PEND-53` (landed) — token vocabulary this PEND surfaces.
- `src/lib/search-query/autocomplete.ts` — pure logic, already tested.
- `src/components/SearchPanel.tsx` — integration site.
