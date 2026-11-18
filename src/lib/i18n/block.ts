/**
 * i18n namespace: block
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const block: Record<string, string> = {
  // Translators: Spoken names of the task states, read by the screen reader after a task changes
  // state (inserted as {{state}} in announce.taskState, "Task state: {{state}}"). The keywords
  // TODO, DOING, DONE and CANCELLED written in notes stay in English; these are their meanings.
  // #4555 — task-state display labels for screen-reader announcements
  // (`announce.taskState` in common.ts). The stored/serialized state
  // TOKENS (`TodoState` in task-states.ts: 'TODO'/'DOING'/'DONE'/
  // 'CANCELLED') are never translated — only these display labels are.
  'block.taskState.todo': 'To do',
  'block.taskState.doing': 'In progress',
  'block.taskState.done': 'Done',
  'block.taskState.cancelled': 'Cancelled',

  // Translators: Read aloud (the text-to-speech feature): words it speaks in place of things it
  // cannot read, mid-sentence, so lower case. "missing page/tag/block" = a link whose target no
  // longer exists; "embedded block" = a block shown inside another; "query" = a live result list.
  // #5745 — what Read aloud says in place of what it cannot read (`spoken-text.ts`).
  'readAloud.missingPage': 'missing page',
  'readAloud.missingTag': 'missing tag',
  'readAloud.missingBlock': 'missing block',
  'readAloud.codeBlock': 'code block',
  'readAloud.formula': 'formula',
  'readAloud.diagram': 'diagram',
  'readAloud.embed': 'embedded block',
  'readAloud.query': 'query',

  // Translators: Read aloud (text-to-speech): items in a block's right-click menu (whole block,
  // the selected blocks, the selected text), then toasts (brief pop-up messages): "Reading
  // aloud…" with a Stop button while speaking, and the messages when it cannot read.
  // #5745 — Read aloud's controls and what it tells you (`read-aloud.ts`, `useReadAloud.ts`).
  'readAloud.read': 'Read aloud',
  'readAloud.readSelected': 'Read selected blocks aloud',
  'readAloud.readSelection': 'Read selection aloud',
  'readAloud.reading': 'Reading aloud…',
  'readAloud.stop': 'Stop',
  'readAloud.nothingToRead': 'There is nothing here to read aloud',
  'readAloud.noPage': 'Open a page to read it aloud',
  'readAloud.noVoice':
    'No voice is available to read aloud. Add one in your system’s speech or text-to-speech settings.',
  'readAloud.failed': 'Reading aloud stopped: the speech engine reported an error',

  // Translators: Drag handle to the left of each block: screen-reader label and tooltip (keep the
  // shortcut "Ctrl+Shift+↑/↓" as written).
  'block.reorder': 'Reorder block (drag or use keyboard)',
  'block.reorderTip': 'Reorder — Ctrl+Shift+↑/↓',
  // Translators: Not displayed: a key-name value that browsers read for screen readers. Keep it
  // exactly as is, in English.
  'block.reorderKeyshortcuts': 'Control+Shift+ArrowUp Control+Shift+ArrowDown',
  // Translators: Screen-reader description of a block on phones.
  'block.swipeRowDescription': 'Swipe left to delete this block',

  // Translators: Block controls: the selection checkbox shown on hover (label and tooltip; Ctrl and
  // Shift are keys), the delete button revealed by swiping a block left on phones, and the arrow
  // that hides or shows a block's child blocks (label and tooltip; keep "Ctrl+." as written).
  // "Block history" = the list of earlier versions of a block.
  // B1 (#217): hover-revealed multi-select checkbox affordance.
  'block.selectBlock': 'Select block',
  'block.selectTip': 'Select — Ctrl+Click to multi-select, Shift+Click for range',
  'block.delete': 'Delete block',
  'block.history': 'Block history',
  'block.collapseChildren': 'Collapse children',
  'block.expandChildren': 'Expand children',
  'block.collapseTip': 'Collapse (Ctrl+.)',
  'block.expandTip': 'Expand (Ctrl+.)',

  // Translators: Not displayed: a key-name value that browsers read for screen readers. Keep it
  // exactly as is, in English.
  // D4 (#217): aria-keyshortcuts token form of the `collapseExpand` catalog
  // binding (Ctrl + .) so assistive tech announces the shortcut — tooltips
  // never fire on touch and the visible "(Ctrl+.)" tip is sighted-only. The
  // key token is the UI-Events `key` value ("."), matching `toAriaKeyshortcuts`
  // (modifier → "Control", non-modifier whitespace stripped, no code-name map).
  'block.collapseKeyshortcuts': 'Control+.',

  // Translators: Phones: swiping a block right moves it one level deeper (indent), a short swipe
  // left moves it one level out (outdent). "Block indented/outdented" are screen-reader
  // announcements; "Indent"/"Outdent" are short labels shown behind the block during the swipe.
  // #927 f4: swipe-to-indent / swipe-to-outdent gestures on touch. Surfaced as
  // aria descriptions so assistive tech announces the available gestures.
  'block.swipe.indented': 'Block indented',
  'block.swipe.outdented': 'Block outdented',
  // #1748/#1732: labels for the non-destructive structural-swipe backdrops, so
  // the indent (right) and outdent (short-left) gestures get a cue that matches
  // their action instead of the destructive delete backdrop (or no cue at all).
  'block.swipe.indentHint': 'Indent',
  'block.swipe.outdentHint': 'Outdent',

  // Translators: Task checkbox at the start of a task block and the priority badge next to it:
  // screen-reader labels and tooltips. {{state}} = the task keyword (TODO, DOING, DONE,
  // CANCELLED, kept in English); {{level}} = "P1", "P2" or "P3"; "cycle" = step to the next one.
  'block.taskCycle': 'Task: {{state}}. Click to cycle.',
  'block.todoCycleTip': '{{state}} (Ctrl+Enter to cycle)',
  'block.priorityCycle': 'Priority {{level}}. Click to cycle.',
  'block.priorityTip': 'Priority {{level}} (click to cycle)',

  // Translators: Chips on a block: tooltip and screen-reader label of the due-date (deadline) and
  // scheduled-date (planned start) chips, {{date}} = a short date like "Jun 17"; screen-reader
  // label of the repeat chip, {{value}} = a repeat rule from the repeat.* strings, e.g. "weekly".
  'block.dueDate': 'Due {{date}}',
  'block.scheduledDate': 'Scheduled {{date}}',
  'block.repeats': 'Repeats {{value}}',

  // Translators: Zooming into a block shows only it and its children, under a breadcrumb trail
  // (BlockZoomBar): screen-reader names of the trail and of its Home button, which exits the zoom.
  // "Untitled" = name shown for a page or block with no text.
  'block.breadcrumb': 'Block breadcrumb',
  'block.zoomToRoot': 'Go to root',
  'block.untitled': 'Untitled',
  'blockZoom.breadcrumbs': 'Zoom breadcrumbs',
  'blockZoom.exitZoom': 'Exit zoom',

  // Translators: Page picker for a property whose value is a page (in the block's property
  // editors): search placeholder, "nothing found" line, and screen-reader name of the picker.
  'block.searchPages': 'Search pages...',
  'block.noPagesFound': 'No pages found',
  'block.refPickerLabel': 'Select a page',

  // Translators: Screen-reader name of the small pop-up for editing one property value of a block.
  'block.editProperty': 'Edit property',

  // Translators: Phone-only button on a task row in the Agenda; opens a menu to move its date.
  'block.reschedule': 'Reschedule',

  // Translators: Block references (links to a single block): screen-reader name of their picker,
  // and the text shown when the target is missing; {{id}} = the start of the block's ID. Keep the
  // "((" "))" brackets.
  'blockRef.pickerLabel': 'Block references',
  'blockRef.fallback': '(( {{id}}... ))',

  // Translators: Toast (brief pop-up message) after pasting several blocks; {{count}} = blocks.
  // "Paste as text" is its button that undoes the paste and puts the text into one block instead.
  // The last string is a toast when that undo is no longer possible.
  'block.pastedBlocks_one': 'Pasted {{count}} block',
  'block.pastedBlocks_other': 'Pasted {{count}} blocks',
  'block.pasteAsText': 'Paste as text',
  'block.pasteUndoStale': 'The page changed after the paste, so it can no longer be undone here',

  // Translators: Paperclip chip on a block that has attached files: screen-reader label and
  // tooltip; the click shows or hides the list of files. {{count}} = number of files.
  'block.attachments_one': '{{count}} attachment',
  'block.attachments_other': '{{count}} attachments',
  'block.attachmentsTip_one': '{{count}} attachment — click to toggle',
  'block.attachmentsTip_other': '{{count}} attachments — click to toggle',

  // Translators: "+3"-style chip after a block's first property chips: tooltip and screen-reader
  // label; it opens the property side panel. {{count}} = all properties; keep "Ctrl+Shift+P".
  'block.showAllProperties_one': 'Show all {{count}} property (Ctrl+Shift+P)',
  'block.showAllProperties_other': 'Show all {{count}} properties (Ctrl+Shift+P)',

  // Translators: Repeat rule of a recurring task, shown on its repeat chip and inserted as
  // {{value}} in block.repeats ("Repeats {{value}}"), so lower case. The two suffixes are added
  // right after a rule and start with a space: "(from completion)" = the next date counts from
  // when you finish the task; "(catch-up)" = the date jumps past missed dates. {{count}} = number
  // of units.
  'repeat.daily': 'daily',
  'repeat.weekly': 'weekly',
  'repeat.monthly': 'monthly',
  'repeat.yearly': 'yearly',
  'repeat.fromCompletionSuffix': ' (from completion)',
  'repeat.catchUpSuffix': ' (catch-up)',
  'repeat.everyDays_one': 'every {{count}} day',
  'repeat.everyDays_other': 'every {{count}} days',
  'repeat.everyWeeks_one': 'every {{count}} week',
  'repeat.everyWeeks_other': 'every {{count}} weeks',
  'repeat.everyMonths_one': 'every {{count}} month',
  'repeat.everyMonths_other': 'every {{count}} months',
  'repeat.everyYears_one': 'every {{count}} year',
  'repeat.everyYears_other': 'every {{count}} years',

  // Translators: Callout types (a coloured box with an icon): the label at the top of the box and
  // the choices in the callout menus. Also inserted as {{name}} in the screen-reader labels of a
  // foldable callout's open/close button, e.g. "Collapse Warning callout".
  'callout.info': 'Info',
  'callout.warning': 'Warning',
  'callout.tip': 'Tip',
  'callout.error': 'Error',
  'callout.note': 'Note',
  'callout.collapse': 'Collapse {{name}} callout',
  'callout.expand': 'Expand {{name}} callout',

  // Translators: Settings › Sync & devices, the network address of a paired device: label, empty
  // value, Edit button, the toast after saving, the error under the field when a save is refused,
  // and the hint about pairing on the same network.
  // "host:port" is a fixed format, keep it; {{format}} = an example address, e.g.
  // "192.168.1.100:5000".
  'status.peerAddress': 'Address',
  'status.peerAddressNotSet': 'No address',
  'status.editAddress': 'Edit',
  'status.addressUpdated': 'Address updated',
  'status.addressInvalid': 'Invalid address format (expected host:port)',
  'status.addressInvalidWithFormat':
    'Invalid address format. Expected host:port (e.g., {{format}}).',
  'status.manualIpHint':
    "Pairing needs both devices on the same local network; you can't pair by typing an address. If a paired device on this network later stops being found, set its address below.",

  // Translators: Import section (Logseq or Markdown files): title, description and button.
  // ".md" is a file extension; keep it.
  'status.importTitle': 'Import',
  'status.importDesc':
    'Import Logseq or Markdown files. Pages are created from filenames, blocks from indented list items.',
  'status.importButton': 'Select .md files',

  // Translators: Settings › App health, StatusPanel: what each counter means, shown when its label
  // is tapped. The materializer is the background work that keeps search, the agenda and counts up
  // to date. "FTS" = the full-text search index; "operations"/"sync messages" = recorded changes;
  // "peers" = your other paired devices; "sync engine" = the part that sends changes to them.
  'status.foregroundQueueInfo':
    'Operations waiting to be applied to the database. Should stay near zero.',
  'status.backgroundQueueInfo':
    'Cache rebuild and FTS indexing tasks. Non-critical, best-effort processing.',
  'status.opsDispatchedInfo': 'Total operations processed since app start.',
  'status.backgroundDispatchedInfo': 'Total background cache tasks completed since app start.',
  'status.sqlOnlyFallbackInfo':
    'Changes saved to the database but not to the sync engine since app start, so they do not reach your other devices. Should stay at zero; if not, run the integrity check.',
  'status.fanoutDroppedInfo':
    'Deletes or restores of nested blocks the sync engine did not follow since app start. Should stay at zero; if not, run the integrity check.',
  'status.peerCountInfo': 'Number of paired devices',
  'status.lastSyncedInfo': 'Time since last successful sync',
  'status.opsReceivedInfo':
    'Total sync messages received from peers, one per synced space (resets on app restart)',
  'status.opsSentInfo':
    'Total sync messages sent to peers, one per synced space (resets on app restart)',

  // Translators: Toast after an import; {{totalBlocks}} = blocks imported, {{fileCount}} = files.
  'status.importedMessage': 'Imported {{totalBlocks}} blocks from {{fileCount}} file(s)',

  // Translators: Settings › App health, StatusPanel, Materializer card (background work that
  // keeps search, the agenda and counts up to date): card title, screen-reader loading label, and
  // short counter labels. "Peak:" is followed by a number. "Ops" = operations (recorded changes).
  'status.materializerStatusTitle': 'Materializer status',
  'status.loadingLabel': 'Loading status',
  'status.foregroundQueueLabel': 'Foreground queue',
  'status.peakLabel': 'Peak:',
  'status.backgroundQueueLabel': 'Background queue',
  'status.opsDispatchedLabel': 'Ops processed',
  'status.backgroundDispatchedLabel': 'Background dispatched',
  'status.sqlOnlyFallbackLabel': 'Writes the sync engine missed',
  'status.fanoutDroppedLabel': 'Cascades the sync engine missed',

  // Translators: Settings › App health, StatusPanel: warning lines with their smaller hint lines.
  // {{count}} = number of errors or of pending rebuilds; "cache" = data derived from your notes.
  'status.foregroundErrorsMessage_one': '{{count}} foreground error',
  'status.foregroundErrorsMessage_other': '{{count}} foreground errors',
  'status.backgroundErrorsMessage_one': '{{count}} background error',
  'status.backgroundErrorsMessage_other': '{{count}} background errors',
  'status.cacheStaleHint': 'Cache data may be stale. Restart the app to retry.',
  'status.bgStaleMessage_one':
    '{{count}} background cache rebuild pending — search, agenda, and counts may be briefly stale.',
  'status.bgStaleMessage_other':
    '{{count}} background cache rebuilds pending — search, agenda, and counts may be briefly stale.',
  'status.bgStaleHint':
    'Note content is never affected. Results reconcile automatically within an hour; restart the app to retry sooner.',

  // Translators: Settings › App health, StatusPanel: warning about spaces (separate notebooks)
  // whose changes do not reach other devices; {{spaces}} = space names separated by commas,
  // {{count}} = how many. In the hint, the quoted “…” section title, "Settings › Sync &
  // devices" and "Help" name other parts of the app: keep them matching those labels.
  // #6523 — a space whose changes are held back from other devices.
  'status.exportRefusedMessage_one':
    'Changes in the space {{spaces}} are not reaching your other devices: its sync data and its database disagree about a deleted block.',
  'status.exportRefusedMessage_other':
    'Changes in the spaces {{spaces}} are not reaching your other devices: their sync data and their database disagree about a deleted block.',
  'status.exportRefusedHint':
    'Agaric repairs this at the next sync when it can. If this message stays, restart Agaric, and retry any change listed under “Sync changes that could not be applied” in Settings › Sync & devices. If it is still here after that, report a bug from Help.',

  // Translators: Settings › App health, StatusPanel, Sync status card: title, the state values
  // (short), the state's screen-reader label ({{state}} = one of those values), and counter labels.
  // "Peer(s)" = your other paired devices; "Ops" = operations (recorded changes).
  'status.syncStatusTitle': 'Sync status',
  'status.syncIdle': 'Idle',
  'status.syncSyncing': 'Syncing...',
  'status.syncWaiting': 'Waiting',
  'status.syncError': 'Error',
  'status.syncOffline': 'Offline',
  'status.syncStateLabel': 'Sync state: {{state}}',
  'status.peerLabel_one': 'Peer',
  'status.peerLabel_other': 'Peers',
  'status.lastSyncedLabel': 'Last synced',
  'status.opsReceivedLabel': 'Ops received',
  'status.opsSentLabel': 'Ops sent',

  // Translators: Progress message while files are being imported.
  'status.importingMessage': 'Importing...',

  // Translators: Toasts (brief pop-up messages) after an action on several selected blocks.
  // {{failCount}} of {{totalCount}} = blocks that failed out of those selected; {{successCount}} =
  // blocks changed; {{state}} = a task keyword (TODO, DOING, DONE) or the task.noneState
  // translation when the state was cleared; {{count}} = blocks.
  'blockTree.updateFailedMessage': '{{failCount}} of {{totalCount}} failed to update',
  'blockTree.setStateMessage': 'Set {{successCount}} block(s) to {{state}}',
  'blockTree.deleteFailedMessage': '{{failCount}} of {{totalCount}} failed to delete',
  // The toast carries its own Undo action (#6547); Ctrl+Z does not reach it in the journal.
  'blockTree.deletedMessageUndo_one': 'Deleted {{count}} block',
  'blockTree.deletedMessageUndo_other': 'Deleted {{count}} blocks',

  // Translators: Error toasts when changing a block fails. "List style" = numbered or bulleted
  // list; "Link target" = the page or block a link points to.
  'blockTree.setTaskStateFailed': 'Failed to set task state',
  'blockTree.setListStyleFailed': 'Failed to set list style',
  'blockTree.clearListStyleFailed': 'Failed to clear list style',
  'blockTree.linkTargetNotFound': 'Link target not found',
  'blockTree.setPriorityFailed': 'Failed to set priority',
  'blockTree.setHeadingFailed': 'Failed to set heading',

  // Translators: Toasts after commands that set a block's properties (fields such as assignee,
  // location, effort = estimated work, repeat). {{name}} = a property name; {{value}} = the value
  // entered; "end condition" = when a repeating task stops; {{count}} = number of repetitions.
  'blockTree.addedPropertyMessage': 'Added {{name}} property',
  'blockTree.addPropertyFailed': 'Failed to add property',
  'blockTree.addedAssigneeProperty': 'Added assignee property',
  'blockTree.setAssigneeMessage': 'Set assignee to {{value}}',
  'blockTree.setAssigneeFailed': 'Failed to set assignee',
  'blockTree.addedLocationProperty': 'Added location property',
  'blockTree.addedEffortProperty': 'Added effort property',
  'blockTree.setLocationMessage': 'Set location to {{value}}',
  'blockTree.setLocationFailed': 'Failed to set location',
  'blockTree.repeatEndConditionRemoved': 'Repeat end condition removed',
  'blockTree.removeEndConditionFailed': 'Failed to remove end condition',
  'blockTree.repeatLimitedMessage_one': 'Repeat limited to {{count}} occurrence',
  'blockTree.repeatLimitedMessage_other': 'Repeat limited to {{count}} occurrences',
  'blockTree.setRepeatLimitFailed': 'Failed to set repeat limit',

  // Translators: Toasts while attaching a file to a block; {{filename}} = the file's name;
  // {{type}} = its file type, e.g. "video/mp4"; {{size}} = its size, e.g. "72.4 MB".
  // "drag & drop" = dragging the file onto the block.
  'blockTree.filePathReadFailed': 'Could not read file path \u2014 use drag & drop instead',
  'blockTree.attachingFileMessage': 'Attaching "{{filename}}"…',
  'blockTree.attachedFileMessage': 'Attached "{{filename}}"',
  'blockTree.attachFileFailed': 'Failed to attach file',
  'blockTree.attachmentTypeNotAllowed':
    '{{type}} cannot be attached — allowed: images, audio, text, PDF, JSON, ZIP, TAR',
  'blockTree.attachmentTooLarge': 'File is {{size}} — max is 50 MB. Compress it and try again.',

  // Translators: Error toasts when deleting, merging or duplicating blocks fails. "Children" =
  // the blocks indented under it.
  'blockTree.cannotDeleteLastBlock': 'Cannot delete the last block on a page',
  'blockTree.cannotDeleteParentAtTop':
    'Cannot delete the first block while it has children — there is nothing above to move them under',
  'blockTree.mergeBlocksFailed': 'Failed to merge blocks',
  'blockTree.duplicateFailed': 'Failed to duplicate block',

  // Translators: Empty states of a page's block list. "+ Add block" names the button below it,
  // keep it matching that button; "/" is the key that opens the command menu, keep it.
  // "Creating first block…" shows while an empty page gets its first block. The zoom strings
  // show when you zoomed into a block that has nothing visible inside.
  'blockTree.noBlocks': 'No blocks yet. Click + Add block below to start writing.',
  'blockTree.emptyPageHint': 'Type / for commands',
  'blockTree.emptyPage': 'Creating first block\u2026',
  'blockTree.emptyZoom': 'No blocks are visible inside this block.',
  'blockTree.emptyZoomHint': 'Exit zoom to return to the page.',

  // Translators: Screen-reader name of a page's list of blocks.
  'blockTree.treeLabel': 'Block tree',

  // Translators: Error toasts (brief pop-up messages) when an empty page's first block or a date
  // cannot be set, and the toast after setting the end date of a repeating task; {{date}} = that
  // date, e.g. "2026-06-17".
  'blockTree.createFirstBlockFailed': 'Failed to create first block',
  'blockTree.setDueDateFailed': 'Failed to set due date',
  'blockTree.insertDateLinkFailed': 'Failed to insert date link',
  'blockTree.repeatUntilMessage': 'Repeat until {{date}}',
  'blockTree.setRepeatEndDateFailed': 'Failed to set repeat end date',
  'blockTree.setScheduledDateFailed': 'Failed to set scheduled date',

  // Translators: Toasts when typed "key:: value" lines could not be saved as properties and stay
  // as plain text; {{lines}} = those lines, separated by commas.
  'blockTree.propertyKeptAsText': 'Kept as text: {{lines}}',
  'blockTree.pasteKeptAsText': 'Some of the paste was kept as text',

  // Translators: Screen-reader label while a page's blocks load.
  'blockTree.loadingLabel': 'Loading blocks',

  // Translators: Notice at the top of a very large page; {{shown}} = blocks shown, {{total}} = all
  // blocks of the page.
  // #1258 — page-subtree truncation notice. The backend caps a page at
  // PAGE_SUBTREE_MAX_BLOCKS; before this, the excess was dropped silently.
  'blockTree.truncatedNotice':
    'Showing the first {{shown}} blocks of {{total}} — this page is very large. Some blocks are not displayed; consider splitting it into smaller pages.',

  // Translators: Button at the end of a long page that shows the next blocks; {{count}} = blocks.
  // #2467 — mount-envelope boundary row (BlockListRenderer). Rows beyond the
  // FE mount cap (`useBlockMountLimit`) are not mounted at all; this button
  // reveals (mounts) the next batch. Distinct from `blockTree.truncatedNotice`,
  // which reports the BACKEND's `load_page_subtree` cap — this one reports
  // the FRONTEND's render-mount cap over blocks the store already holds.
  'blockTree.mountBoundary_one': 'Show {{count}} more block',
  'blockTree.mountBoundary_other': 'Show {{count}} more blocks',

  // Translators: Screen-reader announcement while dragging a block; {{depth}} = the indent level
  // it would drop at (a number), {{count}} = blocks moved (the block with its children).
  // #1727 — SR-only drag announcement for the DnD overlay (BlockDndOverlay).
  // `movingSubtree` is pluralised on `count` (blocks being dragged); `moving`
  // covers the single-block case.
  'blockTree.dnd.moving': 'Moving to depth {{depth}}',
  'blockTree.dnd.movingSubtree_one': 'Moving {{count}} block to depth {{depth}}',
  'blockTree.dnd.movingSubtree_other': 'Moving {{count}} blocks to depth {{depth}}',

  // Translators: Grey placeholder in an empty block ("/" opens the command menu, keep it), and the
  // caption shown while dragging a file over a block. Keep "PDF", "JSON", "ZIP" and "MB" as
  // written.
  'block.emptyPlaceholder': 'Type / for commands...',
  'block.attachDropZoneCaption': 'Drop to attach — images, text, PDF, JSON, ZIP (max 50 MB)',

  // Translators: Toolbar shown when several blocks are selected. "selected" follows the number of
  // selected blocks ("3 selected"). "Clear" removes the task state; TODO, DOING, DONE are the task
  // keywords, kept in English. Then the Delete button and its confirmation dialog (title, body,
  // confirm button); {{count}} = selected blocks.
  'blockContext.selected': 'selected',
  'blockContext.clear': 'Clear',
  'blockContext.todoLabel': 'TODO',
  'blockContext.doingLabel': 'DOING',
  'blockContext.doneLabel': 'DONE',
  'blockContext.delete': 'Delete',
  'blockContext.deleteConfirmTitle_one': 'Delete {{count}} block?',
  'blockContext.deleteConfirmTitle_other': 'Delete {{count}} blocks?',
  'blockContext.deleteConfirmDescription':
    'This will soft-delete the selected blocks. They can be restored from the trash.',
  'blockContext.deleteConfirmAction': 'Yes, delete',

  // Translators: "No task state" value, lower case: inserted as {{state}} in
  // blockTree.setStateMessage when the selected blocks' task state is cleared.
  'task.noneState': 'none',

  // Translators: Settings › Notifications: unit after the number field "warn N days before a
  // deadline".
  'block.daysUnit': 'days',

  // Translators: Repeat status of a recurring task; {{value}} = a repeat rule like "weekly".
  'block.repeatStatus': 'Repeats {{value}}',
}
