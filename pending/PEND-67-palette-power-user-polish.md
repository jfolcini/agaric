# PEND-67 — Command Palette power-user polish (commands mode v2)

> Follow-up to PEND-61. Closes the gap between Agaric's `CommandPalette` (currently "very good cmdk implementation" per the senior-UX CR) and best-in-class command surfaces (Linear / Raycast / Notion / VSCode / Arc). All 8 phases are independently shippable; pick whichever yield the most polish-per-hour for the current sprint.
>
> Depends on PEND-61 (shipped 2026-05-19). Out of scope of PEND-62 (mobile / touch), which carries its own punch list (numeric prefix on touch + per-mode persistent query were originally proposed there but moved here because they're keyboard-centric polish).

## TL;DR

- 8 small phases, each 1-4 h, total ~14-20 h. None block each other; each is independently shippable.
- Net new feature surface — **none of these are technical debt from PEND-61**; they're "raise the polish bar" items the maintainer explicitly asked for.
- **Out of scope:** the Raycast right-rail "result preview" pane (large LOC delta, debatable parity value — defer indefinitely).

## Current state — verified (2026-05-19)

- `src/components/CommandPalette.tsx` — ~970 LOC; cmdk shell with `'search'` + `'commands'` modes. 6-command static registry (`go-pages` / `go-tags` / `go-trash` / `go-history` / `go-settings` / `search-everywhere`).
- `src/stores/useCommandPaletteStore.ts` — closed enum `PaletteMode = 'search' | 'commands' | 'nav' | 'spaces' | 'agents' | 'settings'`. The 4 latter slots are reserved for separate PEND plans.
- `src/lib/recent-pages.ts` + `src/stores/recent-pages.ts` — recent-pages tracking. Space-scoped via `recentPagesBySpace`. No recent-**commands** parallel.
- `src/lib/keyboard-config/catalog.ts` — rebindable shortcut catalog. Picker-trigger characters (`/`, `@`, `[[`, `((`, `::`) are intentionally not rebindable (per `docs/UX.md`).
- `CommandPalette.tsx` exposes a footer-hint row (`↵ open · ⌘↵ new tab · esc close`) but NO inline per-command shortcuts.
- Tab does nothing inside the palette today (cmdk swallows / passes through).
- No pinned recents, no run-last-command, no `#` / `?` quick-action prefixes beyond the existing `[[` (link mode) and `>` (commands mode).

## Phases

### Phase 1 — Inline per-command keyboard shortcuts (S, ~2 h)

**Why:** VSCode / Raycast / Linear all render the shortcut next to each command (e.g. `Open Settings ⌘,`). Power users scan keystrokes faster than labels. Currently every command in `commands` mode is text-only.

**How:**

- Extend the `commands` registry in `CommandPalette.tsx` (`CommandsModeBody`) with an optional `shortcutId: string` keyed against `src/lib/keyboard-config/catalog.ts`.
- Read the binding via `getBindingForId(shortcutId)` (or the existing helper if any); render the chord as right-aligned `<kbd>` chips using the same `<kbd>` styling as the `PaletteFooterHint` (already in code).
- **Honour rebinding.** Read live from the keyboard-config store so a user-rebound shortcut updates immediately.
- Initial bindings to surface (the catalog already has these):
  - `go-pages` → no current shortcut; OK to omit.
  - `go-settings` → no current shortcut; OK to omit.
  - `search-everywhere` → `Ctrl+Shift+F` (from the existing `findInPage` / `focusSearch` family — verify the exact id in catalog.ts).
- Use the same `<kbd>` chip JSX that `PaletteFooterHint` ships so the typography stays consistent.

**Tests:**

- A command with a bound shortcut renders the `<kbd>` chip.
- A command without a `shortcutId` renders without a trailing chip (no empty span).
- Re-rendering after a rebind shows the new chord.

### Phase 2 — Recent commands tracking (S, ~2-3 h)

**Why:** Recent pages exist; recent commands don't. Power users repeatedly run the same 1-2 commands (e.g. "Search across all pages") — surfacing them as a "Recent" group in commands mode lifts the experience to Raycast parity.

**How:**

- New `src/lib/recent-commands.ts` — mirrors `recent-pages.ts`. localStorage-backed, **space-scoped** (per `docs/UX.md` § Spaces: every list slice partitions by space). Migration: if the user has no `recent_commands:<space>` key, start empty.
- Cap to `MAX_RECENT_COMMANDS = 5`. Newest first. Same de-dup-on-write pattern as `addRecentPage`.
- New `src/stores/recent-commands.ts` mirroring `src/stores/recent-pages.ts` (`recentCommandsBySpace`, `selectRecentCommandsForSpace`, `addRecentCommand`).
- In `CommandsModeBody`, render a `Recent` group ABOVE Navigate / Actions when the filter is empty. Item glyph: `RotateCcw` (Lucide). Same `Clock` glyph would clash with recent pages — use a different one.
- `c.run()` writes to recent-commands before invoking the handler.

**Tests:**

- After running `go-settings`, opening commands mode shows it in `Recent`.
- Recent commands are NOT shared across spaces (FEAT-3 invariant).
- Cap at 5; the 6th overwrites the oldest.
- Empty filter shows recents; non-empty filter hides them.

### Phase 3 — Quick-action prefixes: `#` (tag jump), `?` (help) (S, ~3 h)

**Why:** Slack / Linear use prefix routing for fast cross-modal jumps (`@` for people, `#` for channels, `?` for help). Agaric already has `>` (commands) and `[[` (page link). Two more cheap shortcuts give the palette a unified entry vocabulary.

**Note:** `docs/UX.md` § Keyboard model — picker-trigger characters (`/`, `@`, `[[`, `((`, `::`) are not rebindable. The new `#` and `?` prefixes inherit the same rule.

**How:**

- Extend `PaletteMode` with `'tags'` and `'help'` (reserved enum slots already exist for the broader nav/spaces/agents/settings vocabulary; add these two).
- Mode router (`PaletteBody` `useEffect` at line ~212) — detect `#` and `?` prefix on empty-state input the same way `>` is detected.
- `'tags'` mode body — renders a list of `block_type='tag'` matches via `searchBlocks({ blockTypeFilter: 'tag', ... })`. Re-uses the search-mode rendering minus the page-group structure.
- `'help'` mode body — renders the keyboard-shortcut catalog as a scrollable list, grouped by category. Re-uses the existing `KeyboardShortcuts` component data (`src/components/KeyboardShortcuts.tsx`) — extract the rendering into a sibling that the palette can mount.

**Open questions:**

- Should `'help'` mode just open the existing `KeyboardShortcuts` dialog and close the palette? (Cheaper.) Or render inline? (Better UX.) **Recommend inline** to stay consistent with the other modes; it costs ~50 LOC vs the alternative's ~5.
- Tag jump: does it navigate to the tag's filter view, or insert the tag into the previously focused editor? **Recommend navigate** (matches `go-tags` semantics; insert-into-editor is the `[[` flow's job).

