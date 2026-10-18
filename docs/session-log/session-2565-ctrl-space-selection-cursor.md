# Session 2565 — Ctrl+Space and Ctrl+Arrow drive a selection cursor in the block list (#5734)

#5734's last item asked for an e2e spec of "Ctrl+Space toggles the focused block's
selection". The chord did not exist, so it was built to the WAI-ARIA APG
multi-select pattern, where the cursor is distinct from the selection.

**Behaviour:**
- In a block, `Ctrl+Space` leaves it selected, with the selection cursor (a focus
  ring on the row `li`) on it.
- With blocks selected and focus in the block list, `Ctrl+Space` adds or removes
  the block under the cursor and `Ctrl+↑` / `Ctrl+↓` move the cursor without
  changing the selection; `Shift+↑` / `Shift+↓` select a range from it.
- The chords act only while focus is in rows this tree owns
  (`focusIsInRows` in `use-block-tree-keyboard-shortcuts.ts`); from a toolbar, the
  page title or another tree they do nothing and are not `preventDefault`ed.
- Selection changes are spoken once through `announce()` ("N blocks selected",
  "Selection cleared"), from one subscription in `stores/blocks.ts`, so a journal
  view with several trees still speaks once and an unchanged count says nothing.
  The toolbar's count stays plain text, so nothing is spoken twice.

**Shown red:** the focus gate removed, never passing, or accepting only the row
element (unit); the gate disabled (e2e, the toolbar count); no announce, no clear
announcement, the count guard removed or replaced by an identity check (unit); the
`_other` plural key mistyped (unit); announce removed and a `status` role put back
on the toolbar (e2e).

**Not built:** exposing the selection as `aria-selected` needs the list to become
`role=tree` with `treeitem` rows across `BlockListRenderer`, `SortableBlockWrapper`
and the embed rows; each row's "Select block" checkbox already conveys it. axe on
the real DOM finds no violation the cursor states add.
