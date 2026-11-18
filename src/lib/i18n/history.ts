/**
 * i18n namespace: history / trash / undo / redo / diff / compaction.
 *
 * Flat dotted keys merged into the `en.translation` resource by
 * `src/lib/i18n/index.ts`. Do not import this file directly from app
 * code; use `t('namespace.key')` via the index.
 */

export const history: Record<string, string> = {
  // Translators: Block History sheet (the side panel a block's context menu opens): its heading and
  // the line under it. "Mutation history" = the record of every change made to the block.
  'history.title': 'Block History',
  'history.description': 'View and revert the mutation history for this block.',

  // Translators: Names of the kinds of change ("operation types") in the History view and the Block
  // History sheet: the chip on each entry, the items of the type filter dropdown, the terms of the
  // "What do these mean?" legend, and inserted as {{opType}} in history.selectOperationLabel. Keep
  // them short. "Restore" = brought back from the Trash; "Purge" = deleted for good; "alias" =
  // another name for a page; "Property definition" = the type a space declares for a property.
  'history.opTypeEdit': 'Edit',
  'history.opTypeCreate': 'Create',
  'history.opTypeDelete': 'Delete',
  'history.opTypeMove': 'Move',
  'history.opTypeAddTag': 'Add tag',
  'history.opTypeRemoveTag': 'Remove tag',
  'history.opTypeAddPageAlias': 'Add alias',
  'history.opTypeRemovePageAlias': 'Remove alias',
  'history.opTypeSetProperty': 'Set property',
  'history.opTypeDeleteProperty': 'Delete property',
  'history.opTypeSetPropertyDef': 'Property definition',
  'history.opTypeRenamePropertyKey': 'Property renamed',
  'history.opTypeRenamePropertyOption': 'Property option renamed',
  'history.opTypeRewriteProperties': 'Properties rewritten',
  'history.opTypeAddAttachment': 'Add attachment',
  'history.opTypeRemoveAttachment': 'Remove attachment',
  'history.opTypeRenameAttachment': 'Rename attachment',
  'history.opTypeRestore': 'Restore',
  'history.opTypePurge': 'Purge',

  // Translators: "What do these mean?" legend popover of the history filter bar: the one-line
  // explanation shown beside each change type above. "Space" = a separate workspace of notes;
  // "soft-deleted" = moved to the Trash, still recoverable.
  'history.opTypeDescription.editBlock': 'Block content was edited',
  'history.opTypeDescription.createBlock': 'A new block was created',
  'history.opTypeDescription.deleteBlock': 'A block was soft-deleted (recoverable from Trash)',
  'history.opTypeDescription.moveBlock': 'A block was moved or reordered',
  'history.opTypeDescription.addTag': 'A tag was added to a block',
  'history.opTypeDescription.removeTag': 'A tag was removed from a block',
  'history.opTypeDescription.addPageAlias': 'An alias was added to a page',
  'history.opTypeDescription.removePageAlias': 'An alias was removed from a page',
  'history.opTypeDescription.setProperty': 'A property was set on a block',
  'history.opTypeDescription.deleteProperty': 'A property was removed from a block',
  'history.opTypeDescription.setPropertyDef':
    "A space's property definition was created, changed or deleted",
  'history.opTypeDescription.renamePropertyKey':
    "A space's property was renamed, on every block that held it",
  'history.opTypeDescription.renamePropertyOption':
    "An option of a space's select property was renamed, on every block that held it",
  'history.opTypeDescription.rewriteProperties':
    "One of a space's properties was merged into another, changed type, or had the values that don't fit it removed, converted or moved",
  'history.opTypeDescription.addAttachment': 'An attachment was added to a block',
  'history.opTypeDescription.deleteAttachment': 'An attachment was removed from a block',
  'history.opTypeDescription.renameAttachment': 'An attachment was renamed',
  'history.opTypeDescription.restoreBlock': 'A soft-deleted block was restored',
  'history.opTypeDescription.purgeBlock': 'A block was permanently deleted',

  // Translators: The "?" help button of the history filter bar and the popover it opens:
  // screen-reader label of the button, the popover's heading, and its screen-reader label. "Op" =
  // operation, one kind of change.
  'history.opTypeLegendLabel': 'Op type legend',
  'history.opTypeLegendTitle': 'What do these mean?',
  'history.opTypeLegendPopoverLabel': 'Operation type legend',

  // Translators: Empty-state messages of the Block History sheet.
  'history.selectBlockEmpty': 'Select a block to see history',
  'history.noHistoryEmpty': 'No history for this block',

  // Translators: Confirmation for putting a block's text back to an older version: dialog title and
  // its confirm button (verb).
  'history.restoreConfirmTitle': 'Restore to this version?',
  'history.restoreConfirmAction': 'Restore',

  // Translators: Text comparison ("diff") shown under an expanded history entry (History view,
  // Block History sheet): what changed between two versions of a block. A "change" here is one run
  // of edited text. noChanges: shown when nothing differs. showMore / collapse: button that reveals
  // the hidden rest of a long diff and folds it again; {{count}} = hidden changed runs.
  // hunkCounter: position read out to screen readers; {{current}} = the highlighted change,
  // {{total}} = all changes. Next / Previous: buttons that jump between changes. regionLabel:
  // screen-reader name of the diff area.
  'diff.noChanges': 'No changes',
  'diff.showMore_one': 'Show full diff (1 hidden)',
  'diff.showMore_other': 'Show full diff ({{count}} hidden)',
  'diff.collapse': 'Collapse diff',
  'diff.hunkCounter': '{{current}} of {{total}} changes',
  'diff.nextHunk': 'Next change',
  'diff.prevHunk': 'Previous change',
  'diff.regionLabel': 'Diff content',

  // Translators: History filter bar (History view and Block History sheet): label before the
  // change-type dropdown, and the dropdown's first item, which shows every type.
  'history.filterLabel': 'Filter:',
  'history.allTypesOption': 'All types',
  // Translators: Chip on a selected history entry; lowercase, very short.
  'history.selectedBadge': 'selected',

  // Translators: Toolbar shown in the History view while entries are ticked: the revert button and
  // its text while working ("Revert" = undo the selected changes), a button that unticks
  // everything, and a hint where Space and Enter are keyboard keys. "Clear selection" is also the
  // screen-reader label of the ✕ button in the toolbar for blocks selected in a page.
  'history.revertingButton': 'Reverting...',
  'history.revertSelectedButton': 'Revert selected',
  'history.clearSelectionButton': 'Clear selection',
  'history.keyboardHint': 'Space to toggle, Enter to revert',

  // Translators: Button in the History view's load-error banner: try loading again.
  'history.retryButton': 'Retry',

  // Translators: One entry of the History view list. Screen-reader label of its checkbox:
  // {{opType}} = a change type such as "Edit", {{seq}} = the change's sequence number. Then the
  // button that opens the text comparison ("Diff", short), and the tooltip on a purged entry
  // ("Purges" = permanent deletions), which cannot be reverted.
  'history.selectOperationLabel': 'Select operation {{opType}} #{{seq}}',
  'history.diffButton': 'Diff',
  'history.nonReversibleTooltip': 'Purges cannot be undone',

  // Translators: History view: empty-state messages (for the whole space, or for one page); the
  // header line when a page's menu opened the view on that page alone ({{title}} = the page title),
  // and the button beside it that goes back to the changes of every page. "Space" = a separate
  // workspace of notes.
  'history.emptyCurrentSpace': 'No changes in this space yet.',
  'history.emptyPage': 'No changes to this page yet.',
  'history.pageScope': 'Changes to {{title}}',
  'history.showAllPages': 'Show all pages',

  // Translators: Trash view (deleted blocks, opened from the Pages header): its empty state, and
  // the text shown for a deleted block that had no text, also inserted as {{content}} in
  // trash.selectItemLabel.
  'trash.emptyMessage': 'Nothing in trash. Deleted items will appear here.',
  'trash.emptyContent': '(empty)',

  // Translators: Buttons on each Trash row, with their tooltips: "Restore" puts the block back
  // where it was (also the confirm button of the restore dialogs); "Purge" deletes it for good.
  'trash.restoreTooltip': 'Restore this block from trash',
  'trash.restoreButton': 'Restore',
  'trash.purgeButton': 'Purge',
  'trash.purgeTooltip': 'Permanently delete (cannot be undone)',

  // Translators: Confirmation dialog after a row's Purge button. "No" and "Yes, delete" are the
  // cancel and confirm buttons, shared by every Trash confirmation dialog.
  'trash.permanentlyDeleteTitle': 'Permanently delete?',
  'trash.permanentlyDeleteDescription':
    'This action cannot be undone. This block will be permanently deleted.',
  'trash.noButton': 'No',
  'trash.yesDeleteButton': 'Yes, delete',

  // Translators: Trash selection toolbar (shown while rows are ticked): tick every row, untick
  // every row.
  'trash.selectAllButton': 'Select all',
  'trash.deselectAllButton': 'Deselect all',

  // Translators: Trash buttons that act on every item in the trash at once ("Purge" = delete for
  // good).
  'trash.restoreAllButton': 'Restore all',
  'trash.purgeAllButton': 'Purge all',

  // Translators: Trash selection toolbar: restore or purge the ticked rows ("Purge" = delete for
  // good). Tooltip of the restore button: {{threshold}} = a number of items (5); restoring more
  // than that asks for confirmation first.
  'trash.restoreSelectedButton': 'Restore selected',
  'trash.restoreThresholdTooltip': 'Confirms restore for more than {{threshold}} items',
  'trash.purgeSelectedButton': 'Purge selected',

  // Translators: Buttons in the Trash view's header: delete everything in the trash for good, and
  // put every item back where it was.
  'trash.emptyTrashButton': 'Empty trash',
  'trash.restoreAllHeaderButton': 'Restore all',

  // Translators: "Empty trash" confirmation dialog: title and body. {{count}} = items. The
  // "Paginated" body is used when only part of the trash is listed yet ("loaded" = listed on screen
  // so far); it still deletes everything.
  'trash.emptyTrashTitle': 'Empty trash?',
  'trash.emptyTrashDescription_one': 'Permanently delete {{count}} item? This cannot be undone.',
  'trash.emptyTrashDescription_other': 'Permanently delete {{count}} items? This cannot be undone.',
  'trash.emptyTrashDescriptionPaginated_one':
    'Permanently delete every trashed item ({{count}} loaded, more available)? This cannot be undone.',
  'trash.emptyTrashDescriptionPaginated_other':
    'Permanently delete every trashed item ({{count}} loaded, more available)? This cannot be undone.',

  // Translators: "Restore all" confirmation dialog: title and body.
  'trash.restoreAllTitle': 'Restore all items?',
  'trash.restoreAllDescription':
    'This will restore all items from the trash to their original locations.',

  // Translators: Brief pop-up messages (toasts) after "Restore all" and "Empty trash". {{count}} =
  // items. The "Partial" messages: an error stopped the action after {{count}} items were already
  // done.
  'trash.allRestored_one': '{{count}} item restored',
  'trash.allRestored_other': '{{count}} items restored',
  'trash.allPurged_one': 'Trash emptied ({{count}} item permanently deleted)',
  'trash.allPurged_other': 'Trash emptied ({{count}} items permanently deleted)',
  'trash.emptyTrashFailed': 'Failed to empty trash',
  // #3835 — surfaces PARTIAL progress from `PartialPurgeError`: earlier
  // chunks already committed before a later chunk failed, so this is
  // deliberately distinct copy from `emptyTrashFailed` (which implies
  // nothing happened).
  'trash.emptyTrashPartial_one':
    'Removed {{count}} item before an error interrupted emptying trash',
  'trash.emptyTrashPartial_other':
    'Removed {{count}} items before an error interrupted emptying trash',
  'trash.restoreAllFailed': 'Failed to restore all items',
  // Same chunked-commit shape as `emptyTrashPartial`: rows really came back
  // before the failing chunk, so `restoreAllFailed` would understate it.
  'trash.restoreAllPartial_one':
    'Restored {{count}} item before an error interrupted restoring all',
  'trash.restoreAllPartial_other':
    'Restored {{count}} items before an error interrupted restoring all',

  // Translators: Screen-reader labels in the Trash view: a row's checkbox ({{content}} = the
  // deleted block's text) and the whole list.
  'trash.selectItemLabel': 'Select {{content}}',
  'trash.listLabel': 'Trash items',

  // Translators: Line under each Trash row naming the page the block was deleted from: {{page}} =
  // the page title, or trash.deletedPage when that page is deleted too (inserted as {{page}}, so
  // lowercase in parentheses).
  'trash.fromPage': 'from: {{page}}',
  'trash.deletedPage': '(deleted page)',

  // Translators: Toasts after restoring or purging the ticked Trash rows ("purged" = deleted for
  // good). {{count}} = blocks. batchPurgeStale: the list was outdated, so nothing was purged and
  // the list was reloaded.
  'trash.batchRestored_one': '{{count}} block restored',
  'trash.batchRestored_other': '{{count}} blocks restored',
  'trash.batchPurged_one': '{{count}} block permanently deleted',
  'trash.batchPurged_other': '{{count}} blocks permanently deleted',
  'trash.batchRestoreFailed': 'Failed to restore selected blocks',
  'trash.batchPurgeFailed': 'Failed to purge selected blocks',
  // #3835 — `purge_blocks_by_ids` rejected the batch because the trash
  // listing this selection came from is stale (a restore landed elsewhere
  // between the listing render and this purge). Distinct from the generic
  // `batchPurgeFailed` above: a retry with the same selection fails
  // identically until the listing is refreshed, which this path now does.
  'trash.batchPurgeStale': 'The trash listing was out of date and has been refreshed',

  // Translators: Confirmation dialog for purging the ticked Trash rows: body and title; {{count}} =
  // blocks.
  'trash.batchPurgeDescription_one':
    'This action cannot be undone. {{count}} block will be permanently deleted.',
  'trash.batchPurgeDescription_other':
    'This action cannot be undone. {{count}} blocks will be permanently deleted.',
  'trash.batchPurgeTitle_one': 'Permanently delete {{count}} item?',
  'trash.batchPurgeTitle_other': 'Permanently delete {{count}} items?',

  // Translators: Confirmation dialog for restoring many ticked Trash rows: body and title;
  // {{count}} = blocks. "Descendants" = the child blocks nested under a block.
  'trash.batchRestoreConfirmDescription_one':
    '{{count}} block (and any descendants soft-deleted with it) will be restored to its original location.',
  'trash.batchRestoreConfirmDescription_other':
    '{{count}} blocks (and any descendants soft-deleted with them) will be restored to their original locations.',
  'trash.batchRestoreConfirmTitle_one': 'Restore {{count}} item?',
  'trash.batchRestoreConfirmTitle_other': 'Restore {{count}} items?',

  // Translators: Screen-reader name of the whole Trash view.
  'trash.regionLabel': 'Trash',

  // Translators: Trash filter box: placeholder (also its screen-reader label; "root content" = the
  // text of the top deleted block of each row), the count shown while filtering ({{filtered}} =
  // matching items, {{total}} = all listed items), the empty states when nothing matches ({{count}}
  // = items listed so far, more not loaded yet), and a button that empties the filter box.
  'trash.filterPlaceholder': 'Filter deleted items (root content)...',
  'trash.showingCount': 'Showing {{filtered}} of {{total}} deleted items',
  'trash.noMatchMessage': 'No matching deleted items',
  // The filter runs in memory over the loaded pages only, so with more pages
  // behind "Load more" a no-match can just mean "not on this page" (#4965).
  'trash.noMatchLoadedMessage_one': 'No matching deleted items ({{count}} loaded, more available)',
  'trash.noMatchLoadedMessage_other':
    'No matching deleted items ({{count}} loaded, more available)',
  'trash.clearFilter': 'Clear filter',

  // Translators: Chip on a Trash row: the number of child blocks deleted together with it
  // ({{count}}). Very short.
  'trash.itemsInBatch_one': '+{{count}} block',
  'trash.itemsInBatch_other': '+{{count}} blocks',

  // Translators: Brief pop-up messages (toasts) after undo (Ctrl+Z) or redo (Ctrl+Y) of page
  // changes, outside text editing. journalNoDayMessage: shown in the Journal before any day's block
  // was edited. batchUnavailable: an undo of several changes at once failed.
  // #6541 — the journal's Ctrl+Z / Ctrl+Y act on the day last worked in; this
  // says so when no day was worked in yet.
  'undo.journalNoDayMessage': "Click a day's block first — undo works on the day you last edited",
  'undo.undoneMessage': 'Undone',
  'undo.undoFailedMessage': 'Undo failed',
  'undo.redoneMessage': 'Redone',
  'undo.redoFailedMessage': 'Redo failed',
  // #2190 — the grouped undo is a single atomic IPC; when it fails, NOTHING
  // was undone (the pre-2190 string claimed a single-op fallback that no
  // longer exists).
  'undo.batchUnavailable': 'Undo failed; nothing was undone.',

  // Translators: Toast after an undo, naming the kind of change that was undone ("Undid" = undo was
  // applied to). Shown briefly; keep it short. "Alias" = another name for a page.
  'undo.op.createBlock': 'Undid create block',
  'undo.op.editBlock': 'Undid edit',
  'undo.op.deleteBlock': 'Undid delete',
  'undo.op.restoreBlock': 'Undid restore',
  'undo.op.moveBlock': 'Undid move',
  'undo.op.setProperty': 'Undid property change',
  'undo.op.deleteProperty': 'Undid property change',
  'undo.op.addTag': 'Undid tag',
  'undo.op.removeTag': 'Undid tag',
  'undo.op.addAttachment': 'Undid attachment',
  'undo.op.deleteAttachment': 'Undid attachment',
  // #4277 — reached via `undo.op.${snakeToCamel(reversed_op_type)}` in
  // `useUndoShortcuts.performPageUndo`; without it the rename fell back to
  // the generic "Undone".
  'undo.op.renameAttachment': 'Undid attachment rename',
  'undo.op.addPageAlias': 'Undid alias',
  'undo.op.removePageAlias': 'Undid alias',

  // Translators: Toast after a redo, naming the kind of change that was redone ("Redid" = redo was
  // applied to). Shown briefly; keep it short. "Alias" = another name for a page.
  'redo.op.createBlock': 'Redid create block',
  'redo.op.editBlock': 'Redid edit',
  'redo.op.deleteBlock': 'Redid delete',
  'redo.op.restoreBlock': 'Redid restore',
  'redo.op.moveBlock': 'Redid move',
  'redo.op.setProperty': 'Redid property change',
  'redo.op.deleteProperty': 'Redid property change',
  'redo.op.addTag': 'Redid tag',
  'redo.op.removeTag': 'Redid tag',
  'redo.op.addAttachment': 'Redid attachment',
  'redo.op.deleteAttachment': 'Redid attachment',
  'redo.op.renameAttachment': 'Redid attachment rename',
  'redo.op.addPageAlias': 'Redid alias',
  'redo.op.removePageAlias': 'Redid alias',

  // Translators: History view load-error banner: two detail lines (one per cause) under the heading
  // "Failed to load history", which is also a toast. "Local backend" = the app's own data engine on
  // this device.
  'history.errorServer':
    'The local backend returned an error while fetching history. Retry, or restart the app if it persists.',
  'history.errorUnknown':
    'Something unexpected went wrong while loading history. Retry, and check the logs if the problem persists.',
  'history.loadFailed': 'Failed to load history',

  // Translators: Toast when reverting the ticked History entries fails.
  'history.revertFailed': 'Failed to revert operations',
  // Translators: Toasts after pressing Undo on the "Reverted successfully" toast of the Block
  // History sheet: the restore could not be undone, or was undone.
  'history.restoreUndoFailed': 'Could not undo the restore',
  'history.restoreUndone': 'Restore undone',

  // Translators: Button on each History view entry that undoes every change made after it:
  // screen-reader label, tooltip ("Revert" = the Revert selected action), and the short text shown
  // beside its icon on touch screens.
  'history.restoreToHereLabel': 'Reset to this point',
  'history.restoreToHereTooltip':
    'Undoes every operation after this point — use the per-entry Revert action for individual entries.',
  'history.restoreToHereTouchLabel': 'Reset',

  // Translators: Confirmation dialog of "Reset to this point": title and body; {{timestamp}} = the
  // entry's date and time, e.g. "Jun 17, 2026, 2:05 PM". "Purge" = a permanent deletion.
  'history.restoreToTitle': 'Restore to {{timestamp}}?',
  'history.restoreToDescription':
    'All operations after this point will be reverted. Non-reversible operations (purge) will be skipped. This action itself can be undone, and the original operations remain in history.',

  // Translators: Toasts after "Reset to this point": {{count}} = changes reverted, or changes that
  // cannot be reverted and were skipped; then the failure message.
  'history.restoreSuccess_one': '{{count}} operation reverted successfully',
  'history.restoreSuccess_other': '{{count}} operations reverted successfully',
  'history.restoreSkipped_one': '{{count}} non-reversible operation was skipped',
  'history.restoreSkipped_other': '{{count}} non-reversible operations were skipped',
  'history.restoreFailed': 'Failed to restore — please try again',

  // Translators: Buttons of the History view's confirmation dialogs: cancel (shared), and the
  // confirm button of "Reset to this point" (verb).
  'history.cancelButton': 'Cancel',
  'history.restoreButton': 'Restore',

  // Translators: Confirmation dialog for reverting the ticked History entries: title, body and
  // confirm button (verb); {{count}} = ticked changes.
  'history.revertTitle_one': 'Revert {{count}} operation?',
  'history.revertTitle_other': 'Revert {{count}} operations?',
  'history.revertDescription_one':
    'This will create {{count}} new operation that reverses the selected changes. The original operations remain in history.',
  'history.revertDescription_other':
    'This will create {{count}} new operations that reverse the selected changes. The original operations remain in history.',
  'history.revertButton': 'Revert',

  // Translators: Toasts after "Restore this version" in the Block History sheet: success, failure,
  // and an entry whose text cannot be restored.
  'history.revertedSuccessfully': 'Reverted successfully',
  'history.revertPanelFailed': 'Failed to revert',
  'history.notRestorable': "This entry can't be restored",

  // Translators: Marks on a history entry. foreignOp: tooltip and screen-reader text of the icon on
  // a change synced from another device ("audit-only" = kept as a record only). agentOp:
  // screen-reader text of the chip on a change written by an AI agent (an assistant app given Agent
  // access); {{name}} = the agent's name.
  // #2481 — foreign op badge (audit-only, not revertible here). Shared by
  // the sr-only accessible name and the visible tooltip content.
  'history.foreignOp': 'Synced from another device (audit-only; not revertible here)',
  'history.agentOp': 'Written by agent {{name}}',

  // Translators: Error when the text comparison of an entry fails to load (a toast, or inline in
  // the Block History sheet).
  'history.loadDiffFailed': 'Failed to load diff',

  // Translators: Block History sheet, expanded entry: a two-option switch choosing what the
  // comparison shows ("Just this change" = this edit alone; "Compared to current" = this version
  // against the block's current text) and its screen-reader label; the button that puts the block
  // back to this version ({{timestamp}} = how long ago, e.g. "5 minutes ago"); and the
  // screen-reader name of the preview of that version's text.
  // Part B — segmented control + primary button in the per-block
  // history panel's expanded preview state.
  'history.diffMode.justThisChange': 'Just this change',
  'history.diffMode.comparedToCurrent': 'Compared to current',
  'history.diffMode.label': 'Diff mode',
  'history.restoreThisVersion': 'Restore this version ({{timestamp}})',
  'history.previewLabel': 'Preview of historical content',

  // Translators: Screen-reader label of the change-type dropdown of the history filter bar.
  'history.filterByTypeLabel': 'Filter by operation type',
  // Translators: Screen-reader name of the list of history entries.
  'history.entriesLabel': 'History entries',
  // Translators: Short visible label beside a lock icon on an entry that cannot be undone.
  'history.nonReversibleLabel': 'Non-reversible action',
  // Translators: The ✕ button beside the change-type dropdown: screen-reader label (this one) and
  // tooltip (filterBar.clear). filterBar.legend: tooltip of the "?" button ("op" = change).
  'history.clearFilter': 'Clear filter',
  'history.filterBar.legend': 'Show op type legend',
  'history.filterBar.clear': 'Clear active filter',

  // Translators: Floating toolbar shown on touch screens only in the History view: its
  // screen-reader label, then the buttons (label and tooltip) that move the highlight to the
  // previous or next entry.
  'history.touchNavLabel': 'List navigation',
  'history.touchNavPrev': 'Previous entry',
  'history.touchNavNext': 'Next entry',

  // Translators: Screen-reader label of the ✕ button that empties the Trash filter box.
  'trash.searchClear': 'Clear filter',

  // Translators: Hint in the Trash selection toolbar; "Shift+click" = hold the Shift key and click.
  'trash.batchHint': 'Tip: Shift+click to select a range',

  // Translators: Toasts after a Trash row's Restore or Purge button ("purge" = delete for good);
  // loadFailed is also shown in place of the list when it cannot load.
  'trash.blockRestored': 'Block restored',
  'trash.restoreFailed': 'Failed to restore block',
  'trash.blockPurged': 'Block permanently deleted',
  'trash.purgeFailed': 'Failed to purge block',
  'trash.loadFailed': 'Failed to load trash',

  // Translators: Screen-reader announcement after "Load more" in a history list; {{count}} =
  // entries just added.
  'history.loadedMoreEntries_one': 'Loaded {{count}} more entry',
  'history.loadedMoreEntries_other': 'Loaded {{count}} more entries',

  // Translators: Header of a collapsible card at the top of the History view (whole-space history):
  // it deletes old change records for good to save space.
  'compaction.title': 'Remove old history',

  // Translators: Rows of that card. Only the text before the ":" is shown, as the row label; the
  // number or date appears separately, so keep exactly one colon and put the label before it.
  // {{count}} and {{date}} are never displayed. "Eligible for cleanup" = old enough to be removed.
  // #3882 — `compaction.totalOps`/`compaction.eligibleOps` interpolate
  // {{count}} but CompactionCard.tsx only ever consumes the label text
  // before the ":" (`.split(':')[0]`) — the actual number is rendered
  // separately in a <dd>. The interpolated value never reaches the screen,
  // and "operations"/"cleanup" here are fixed category labels (like "Total
  // operations:", not "N operations agree/disagrees"), not count-agreeing
  // nouns, so no plural forms are needed. See PRE_EXISTING_COUNT_EXEMPT in
  // catalog-parity.test.ts.
  'compaction.totalOps': 'Total operations: {{count}}',
  'compaction.oldestOp': 'Oldest operation: {{date}}',
  'compaction.oldestOpNone': 'Oldest operation: N/A',
  'compaction.eligibleOps': 'Eligible for cleanup: {{count}}',

  // Translators: Destructive button on that card; "Compact" = delete the old change records.
  'compaction.compactNow': 'Compact Now',

  // Translators: Confirmation dialog of "Compact Now": title, body, confirm and cancel buttons. "Op
  // Log" = the record of every change; {{count}} = changes to delete, {{days}} = the age limit in
  // days.
  'compaction.confirmTitle': 'Compact Op Log?',
  'compaction.confirmDescription_one':
    'This will permanently delete {{count}} operation older than {{days}} days. The original data in this operation will be lost. This cannot be undone.',
  'compaction.confirmDescription_other':
    'This will permanently delete {{count}} operations older than {{days}} days. The original data in these operations will be lost. This cannot be undone.',
  'compaction.compactButton': 'Compact',
  'compaction.cancel': 'Cancel',

  // Translators: Toasts of that card: {{count}} = change records deleted; the compaction failed;
  // its status could not be loaded.
  'compaction.success_one': 'Compacted {{count}} operation',
  'compaction.success_other': 'Compacted {{count}} operations',
  'compaction.failed': 'Failed to compact op log',
  'compaction.loadFailed': 'Failed to load compaction status',

  // Translators: Label before the time of deletion on a Trash row, e.g. "Deleted: 3 days ago".
  'trash.deletedPrefix': 'Deleted:',

  // Translators: Body of the confirmation for putting a block's text back to an older version;
  // {{timestamp}} = the version's date and time.
  'history.restoreConfirmDescription':
    'This will replace the current block content with the version from {{timestamp}}. You can undo this change.',

  // Translators: Shown in place of the text comparison when the two versions are identical.
  'history.diff.empty': 'No changes',

  // Translators: Shown in place of the History view's "Remove old history" card when it fails.
  'compactionCard.errorBoundary': 'Compaction status unavailable.',
}