**Tests:**

- Typing `#alpha` flips mode to `'tags'`, prefix stripped, IPC fires.
- Typing `?` flips mode to `'help'` and renders the shortcut list.
- `#`-mode and `?`-mode are reachable via the chip too (the chip cycles through all modes the user could enter via prefix).

### Phase 4 — Pinned recents (S, ~3 h)

**Why:** Raycast and Arc both let users pin a recent so it sticks above the chronological list. Heavy users have 2-3 "always" destinations; pinning them removes the typing cost entirely.

**How:**

- Extend `RecentPage` (`src/lib/recent-pages.ts`) with `pinned?: boolean`.
- Storage migration: existing entries default `pinned = false`. The cap (`MAX_RECENT_PAGES`) applies only to non-pinned entries; pinned entries are NOT counted against the cap and are NOT evicted on overflow.
- Sort order: pinned entries first (in pin order), unpinned after (in recency order).
- Pin affordance: a small `Pin` icon (Lucide) on each `Recent` row that appears on hover/focus. Clicking the icon toggles pin. Right-click context menu on the row also offers pin/unpin (optional, defer to Phase 5's action menu).
- Pinned-row indicator: a filled `Pin` icon to the left of the title (replaces the `Clock` glyph for pinned items).

**Tests:**

- Pinning a recent moves it to the top.
- Unpinning restores chronological order.
- Pinned items survive the `MAX_RECENT_PAGES` eviction.
- Pin state is space-scoped.

### Phase 5 — Right-rail action menu (Tab opens) (M, ~3-4 h)

**Why:** Currently the only secondary action on a row is `⌘↵` (open in new tab). Raycast exposes a per-row action sheet via Tab: "Open in new tab", "Pin to recents", "Copy link", "Reveal in Pages view". Notion does the same via a `…` medallion on hover. The action menu becomes the canonical home for ALL non-primary actions, replacing the current "modifier-key only" model.

**How:**

- New `<PaletteActionMenu>` component — a Radix `Popover` anchored to the focused row via `@floating-ui/dom` (per `docs/UX.md`). Same primitive as `MenuPopoverContent`.
- Trigger: Tab on a focused row (keyboard) OR a `…` icon button at row-right on `pointer:fine` hover (mouse). On `pointer:coarse` (touch), the menu is the long-press affordance (per `useBlockTouchLongPress` pattern in `docs/UX.md`).
- Actions per row type:
  - Page-header row: Open, Open in new tab, Copy ULID, Reveal in Pages view, Pin to recents.
  - Block-hit row: Open page, Open in new tab, Copy block link.
  - Recent row: Open, Open in new tab, Unpin (if pinned) / Pin (if not), Remove from recents.
  - Command row: Run, Run + close.
- Each action is a `<MenuItem>` with i18n key + optional inline shortcut (e.g. "Open  ↵", "Open in new tab  ⌘↵").
- Menu closes on Escape (returns focus to the originating row) or on action selection (closes the palette unless the action says otherwise).

**Open question:** Tab inside a cmdk `<CommandInput>` typically advances focus out of the input. We need to intercept Tab on the input (or on the list wrapper) to open the action menu instead. Verify this doesn't break the existing tab-trap behaviour from Radix `Dialog`.

**Tests:**

- Tab on a focused row opens the menu.
- Escape closes the menu and restores focus.
- Each row-type renders the correct action set.
- Action menu meets the 44 px touch floor (per `docs/UX.md`).

### Phase 6 — Per-mode persistent query (S, ~1-2 h)

**Why:** VSCode's Cmd+P remembers the last query per mode (Cmd+P search query, Cmd+Shift+P command query). Today switching modes via the chip clears the query (`ModeChipRow.toggleMode` calls `setQueryStore('')`). Per-mode memory makes mode toggling feel responsive instead of destructive.

**How:**

- Extend `useCommandPaletteStore` with `queryByMode: Record<PaletteMode, string>`.
- `setQuery(q)` writes to BOTH `queryByMode[currentMode]` AND the flat `query` field.
- `setMode(m)` reads `queryByMode[m]` and writes to the flat `query` field.
- `toggleMode` (in `ModeChipRow`) no longer calls `setQueryStore('')`.
- Cleared on `close()` (full reset).

**Tests:**

- Type "alpha" in search mode → chip-toggle to commands → query becomes "" → toggle back → query restores "alpha".
- `close()` clears `queryByMode` entirely.

### Phase 7 — Numeric prefix shortcut (1-9 jump) (S, ~1 h)

**Why:** Raycast and many CLI palettes let the user press 1-9 to jump to the Nth visible item. Cheap on desktop, even cheaper on touch (PEND-62 carries the touch variant).

**How:**

- `handleListKeyDown` in `CommandPalette.tsx` (already wired) catches `'1'`-`'9'` keys when the focus is on the input AND the input is empty (so it doesn't conflict with typing a number into a search query).
- Walk the visible `cmdk-item` list via `document.querySelectorAll('[cmdk-item]')[N-1]` and dispatch a synthetic select event the same way cmdk's Enter handler does.
- **Trap-door:** if the user types something starting with a digit (e.g. `2023-budget`), the numeric shortcut MUST NOT fire. The "input is empty" guard handles this.

**Tests:**

- `1` on empty input fires the first row.
- `2` on a non-empty input ("alpha") inserts the digit instead of jumping.
- `0` does nothing (no row at index 0).

### Phase 8 — Run last command (`⌘.` re-runs) (S, ~1-2 h)

**Why:** Raycast's "Run last command" via `⌘.` saves time on repetitive nav. We already track the recently-run command (Phase 2). Adding a global keyboard shortcut to re-run the last one is a 1-line lookup.

**How:**

- Add `runLastCommand` to `src/lib/keyboard-config/catalog.ts`. Default chord: `Ctrl+.` / `Cmd+.`.
- Hook into `useAppKeyboardShortcuts` — when the chord fires, look up `useCommandPaletteStore.getState()` and the most-recent entry from `selectRecentCommandsForSpace`. If it exists, invoke `c.run()` directly (don't open the palette).
- If no recent commands exist, fall back to opening the palette in commands mode.

**Tests:**

- After running `go-settings` once, pressing `Cmd+.` runs it again without opening the palette.
- Pressing `Cmd+.` with no recent commands opens the palette in commands mode.
- The shortcut respects rebinding.

## Tests overall

Every phase adds a `vitest-axe` audit on the new surface. Component tests follow the `src/components/__tests__/CommandPalette.test.tsx` shape (mock the IPC, mock the store, assert behaviour via testid + side effects). Touch-floor sizing is asserted in the keyboard config tests (not the palette tests) per the project's existing split.

## Open questions

1. **Action-menu trigger key on Linux desktops** — Tab is the obvious key but conflicts with browser tab-out semantics. Should we use `→` (right arrow) on a focused row instead (Notion uses this)? Phase 5 needs to settle this before implementation.
2. **`?` for help** — does this conflict with the global `?` shortcut that opens `KeyboardShortcuts.tsx`? If yes, the prefix only fires inside the palette and the global handler stays unchanged. Verify.
3. **Pinned recents — UI placement** — separate "Pinned" group above "Recent", or just sort-by-pin within one group? **Recommendation:** separate groups (clearer mental model; matches Notion's "Pinned" + "Recent" split).
4. **`commandsEmpty` copy when filter is non-empty AND no commands match** — current copy is `"No commands match — clear the input to see all."`. After Phase 3 (`#` / `?`), should the copy hint at those prefixes too? Likely yes, but the copy gets long fast. Maybe a separate `palette.commandsEmptyWithPrefixHint` for the multi-prefix case.

## Acceptance criteria

- Phases 1-8 land as separate commits. Each commit's CommandPalette tests pass.
- `prek run --all-files` clean.
- `vitest-axe` clean on all new surfaces.
- All new strings via `t()`; new shortcut bindings registered in `keyboard-config/catalog.ts`.
- No new Tailwind literals (use semantic tokens per `docs/UX.md`).
- Lucide-only icons; one icon per action across the file.
- Touch floor ≥ 44 px on every interactive element under `pointer:coarse`.
- `pending/PEND-67-palette-power-user-polish.md` deleted on completion; `pending/README.md` updated.

## Cost / impact / risk

- **Cost:** ~14-20 h, evenly split across 8 phases. None individually large.
- **Impact:** Lifts the palette from "very good cmdk implementation" to best-in-class. Concrete: Linear feature parity = Phase 1 + 2 + 4 + 6; Raycast feature parity adds Phase 5 + 8.
- **Risk:** Phase 5 (action menu) carries the most design surface — focus management, touch behaviour, action-set divergence per row type. Suggest building it last so the other phases harden the underlying contracts first.

## Related

- `pending/PEND-62-mobile-unified-search.md` — mobile-only search UX. Numeric-prefix shortcut from Phase 7 will need a touch counterpart added to PEND-62.
- `pending/PEND-66-replace-execcommand.md` — tracking PEND for the deprecated API.
- `pending/PEND-61-palette-multimode.md` — shipped 2026-05-19; this plan is the v2 polish layer on top.
- `docs/UX.md` § Keyboard model, § Touch & responsive, § Accessibility — every phase is constrained by these conventions.
