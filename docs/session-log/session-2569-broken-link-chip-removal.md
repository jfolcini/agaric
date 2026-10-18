# Session 2569 — clicking a broken `[[link]]` chip removes it, and Undo brings it back (#5736)

#5736's last Tags & links item: a `[[link]]` whose target moved to another space
renders as a broken chip; a click should remove the reference and Ctrl+Z restore
it. Only the toast existed, so the maintainer chose to build it.

**Broken** is the existing rule: `resolveBlockStatus(id) === 'deleted'` (deleted,
other-space or unknown target), the one behind the strike-through. A live chip
behaves as before; read-only surfaces (backlinks, search, history) keep the
"(deleted)" chip.

**Removal:** a labelled `[[id|label]]` leaves its label as text; an unlabelled one
leaves nothing, so no other space's title is written into the block.
- **Static block:** the chip is a `<button>` in the design-system Tooltip, named by
  its label plus "(remove broken link)". `renderRichContent` takes an
  `onRemoveBrokenLink` option that drops that node and re-serializes; `EditableBlock`
  writes through the page store's `edit` as its own undo entry (`merge: false`, as
  paste does), so undo never takes earlier typing with it. Focus moves to the row's
  drag handle. The toast carries Undo, which reverts the removal through the page's
  undo, so it works on touch and in the journal, where Ctrl+Z does not; once the
  page has changed since, it says so and does nothing.
- **Block editor and page mode:** the chip view uses `resolveStatus`; a broken chip
  is struck through, a `button` with the same name, and a click removes it in one
  transaction closed off from adjacent typing (`closeHistory`), so Ctrl+Z restores
  just the link.

**Shown red:** the button's name or tooltip emptied; every link of two removed; the
label always dropped; the chip unfocusable; every chip removable; the removal call
dropped; the toast made unconditional; the toast's Undo not reverting; the stale
check inverted; the merge opt-out removed (undo took the typing too); `closeHistory`
removed (same, in the editor); the editor chip's role and name removed; and in the
e2e spec the click handler, the edit, `BlockTree`'s status and page mode's status.

**Left:** the editor chip's broken style is set at render, so a target that moves
away while the editor is open shows struck through only after a re-render (the
click re-checks); page mode on touch has no undo button.
