# Session 3926 — Undo works in the journal, and Discard goes

Ships two of #6541's three checkboxes on top of #6578 (a reload keeps the open
editor), #6594 and #6596 (Ctrl+Z in a block chains into the page's undo).

**Journal undo.** Outside a block, `useUndoShortcuts` now resolves its page
through `historyPageId()`: the page editor's top-of-stack page, or in the
journal the page of the last-interacted tree (`lastInteractedTree()`, new in
`src/lib/last-interacted-tree.ts`, matched against the mounted stores with
`forEachLivePageStoreGroup`). Inside a block, `useBlockPageHistory` simply
lost its page-editor gate: the tree's `rootParentId` is already the day's
page. The rule, stated in the specs: a press acts on the day last worked in
and never crosses to another day; with no day worked in yet, the toast stays,
reworded ("Click a day's block first…"), since the old "isn't available in
Journal view" was no longer true. The swipe-delete fallback
(`performActivePageUndo`) uses the same resolver. The shortcut catalog's
undo/redo condition went back to `outsideEditor`, and the
`outsideEditorInPage` string went with it.

**Discard.** The block editor's toolbar button, `DISCARD_BLOCK_EDIT`,
`handleDiscard`, the "Changes discarded" string and page mode's
`hiddenItems` (which existed only to hide it) are gone. *Edit as Markdown*
kept its Cancel: `PageSourceToolbar` now adds that button itself (`CANCEL`),
since its items are derived from the block toolbar's groups and the parity
test forbids naming a button the block editor lacks.

**Left out: keeping the stacks across a reload.** Passing `{ reanchorUndo:
false }` on `sync:complete` and `blocks:changed` was built and reverted. An MCP
write arrives on `blocks:changed` and is a positional-undo target (`origin LIKE
'agent:%'` in `history.rs`), so with the stacks kept Ctrl+Z skipped a ref-less
entry or undid an undone edit again; it also broke `src/stores/AGENTS.md`'s
rule for `{ reanchorUndo: false }`. Both reload paths re-anchor as on `main`,
and `reload-keeps-editor.spec.ts` pins the MCP case (an agent write, then
Ctrl+Z undoes the agent's op and then the user's newest). That checkbox stays
open.

**Review notes, not acted on.** Journal page mode (one editor per day) never
reaches page undo from inside the editor. "Worked in" means last focused, not
last edited. Redo over newer text is no longer reachable, since a reload drops
the stacks again.

**Checks run.** Targeted vitest over every touched test file plus i18n,
keyboard-config, BlockTree and PageSourceEditor; `npm run typecheck`;
Playwright `journal-undo`, `toolbar-controls`, `block-undo-chains-page-undo`,
`undo-redo-blocks` and the new `reload-keeps-editor` MCP-undo describe, which
went red with `blocks:changed` passing `{ reanchorUndo: false }`. The journal
specs were red before the fix; each vitest change was falsified by a mutation.
