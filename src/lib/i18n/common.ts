/**
 * i18n namespace: common
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const common: Record<string, string> = {
  'boot.starting': 'Starting Agaric\u2026',
  'boot.failedToStart': 'Failed to start',
  'boot.recoveredDrafts_one': 'Recovered {{count}} unsaved draft',
  'boot.recoveredDrafts_other': 'Recovered {{count}} unsaved drafts',
  'boot.showDetailsButton': 'Show details',
  'boot.hideDetailsButton': 'Hide details',
  'boot.copyDiagnosticsLabel': 'Copy diagnostics',
  'boot.copiedLabel': 'Copied!',
  // #1255: boot op-log replay failure — the materialized view may be
  // stale/incomplete. Surfaced as a persistent warning so the user knows
  // before layering more edits on top (nothing is lost — the op log is
  // canonical — but a restart usually re-runs recovery cleanly).
  'boot.recoveryDegradedBody':
    'A startup recovery step did not finish, so recent edits may not appear yet. Your data is safe — restarting Agaric usually fixes this. Avoid making large edits until it is resolved.',
  // #6057: shown only on the boot that moved inbound sync deltas to quarantine.
  'boot.syncQuarantinedBody_one':
    '{{count}} change from another device could not be applied. It has been kept, not lost.',
  'boot.syncQuarantinedBody_other':
    '{{count}} changes from another device could not be applied. They have been kept, not lost.',
  // #2921 — generic fallback shown on the BootGate error screen when
  // `refreshAvailableSpaces()` hard-fails during boot (no prior snapshot)
  // and the caught value carries no readable message of its own.
  'boot.spacesLoadFailed': 'Could not load your spaces. Check your connection and try again.',
  'sidebar.pages': 'Pages',
  'sidebar.journal': 'Journal',
  'sidebar.newPage': 'New Page',
  'sidebar.sync': 'Sync',
  'sidebar.search': 'Search',
  'sidebar.tags': 'Tags',
  'sidebar.trash': 'Trash',
  'sidebar.history': 'History',
  'sidebar.templates': 'Templates',
  'sidebar.graph': 'Graph',
  'sidebar.query': 'Advanced Query',
  'sidebar.collapseSidebar': 'Collapse sidebar',
  'sidebar.expandSidebar': 'Expand sidebar',
  'sidebar.toggleSidebar': 'Toggle Sidebar',
  // Accessible name for the mobile header hamburger. Deliberately NOT
  // `sidebar.toggleSidebar` ("Toggle Sidebar"): on a phone there is no
  // visible sidebar to "toggle", the control opens a navigation drawer, and
  // "menu" is the word touch users are scanning the header for.
  'sidebar.openMenu': 'Open navigation menu',
  'nav.back': 'Back',
  'nav.forward': 'Forward',
  'sidebar.newPageTooltip': 'New Page (Ctrl+N)',
  'sidebar.offline': 'Offline',
  'sidebar.syncTooltip': 'Sync all devices',
  'sidebar.syncing': 'Syncing...',
  // #4713 — the sidebar Bookmarks section over the one bookmark list.
  'bookmarks.title': 'Bookmarks',
  'bookmarks.emptyHint': 'Bookmark a page to keep it here.',
  'bookmarks.remove': 'Remove {{title}} from bookmarks',
  'bookmarks.writeFailed': 'Could not save your bookmarks. The list was restored.',
  'bookmarks.reorderInstructions':
    'To reorder a bookmark, press space to pick it up, use the up and down arrow keys to move it, and press space again to drop it. Press escape to cancel. Press enter to open the page.',
  'space.switch': 'Switch space',
  'space.manage': 'Manage spaces…',
  'space.moveTo': 'Move to space',
  'space.movedToast': 'Page moved to {{space}}',
  'space.moveFailed': 'Failed to move page',
  'spaceMove.lossTitle': 'Move and remove properties?',
  'spaceMove.lossDescription':
    '{{space}} does not define these properties the same way, so the move removes their values. Undo puts them back.',
  'spaceMove.lossConfirm': 'Move and remove',
  'spaceMove.lossChanged': 'Something changed since you confirmed. Check the list again.',
  'spaceMove.lossListLabel': 'Properties the move removes',
  'spaceMove.valueCount_one': '{{count}} value',
  'spaceMove.valueCount_other': '{{count}} values',
  'spaceMove.inTrash': 'In Trash',
  'spaceMove.valuesFailed': 'Could not load the values',
  'space.notReady': 'Loading spaces…',
  'space.activeDeletedNotification':
    'Your active space was deleted on another device. Switched to {{space}}.',
  'space.renameLabel': 'Rename space',
  'space.accentColorLabel': 'Accent color',
  'space.accentSwatchLabel': 'Use {{color}} accent',
  'space.deleteSpaceLabel': 'Delete space',
  'space.deleteSpaceTooltipDisabled':
    'Delete every page in this space first — spaces can only be deleted when empty.',
  'space.deleteSpaceInlineHint': 'Move or delete the pages in this space first to enable deletion.',
  'space.deleteLastTooltipDisabled':
    'You must keep at least one space — delete is disabled on the last remaining space.',
  'space.deleteConfirmTitle': "Delete space '{{name}}'?",
  'space.deleteConfirmDescription': 'This space must already be empty. This cannot be undone.',
  'space.deleteFailed': 'Failed to delete space',
  'space.renameFailed': 'Failed to rename space',
  'space.accentFailed': 'Failed to update accent color',
  'space.createSpaceLabel': 'Create new space',
  'space.createSpaceCta': 'Create',
  'space.createSpaceFailed': 'Failed to create space',
  'space.newSpacePlaceholder': 'New space name',
  'space.cancelLabel': 'Cancel',
  'space.accentBadge': '{{name}} space — click to switch',
  'space.accentBadgeTitle': '{{name}} — click to switch',
  'action.addBlock': 'Add block',
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.delete': 'Delete',
  'action.undo': 'Undo',
  'action.redo': 'Redo',
  'action.retry': 'Retry',
  'action.dismiss': 'Dismiss',
  'action.review': 'Review',
  'action.reload': 'Reload',
  'action.loadMore': 'Load more',
  'action.loading': 'Loading\u2026',
  'action.clear': 'Clear',
  'announce.navigatedToPrevious': 'Navigated to previous day/week/month',
  'announce.navigatedToNext': 'Navigated to next day/week/month',
  'announce.jumpedToToday': 'Jumped to today',
  'announce.newPageCreated': 'New page created',
  // #2944 — single announcement for every `currentView` switch (palette
  // `go-<view>` commands, sidebar clicks, keyboard shortcuts), replacing
  // the one-off `announce.searchOpened` that only the `focusSearch`
  // shortcut used. `{{view}}` is the localized nav-item label (e.g.
  // `sidebar.search`, `sidebar.pages`).
  'announce.navigatedTo': 'Navigated to {{view}}',
  // Phase 8 — runLastCommand global shortcut announcement.
  'announce.ranLastCommand': 'Re-ran last command',
  'announce.overlaysClosed': 'Overlays closed',
  'announce.editingBlock': 'Editing block: {{preview}}',
  'announce.emptyBlock': 'empty block',
  'announce.blockDeleted': 'Block deleted',
  'announce.blockIndented': 'Block indented',
  'announce.blockDedented': 'Block outdented',
  'announce.blockCreated': 'Block created',
  'announce.blockMovedUp': 'Block moved up',
  'announce.blockMovedDown': 'Block moved down',
  // R6 (#405): announced when a move/indent fails so assistive tech does not
  // report a phantom success. Paired with the toast in the store action.
  'announce.moveFailed': 'Move failed',
  'announce.blockCollapsed': 'Block collapsed',
  'announce.blockExpanded': 'Block expanded',
  'announce.taskState': 'Task state: {{state}}',
  'announce.prioritySet': 'Priority set to {{level}}',
  'announce.scheduledDateSet': 'Scheduled date set to {{date}}',
  'announce.pairingCountdown': 'Pairing session expires in {{seconds}} seconds',
  'announce.pairingCountdownMinute': 'Pairing session expires in 1 minute',
  'announce.pairingExpired': 'Pairing session expired',
  // #3469 — waiting-state transitions, announced once per transition (not
  // per tick) so screen-reader users learn the outcome without being spammed.
  'announce.pairingWaiting': 'Waiting for the other device to confirm pairing',
  'announce.pairingSucceeded': 'Device paired successfully',
  'announce.pairingProofRejected': 'Pairing passphrase did not match',
  'announce.pairingWaitTimedOut': 'Pairing timed out waiting for the other device',
  'announce.undone': 'Undone',
  'announce.undoFailed': 'Undo failed',
  'announce.redone': 'Redone',
  'announce.redoFailed': 'Redo failed',
  'announce.journalNoDay': 'No day to undo in yet',
  'announce.blockRestored': 'Block restored from trash',
  'announce.blockPurged': 'Block permanently deleted',
  'announce.blocksSelected_one': '{{count}} block selected',
  'announce.blocksSelected_other': '{{count}} blocks selected',
  'announce.selectionCleared': 'Selection cleared',
  'announce.batchRestored_one': '{{count}} block restored from trash',
  'announce.batchRestored_other': '{{count}} blocks restored from trash',
  'announce.batchPurged_one': '{{count}} block permanently deleted',
  'announce.batchPurged_other': '{{count}} blocks permanently deleted',
  'announce.trashEmptied_one': 'Trash emptied — {{count}} item permanently deleted',
  'announce.trashEmptied_other': 'Trash emptied — {{count}} items permanently deleted',
  'announce.allRestored_one': 'All items restored — {{count}} block',
  'announce.allRestored_other': 'All items restored — {{count}} blocks',
  'announce.emptyTrashFailed': 'Empty trash failed',
  // #3835 — `purgeAllDeletedInSpace` failing part-way through still
  // committed the chunks before the failure; distinct from
  // `emptyTrashFailed` (which implies nothing happened).
  'announce.emptyTrashPartial_one':
    'Trash partially emptied — {{count}} item permanently deleted before an error interrupted it',
  'announce.emptyTrashPartial_other':
    'Trash partially emptied — {{count}} items permanently deleted before an error interrupted it',
  'announce.restoreAllFailed': 'Restore all failed',
  'announce.restoreAllPartial_one':
    'Restore all partially completed — {{count}} item restored before an error interrupted it',
  'announce.restoreAllPartial_other':
    'Restore all partially completed — {{count}} items restored before an error interrupted it',
  'announce.restoreFailed': 'Restore failed',
  'announce.purgeFailed': 'Purge failed',
  'announce.batchRestoreFailed': 'Batch restore failed',
  'announce.batchPurgeFailed': 'Batch purge failed',
  // #3835 — `purge_blocks_by_ids` rejected the batch because the trash
  // listing this selection came from is stale (a restore landed elsewhere).
  'announce.batchPurgeStale': 'Trash listing was out of date and has been refreshed',
  'announce.opsReverted_one': '{{count}} operation reverted',
  'announce.opsReverted_other': '{{count}} operations reverted',
  'announce.revertFailed': 'Revert failed',
  'announce.restoreToHereSucceeded_one': 'Restored {{count}} operation',
  'announce.restoreToHereSucceeded_other': 'Restored {{count}} operations',
  'announce.restoreToHereFailed': 'Restore failed',
  'announce.syncStarted': 'Sync started',
  'announce.syncCompleted': 'Sync completed',
  'announce.syncFailed': 'Sync failed',
  // #4305 — "operations" was never what the number counted; it was sync
  // protocol messages, one per space. These are announced for the block counts
  // the toast now shows, and are only reached when something actually changed.
  'announce.syncChangesApplied_one': '{{count}} change received from sync',
  'announce.syncChangesApplied_other': '{{count}} changes received from sync',
  // #4305 — the countless twin, for a whole-space snapshot catch-up.
  'announce.syncChangesAppliedUnknownCount': 'Changes received from sync',
  'announce.taskRescheduled': 'Task rescheduled to {{date}}',
  'announce.rescheduleFailed': 'Reschedule failed',
  'announce.dateUpdated': 'Date updated to {{date}}',
  'announce.dateCleared': 'Date cleared',
  'announce.pageRenamed': 'Page renamed',
  'announce.pageRenameFailed': 'Page rename failed',
  'announce.pageDeleted': 'Page deleted',
  'announce.pageDeleteFailed': 'Page delete failed',
  'announce.pageMoved': 'Page moved',
  'announce.pageMoveFailed': 'Page move failed',
  'announce.aliasAdded': 'Alias added',
  'announce.aliasRemoved': 'Alias removed',
  'announce.aliasFailed': 'Alias update failed',
  'announce.exported': 'Page exported to clipboard',
  'announce.readAloudStopped': 'Stopped reading aloud',
  'announce.readAloudFinished': 'Finished reading aloud',
  'announce.exportFailed': 'Export failed',
  'contextMenu.delete': 'Delete',
  'contextMenu.deleteSelected': 'Delete {{count}} selected',
  'contextMenu.cycleTodoSelected': 'Cycle task state',
  'contextMenu.setTodoSelected': 'Set task state to {{state}}',
  'contextMenu.clearTodoSelected': 'Clear task state',
  'contextMenu.cyclePrioritySelected': 'Cycle priority',
  'contextMenu.indent': 'Indent',
  'contextMenu.dedent': 'Dedent',
  'contextMenu.moveUp': 'Move Up',
  'contextMenu.moveDown': 'Move Down',
  'contextMenu.merge': 'Merge with previous',
  'contextMenu.moveArrange': 'Move & arrange',
  'contextMenu.collapse': 'Collapse',
  'contextMenu.expand': 'Expand',
  'contextMenu.history': 'History',
  'contextMenu.blockActions': 'Block actions',
  'contextMenu.todoToDoing': 'TODO → DOING',
  'contextMenu.doingToDone': 'DOING → DONE',
  'contextMenu.doneToCancelled': 'DONE → CANCELLED',
  'contextMenu.cancelledToClear': 'CANCELLED → Clear',
  'contextMenu.setTodo': 'Set as TODO',
  'contextMenu.priority1To2': 'Priority 1 → 2',
  'contextMenu.priority2To3': 'Priority 2 → 3',
  'contextMenu.priority3ToClear': 'Priority 3 → Clear',
  'contextMenu.setPriority1': 'Set priority 1',
  'contextMenu.properties': 'Properties...',
  'contextMenu.zoomIn': 'Zoom in',
  'contextMenu.duplicate': 'Duplicate',
  'contextMenu.openLink': 'Open link',
  'contextMenu.copyUrl': 'Copy URL',
  'contextMenu.urlCopied': 'URL copied to clipboard',
  'contextMenu.copyUrlFailed': 'Failed to copy URL',
  // #1445 — copy a Roam-style reference to this block (`((ULID))`) or its
  // containing page (`[[ULID]]`) to the clipboard for pasting elsewhere.
  'contextMenu.copyBlockRef': 'Copy block reference',
  'contextMenu.copyPageRef': 'Copy page reference',
  'contextMenu.blockRefCopied': 'Block reference copied to clipboard',
  'contextMenu.pageRefCopied': 'Page reference copied to clipboard',
  'contextMenu.copyRefFailed': 'Failed to copy reference',
  // Copy the block's markdown CONTENT (not a reference to it) to the system
  // clipboard — shallow (this block only), the whole subtree, or the whole
  // multi-block selection. Same serializer + humanized refs as the
  // `copyBlocks` keyboard chord.
  'contextMenu.copyBlockContent': 'Copy block content',
  'contextMenu.copySubtreeContent': 'Copy subtree content',
  'contextMenu.copySelectionContent': 'Copy selection',
  'contextMenu.blockContentCopied': 'Block content copied to clipboard',
  'contextMenu.subtreeContentCopied': 'Subtree content copied to clipboard',
  'contextMenu.selectionContentCopied': 'Selection copied to clipboard',
  'contextMenu.copyContentFailed': 'Failed to copy content',
  'contextMenu.actionFailed': 'Action failed',
  'contextMenu.turnInto': 'Turn into',
  'contextMenu.turnIntoType.paragraph': 'Text',
  'contextMenu.turnIntoType.h1': 'Heading 1',
  'contextMenu.turnIntoType.h2': 'Heading 2',
  'contextMenu.turnIntoType.h3': 'Heading 3',
  'contextMenu.turnIntoType.quote': 'Quote',
  'contextMenu.turnIntoType.code': 'Code block',
  'contextMenu.turnIntoType.numberedList': 'Ordered list',
  'contextMenu.turnIntoType.bulletList': 'Bullet list',
  'contextMenu.turnIntoType.callout': 'Callout',
  'sidebar.properties': 'Properties',
  'shortcuts.title': 'Quick Reference',
  'shortcuts.syntaxSection': 'Syntax',
  'dialog.no': 'No',
  'common.expand': 'Expand {{section}}',
  'common.collapse': 'Collapse {{section}}',
  'common.empty': '(empty)',
  'common.untitled': 'Untitled',
  // #2232 — direction tokens interpolated into translated sort aria-labels.
  'common.ascending': 'ascending',
  'common.descending': 'descending',
  // #2232 — default label for the shared LoadingSkeleton busy region.
  'common.loading': 'Loading',
  'accessibility.skipToMain': 'Skip to main content',
  'sidebar.label': 'Sidebar',
  'sidebar.mobileDescription': 'Displays the mobile sidebar.',
  'breadcrumb.showHidden': 'Show hidden breadcrumbs',
  'ui.close': 'Close',
  'ui.loading': 'Loading…',
  'sidebar.themeDark': 'Dark mode',
  'sidebar.themeLight': 'Light mode',
  'sidebar.lastSynced': 'Last synced {{time}}',
  'sidebar.lastSyncedNever': 'Never synced',
  'sidebar.justNow': 'just now',
  'sidebar.minutesAgo': '{{count}}m ago',
  'sidebar.hoursAgo': '{{count}}h ago',
  'sidebar.daysAgo': '{{count}}d ago',
  'welcome.title': 'Welcome to Agaric',
  'welcome.description': 'A local-first note-taking app for organizing your thoughts.',
  // #214 Phase 1B \u2014 three concrete workflow rows that teach the core
  // gestures (slash menu, link/tag, inline formatting) instead of the
  // earlier six abstract feature blurbs.
  'welcome.workflowSlash': 'Type / for tasks & dates',
  'welcome.workflowSlashDesc': 'Open the command menu to add tasks, dates, headings, and more.',
  'welcome.workflowLinkTag': 'Type [[ to link, @ to tag',
  'welcome.workflowLinkTagDesc': 'Connect pages with [[links]] and organize blocks with @tags.',
  'welcome.workflowFormat': 'Select text to format',
  'welcome.workflowFormatDesc': 'Highlight any text to make it bold, italic, or underlined.',
  'welcome.workflowFormatTouch': 'Format with the toolbar',
  'welcome.workflowFormatDescTouch':
    'Tap a block, then use the toolbar above the keyboard to make text bold, italic, or underlined.',
  'welcome.importNotes': 'Import notes',
  'welcome.pairDevice': 'Pair a device',
  'welcome.pairComputer': 'Pair with your computer',
  'welcome.getStarted': 'Get Started',
  'welcome.createSamplePages': 'Create sample pages',
  'welcome.samplePagesCreated': 'Sample pages created!',
  'welcome.samplePagesFailed': 'Failed to create sample pages',
  'welcome.sampleGettingStartedTitle': 'Getting Started',
  'welcome.sampleGettingStartedBody1': 'Welcome to Agaric! This is a local-first note-taking app.',
  'welcome.sampleGettingStartedBody2':
    'Each page is made of **blocks** — small pieces of text that you can nest and reorganize.',
  'welcome.sampleGettingStartedBody3':
    'Use the sidebar to navigate between pages, journal, tags, and more.',
  'welcome.sampleQuickTipsTitle': 'Quick Tips',
  'welcome.sampleQuickTipsBody1': 'Press **?** to open the keyboard shortcuts reference.',
  'welcome.sampleQuickTipsBody2': 'Use **Ctrl+N** to quickly create a new page.',
  'welcome.sampleQuickTipsBody3':
    'Type **/** to open the slash command menu for inserting dates, templates, and more.',
  'sidebar.settings': 'Settings',
  'recent.ariaLabel': 'Recently visited pages',
  'recent.untitled': 'Untitled',
  'tabs.close': 'Close tab',
  'tabs.closeTab': 'Close tab: {{label}}',
  'tabs.openInNewTabEmpty': 'No page to open in a new tab',
  'tabs.openInNewTab': 'Open in new tab',
  'tabs.openedInBackground': 'Opened {{title}} in a new tab',
  'tabs.untitled': 'Untitled',
  'tabs.tabList': 'Editor tabs',
  'tabs.switcher': 'Switch tab',
  'tabs.switcherFilter': 'Filter open tabs',
  'tabs.switcherNoMatch': 'No open tab matches',
  'tabs.activeTab': 'Active tab',
  'tabs.closeActiveTab': 'Close active tab',
  'tabs.nextTab': 'Next tab',
  'tabs.previousTab': 'Previous tab',
  'tabs.reorderInstructions':
    'To move a tab, press space to pick it up, use the left and right arrow keys to move it, and press space again to drop it. Press escape to cancel.',
  'quickCapture.fabLabel': 'Quick capture',
  // #1422 — mobile touch-gesture discoverability: the first-run coach-mark
  // overlay (`gestures.coachmark.*` chrome + `gestures.*.title/desc` rows).
  'gestures.coachmark.title': 'Touch gestures',
  'gestures.coachmark.description':
    'Agaric has a few hidden touch gestures. Here are the essentials.',
  'gestures.coachmark.dismiss': 'Got it',
  'gestures.swipe.title': 'Swipe a block',
  'gestures.swipe.desc':
    'Swipe right to indent, short-swipe left to outdent, or swipe further left to reveal delete.',
  'gestures.longPress.title': 'Hold a block',
  'gestures.longPress.desc': 'Hold a block, then drag to move it — or let go to open its menu.',
  'gestures.quickCapture.title': 'Quick-capture button',
  'gestures.quickCapture.desc': 'Tap the floating pen button to jot a note into your journal.',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Confirm',
  'data.importTitle': 'Import',
  'data.importDesc':
    'Import Markdown, text and Org files, Logseq graphs, Obsidian vaults, Notion exports, and Evernote and Joplin notes as pages.',
  'data.importButton': 'Choose files',
  // #1927 — second affordance: a `webkitdirectory` picker so a whole
  // folder/vault can be imported (folder hierarchy → page namespace).
  'data.importFolderButton': 'Import folder',
  // #2510 — dedicated, discoverable Obsidian-vault affordance. Drives the
  // SAME `webkitdirectory` folder pick + import pipeline as `importFolderButton`
  // (wikilinks, tags, embeds, frontmatter, folders, and — since #2510 item 1 —
  // `^block-id` anchors all resolve on import); the separate, explicitly-named
  // button makes Obsidian support discoverable rather than hidden behind the
  // generic "Import folder" label.
  'data.importObsidianButton': 'Import Obsidian vault',
  // #1282 — third affordance: import Evernote `.enex` exports. Each note in
  // the file becomes its own page (ENML → Markdown, frontend-only).
  'data.importEnexButton': 'Import Evernote (.enex)',
  // #1282 — a `.enex` file whose XML could not be parsed.
  'data.importEnexParseFailed': 'Could not read {{name}}: not a valid Evernote export.',
  // #2513 (part 2) — fourth affordance: import Joplin `.jex` archives. Each note
  // in the archive becomes its own page (Markdown, frontend-only).
  'data.importJexButton': 'Import Joplin (.jex)',
  // #2513 (part 2) — a `.jex` archive whose tar could not be read / had no notes.
  'data.importJexParseFailed': 'Could not read {{name}}: not a valid Joplin export.',
  // #6032 — Evernote note links whose text names no note of their file.
  'data.importEnexNoteLinks_one':
    '{{count}} Evernote note link stays an Evernote link: its text names no note in its file.',
  'data.importEnexNoteLinks_other':
    '{{count}} Evernote note links stay Evernote links: their text names no note in their file.',
  // #2513 (part 2) — items skipped during a `.jex` import (encrypted or
  // unreadable metadata), surfaced as a soft warning in the result panel.
  'data.importJexSkipped_one': 'Skipped {{count}} unreadable or encrypted item.',
  'data.importJexSkipped_other': 'Skipped {{count}} unreadable or encrypted items.',
  // A folder pick's file that is neither a note nor an image or PDF a note may
  // embed (#6032).
  'data.importFolderSkipped_one': 'Skipped {{count}} file that is not a note, an image or a PDF.',
  'data.importFolderSkipped_other': 'Skipped {{count}} files that are not notes, images or PDFs.',
  // A Notion export's database table; its rows are pages of the export too.
  'data.importNotionDatabases_one':
    'Skipped {{count}} Notion database table (.csv); its rows import as pages.',
  'data.importNotionDatabases_other':
    'Skipped {{count}} Notion database tables (.csv); their rows import as pages.',
  // #1454 — fifth affordance: import a BibTeX (`.bib`) or CSL-JSON
  // (`.json`) bibliography. One reference page per entry.
  'data.importBibliographyButton': 'Import bibliography (.bib/.json)',
  'data.importFilesLabel': 'Markdown, text or Org files',
  'data.importFolderLabel': 'Folder (Logseq graph, Notion export, or any Markdown folder)',
  'data.importObsidianLabel': 'Obsidian vault',
  'data.importEnexLabel': 'Evernote',
  'data.importJexLabel': 'Joplin',
  'data.importBibliographyLabel': 'Bibliography',
  // #1454 — success toast + result-panel summary. `count` drives the plural
  // (pages created); `skipped` is the entries the backend skipped.
  'data.importBibliographyResult_one': 'Imported {{count}} reference page ({{skipped}} skipped)',
  'data.importBibliographyResult_other': 'Imported {{count}} reference pages ({{skipped}} skipped)',
  // #1454 — picked a file whose extension maps to no bibliography format.
  'data.importBibliographyUnsupported':
    'Cannot import {{name}}: only .bib and .json bibliography files are supported.',
  // #1454 — picked file has no content to import.
  'data.importBibliographyEmpty': 'Cannot import {{name}}: the file is empty.',
  // #1927 — Cancel a long-running multi-file/vault import between files.
  'data.importCancelButton': 'Cancel',
  // #1927 — partial result after the user cancels a multi-file import.
  'data.importCancelled_one': 'Import cancelled — {{count}} file imported.',
  'data.importCancelled_other': 'Import cancelled — {{count}} files imported.',
  // #1927 — show the target space near the controls so the destination
  // is never silent.
  'data.importTargetSpace': 'Importing into: {{name}}',
  // #1927 — post-import navigation action (success toast + result panel).
  'data.importViewAction': 'View',
  'data.importingMessage': 'Importing...',
  'data.importSpaceNotReady': 'Select a space before importing.',
  'data.importingProgress': 'Importing file {{index}} of {{total}}: {{name}}',
  'data.importingProgressDetail': '{{blocks}} blocks · {{bytes}} processed',
  'data.importingBlocks': 'Block {{done}} of {{total}}',
  'data.importedMessage_one': 'Imported {{totalBlocks}} blocks from {{count}} file',
  'data.importedMessage_other': 'Imported {{totalBlocks}} blocks from {{count}} files',
  // #2513 — Evernote `.enex` aggregate success toast. Each unit is a NOTE (one
  // page per note), so label it "note(s)" rather than the file-worded string.
  'data.importedNotesMessage_one': 'Imported {{totalBlocks}} blocks from {{count}} note',
  'data.importedNotesMessage_other': 'Imported {{totalBlocks}} blocks from {{count}} notes',
  // Result-panel summary line. `count` is the number of blocks created so the
  // i18next plural selector picks the right form; `title` is the page title
  // (single file) or the multi-file placeholder (`data.importResultFilesTitle`).
  'data.importResultSummary_one': 'Imported “{{title}}”: {{count}} block',
  'data.importResultSummary_other': 'Imported “{{title}}”: {{count}} blocks',
  'data.importResultProperties_one': '{{count}} property',
  'data.importResultProperties_other': '{{count}} properties',
  // Multi-file placeholder title used in place of a single page_title.
  'data.importResultFilesTitle_one': '{{count}} file',
  'data.importResultFilesTitle_other': '{{count}} files',
  // #2513 — multi-note placeholder title for the Evernote `.enex` result panel.
  'data.importResultNotesTitle_one': '{{count}} note',
  'data.importResultNotesTitle_other': '{{count}} notes',
  // Failure / warning surfacing (#1928).
  'data.importNoContent': 'No content was imported.',
  'data.importUpToDate': 'Already up to date',
  'data.importAllFailed_one': 'All {{count}} file failed to import.',
  'data.importAllFailed_other': 'All {{count}} files failed to import.',
  'data.importFailuresHeading_one': '{{count}} file failed to import',
  'data.importFailuresHeading_other': '{{count}} files failed to import',
  'data.importWarningsHeading_one': '{{count}} warning',
  'data.importWarningsHeading_other': '{{count}} warnings',
  'data.importFailedFile': 'Failed to import {{name}}',
  // #1935 — surface WHY a file failed (Validation errors carry real
  // text; internal errors are already sanitized backend-side).
  'data.importFailedFileDetail': 'Failed to import {{name}}: {{reason}}',
  'data.importLinkingFailed':
    'The links between the imported notes could not be completed: {{reason}}',
  // #6277 decision 8 — an export's `.agaric/space.json` restores the space's
  // property definitions and the titles its file names cannot spell.
  'data.importSpaceFileFailed': 'The export’s .agaric/space.json could not be restored: {{reason}}',
  'data.importPropertyDefFailed': 'The property “{{key}}” could not be restored: {{reason}}',
  // #6277 decision 7 — a file whose title names an existing page merges into it.
  'data.importResultUpdated_one': '{{count}} existing page updated',
  'data.importResultUpdated_other': '{{count}} existing pages updated',
  'data.importResultUpToDate_one': '{{count}} existing page already up to date',
  'data.importResultUpToDate_other': '{{count}} existing pages already up to date',
  'data.importMergeTitle_one': 'Update an existing page?',
  'data.importMergeTitle_other': 'Update {{count}} existing pages?',
  'data.importMergeDescription_one':
    'A file has the title of this page, so the import updates it in place: changed lines update their blocks, new lines add blocks, and lines missing from the file go to the Trash. Undo on the page reverts the update.',
  'data.importMergeDescription_other':
    'These files have the titles of existing pages, so the import updates each in place: changed lines update their blocks, new lines add blocks, and lines missing from a file go to the Trash. Undo on a page reverts its update.',
  'data.importMergeConfirm': 'Update and import',
  // #6554 — which space's pages the question is about, in a restore of several.
  'data.importMergeSpace': 'In the space {{name}}:',
  // #6554 — a folder pick of an unzipped Export all spaces ZIP restores each space.
  'data.importVaultTitle_one': 'Restore {{count}} space?',
  'data.importVaultTitle_other': 'Restore {{count}} spaces?',
  'data.importVaultDescription':
    'This folder is an export of every space. Each space’s notes and property definitions import into the space of its name, which is created when there is none; the active space stays as it is. History, block ids and the Trash are not restored.',
  'data.importVaultConfirm': 'Restore spaces',
  'data.importVaultExisting': '{{name}}: imported into the existing space',
  'data.importVaultNew': '{{name}}: created',
  'data.importSpaceCreateFailed': 'the space could not be created: {{reason}}',
  'data.importMergeCheckFailed':
    'The import did not run: the pages it would update could not be read: {{reason}}',
  'data.importShowAll': 'Show all',
  'data.importShowLess': 'Show less',
  // Accessible names for the two progress bars (#1929).
  'data.importFileProgressLabel': 'File import progress',
  'data.importBlockProgressLabel': 'Block import progress',
  'data.exportTitle': 'Export all pages',
  'data.exportDesc': 'Download all pages as a ZIP of Markdown files.',
  'data.exportButton': 'Export this space',
  'data.exportCurrentSpaceLabel': 'Current space',
  'data.exportAllSpacesLabel': 'All spaces',
  'data.exporting': 'Exporting...',
  'data.exportSuccess': 'Export complete',
  'data.exportFailed': 'Export failed',
  // #2965 — partial-export warning: some pages/attachments were skipped but
  // the ZIP (with an `.agaric/export-report.txt` ledger) still downloaded.
  'data.exportPartial': 'Export finished with some items skipped: {{detail}}',
  'data.exportSkippedPages_one': '{{count}} page skipped',
  'data.exportSkippedPages_other': '{{count}} pages skipped',
  'data.exportSkippedAttachments_one': '{{count}} attachment skipped',
  'data.exportSkippedAttachments_other': '{{count}} attachments skipped',
  // #2964 — whole-vault "Export all spaces" action: every space's pages in
  // one ZIP, one top-level folder per space. Separate from the
  // `data.export*` keys above, which only ever cover the active space.
  'data.exportAllSpacesDesc': 'Download every space as a single ZIP, with one folder per space.',
  'data.exportAllSpacesButton': 'Export all spaces',
  'data.exportingAllSpaces': 'Exporting all spaces...',
  'data.exportAllSpacesSuccess_one': 'Exported {{count}} space',
  'data.exportAllSpacesSuccess_other': 'Exported {{count}} spaces',
  'data.exportAllSpacesFailed': 'Export failed',
  // #6538 — shown instead of any file save on Android, where nothing writes it.
  'data.fileSaveUnavailableAndroid':
    "Agaric can't save files on Android yet. To get notes or files off this phone, sync it with a computer and export there.",
  // #6554 — the daily snapshot row: when the last copy of the database was
  // taken, and on desktop the folder that holds the copies.
  'data.snapshotLabel': 'Daily snapshot',
  'data.snapshotDesc':
    'Once a day Agaric saves a copy of its database beside it and keeps the most recent ones. They are a safety net, not a restore button.',
  'data.snapshotLast': 'Last snapshot: {{time}}',
  'data.snapshotNone': 'No snapshot yet. The first is taken shortly after Agaric starts.',
  'data.snapshotUnreadable': 'The time of the last snapshot could not be read.',
  'data.snapshotOpenFolder': 'Open folder',
  'data.snapshotOpenFolderFailed': 'Could not open the data folder',
  // #5363 — the Markdown mirror: one `.md` file per page in a folder this
  // device writes to. A file edited elsewhere is read back into its page.
  'data.mirrorTitle': 'Markdown mirror',
  'data.mirrorDesc':
    'Agaric writes every page as a .md file into a folder you choose and keeps it up to date. A file you edit elsewhere is read back into its page, and one Undo reverts that.',
  'data.mirrorFolderLabel': 'Mirror folder',
  'data.mirrorUnsupported':
    'Not on this device yet: the mirror runs in the desktop app only. Turn it on on your computer; notes written here reach its folder by sync.',
  'data.mirrorOff': 'Off. No folder chosen.',
  'data.mirrorChooseButton': 'Choose folder…',
  'data.mirrorTurnOffButton': 'Turn off',
  'data.mirrorFailed': 'The mirror folder was not changed: {{reason}}',
  'data.mirrorPaused': 'Paused: {{reason}}',
  'data.mirrorDivergedHeading': 'Changed outside Agaric; not read in yet',
  'data.mirrorDivergedNone': 'No file has changed outside Agaric.',
  'data.mirrorFailedHeading': 'Could not be written or read',
  'data.mirrorIngestedWarnings_one': '{{path}} was read in with a warning: {{first}}',
  'data.mirrorIngestedWarnings_other': '{{path}} was read in with {{count}} warnings: {{first}}',
  'data.mirrorFailedItem': '{{path}}: {{message}}',
  'data.mirrorReadBackLabel': 'Read changes back',
  'data.mirrorReadBackDesc':
    'Edits, new files, renames and moves made to the files outside Agaric are read back into Agaric. Off, Agaric still writes the files and never overwrites one changed elsewhere.',
  'data.mirrorReadBackFailed': 'Reading changes back was not changed: {{reason}}',
  'data.mirrorSpacesHeading': 'Spaces mirrored',
  'data.mirrorSpaceFailed': 'Which spaces are mirrored was not changed: {{reason}}',
  'data.mirrorCopyFilesLabel': 'Copy attachments into the folder',
  'data.mirrorCopyFilesDesc':
    'Images and files your pages link are copied into an assets folder beside them, and the pages link the copies. A copy you change there is kept and listed below.',
  'data.mirrorCopyFilesFailed': 'Copying attachments was not changed: {{reason}}',
  'data.mirrorReadPendingTitle': 'Read in what changed?',
  'data.mirrorReadPendingDesc_one':
    'This file changed outside Agaric while reading back was off. Turning it on reads it in.',
  'data.mirrorReadPendingDesc_other':
    'These {{count}} files changed outside Agaric while reading back was off. Turning it on reads them in.',
  'data.mirrorReadPendingConfirm': 'Read them in',
  'data.mirrorReadPendingCancel': 'Keep it off',
  // The vault genuinely has no spaces at all — distinct from a space that
  // simply has no pages, so an empty ZIP is never downloaded silently.
  'data.exportAllSpacesNoSpaces': 'No spaces to export',
  // #4886 — the reconciliation oracle, in Settings › App health (#5360). It
  // rebuilds every derived table (page counts, links, tags, the agenda) from
  // your notes and reports the rows that disagree. The sweep reads the whole
  // vault, so it only ever runs when the user presses Run.
  'integrity.title': 'Integrity check',
  'integrity.description':
    'Rebuilds page counts, links, tags, and the agenda from your notes and reports any row that disagrees. It only reads your notes, and can take a while on a large vault.',
  'integrity.runButton': 'Run check',
  'integrity.running': 'Checking…',
  'integrity.resultLabel': 'Integrity check result',
  'integrity.runFailed': 'Integrity check failed',
  'integrity.cleanTitle': 'Everything matches',
  'integrity.cleanDetail_one':
    'Rebuilt every derived table from {{count}} block on {{date}} and found no differences.',
  'integrity.cleanDetail_other':
    'Rebuilt every derived table from {{count}} blocks on {{date}} and found no differences.',
  'integrity.divergedSummary_one':
    '{{count}} row does not match a fresh rebuild ({{blocks}} blocks checked, {{date}}).',
  'integrity.divergedSummary_other':
    '{{count}} rows do not match a fresh rebuild ({{blocks}} blocks checked, {{date}}).',
  'integrity.artefactLine_one': '{{count}} row diverged in {{artefact}}',
  'integrity.artefactLine_other': '{{count}} rows diverged in {{artefact}}',
  'integrity.sampleKeys': 'Examples: {{keys}}',
  'integrity.copyButton': 'Copy for a bug report',
  'integrity.copied': 'Integrity report copied',
  'integrity.copyFailed': 'Could not copy the integrity report',
  'integrity.reportTitle_one': 'Integrity check: {{count}} divergence',
  'integrity.reportTitle_other': 'Integrity check: {{count}} divergences',
  // #6488 — the report in plain words. A divergence outside `engine.*` is a
  // cache the app derives from your notes and can rebuild; an `engine.*` one
  // is the database disagreeing with the sync engine, which no rebuild fixes.
  'integrity.summaryRebuildableOneTable_one':
    '{{count}} row in {{table}} is out of date (rebuildable).',
  'integrity.summaryRebuildableOneTable_other':
    '{{count}} rows in {{table}} are out of date (rebuildable).',
  'integrity.summaryRebuildable_one':
    '{{count}} row in {{tables}} caches is out of date (rebuildable).',
  'integrity.summaryRebuildable_other':
    '{{count}} rows in {{tables}} caches are out of date (rebuildable).',
  'integrity.summaryEngine_one': '{{count}} row disagrees with the sync engine.',
  'integrity.summaryEngine_other': '{{count}} rows disagree with the sync engine.',
  'integrity.summaryScanned_one': '{{count}} block checked on {{date}}.',
  'integrity.summaryScanned_other': '{{count}} blocks checked on {{date}}.',
  'integrity.groupRebuildableTitle': 'Out-of-date caches (rebuildable)',
  'integrity.groupRebuildableDetail':
    'These tables are copies the app builds from your notes, and they fell behind, usually after an update changed how they are built. Rebuilding them from your notes is safe and loses nothing.',
  'integrity.groupRebuildableAction':
    'Copy the report first if you want to report it, then rebuild.',
  'integrity.groupEngineTitle': 'Disagreements with the sync engine',
  'integrity.groupEngineDetail':
    'Your notes database and the sync engine hold different versions of these rows. A rebuild does not fix this, and syncing can spread either version.',
  'integrity.groupEngineAction': 'Copy the report and file a bug before you sync again.',
  'integrity.summaryIds_one':
    '{{count}} block has an id in a non-standard form (bulk Trash actions skip it).',
  'integrity.summaryIds_other':
    '{{count}} blocks have ids in a non-standard form (bulk Trash actions skip them).',
  'integrity.groupIdsTitle': 'Blocks with ids in a non-standard form',
  'integrity.groupIdsDetail':
    'These blocks were stored under an id written differently from the standard form, likely by an older version. Bulk Trash actions such as Empty trash and Restore all skip them. A rebuild does not change ids.',
  'integrity.groupIdsAction': 'Copy the report and file a bug so the repair can be decided.',
  'integrity.problem.idForm': 'ids in a non-standard form',
  'integrity.table.search': 'Search index',
  'integrity.table.pages': 'Pages list',
  'integrity.table.pageLinks': 'Links between pages',
  'integrity.table.blockLinks': 'Links between blocks',
  'integrity.table.unresolvedLinks': 'Links waiting for their target',
  'integrity.table.inlineTags': 'Inline tags',
  'integrity.table.inheritedTags': 'Inherited tags',
  'integrity.table.tags': 'Tags list',
  'integrity.table.agenda': 'Agenda',
  'integrity.table.projectedAgenda': 'Repeating tasks in the agenda',
  'integrity.table.attachmentFiles': 'Attachment files',
  'integrity.table.blockPlacement': 'Page and space of each block',
  'integrity.table.spaces': 'Spaces list',
  'integrity.table.blocks': 'Blocks',
  'integrity.table.attachments': 'Attachments',
  'integrity.table.blockTags': 'Tags on blocks',
  'integrity.table.pageAliases': 'Page aliases',
  'integrity.table.properties': 'Properties',
  'integrity.table.propertyDefinitions': 'Property definitions',
  'integrity.tableInline.search': 'the search index',
  'integrity.tableInline.pages': 'the pages list',
  'integrity.tableInline.pageLinks': 'the links between pages',
  'integrity.tableInline.blockLinks': 'the links between blocks',
  'integrity.tableInline.unresolvedLinks': 'the links waiting for their target',
  'integrity.tableInline.inlineTags': 'the inline tags',
  'integrity.tableInline.inheritedTags': 'the inherited tags',
  'integrity.tableInline.tags': 'the tags list',
  'integrity.tableInline.agenda': 'the agenda',
  'integrity.tableInline.projectedAgenda': 'the repeating tasks in the agenda',
  'integrity.tableInline.attachmentFiles': 'the attachment files',
  'integrity.tableInline.blockPlacement': 'the page and space of each block',
  'integrity.tableInline.spaces': 'the spaces list',
  'integrity.problem.olderStrip': 'text indexed with an older rule',
  'integrity.problem.duplicate': 'blocks indexed more than once',
  'integrity.problem.rows': 'rows missing or left behind',
  'integrity.problem.counts': 'counts out of date',
  'integrity.problem.sortKey': 'sort order out of date',
  'integrity.problem.values': 'values out of date',
  'integrity.problem.engineRows': 'rows only one side holds',
  'integrity.problem.engineValues': 'values that differ from the sync engine',
  'integrity.sampleExpected': 'Expected: {{value}}',
  'integrity.sampleActual': 'Found: {{value}}',
  'integrity.sampleIdForm': 'Found: {{found}} (expected {{expected}})',
  'integrity.sampleKeysMore_one': 'Examples: {{keys}} and {{count}} more',
  'integrity.sampleKeysMore_other': 'Examples: {{keys}} and {{count}} more',
  'integrity.rebuildButton': 'Rebuild caches',
  'integrity.rebuilding': 'Rebuilding…',
  'integrity.rebuilt': 'Caches rebuilt',
  'integrity.rebuildFailed': 'Could not rebuild the caches',
  'help.reportBugTitle': 'Report a bug',
  'help.reportBugDescription':
    'Found a problem? Send us what happened and — if you like — the recent logs from your device.',
  'help.reportBugButton': 'Report a bug',
  'help.updateTitle': 'Updates',
  'help.updateDescription':
    'Agaric checks for updates automatically when it starts. You can also check manually.',
  'help.updateCheckNowButton': 'Check for updates now',
  'help.updateCheckingLabel': 'Checking...',
  'help.updateLastCheckedLabel': 'Last checked {{ago}}',
  'help.updateLastCheckedNever': 'Never checked',
  'help.updateUpToDateLabel': 'Up to date (v{{version}})',
  'help.updateUpToDateLabelNoVersion': 'Up to date',
  'help.updateAvailableStatus': 'Update available: v{{version}}',
  'help.updateCheckFailedLabel': 'Last check failed: {{error}}',
  'help.updateAvailableToast': 'Agaric {{version}} is available',
  'help.updateInstallActionLabel': 'Install & restart',
  'help.updateLaterActionLabel': 'Later',
  'help.updateNoneFoundToast': "You're on the latest version",
  'help.updateInstallFailedToast': 'Update install failed',
  'help.updateMobileHint':
    "Agaric does not update itself on Android. Install the newest APK from Agaric's GitHub releases page.",
  'help.updateOpenReleasesButton': 'Open releases page',
  'spaceSwitcher.shortcutHint': 'Tip: Alt+1–9 to switch spaces',
  'spaceSwitcher.createAnotherHint': 'Create another space\u2026',

  // \u2014 in-page find toolbar.
  'findInPage.toolbarLabel': 'Find in page',
  'findInPage.inputPlaceholder': 'Find in page\u2026',
  'findInPage.inputLabel': 'Find in page',
  'findInPage.toggleCaseSensitive': 'Match case (Aa)',
  'findInPage.toggleWholeWord': 'Match whole word (Ab|)',
  'findInPage.toggleRegex': 'Regular expression (.*)',
  'findInPage.previousMatch': 'Previous match (Shift+F3)',
  'findInPage.nextMatch': 'Next match (F3)',
  'findInPage.close': 'Close (Esc)',
  'findInPage.counter': '{{current}} of {{total}}',
  'findInPage.counterEmpty': '0 of 0',
  'findInPage.regexTooLong': 'Pattern is too long (max 1 KB).',
  'findInPage.regexInvalid': 'Invalid regex: {{message}}',
  'findInPage.regexTooSlow': 'Pattern is too slow — try a simpler expression.',
  'findInPage.skippedLongPassages_one': '{{count}} long passage skipped',
  'findInPage.skippedLongPassages_other': '{{count}} long passages skipped',
  'findInPage.toggleReplace': 'Replace (Ctrl+H)',
  'findInPage.replaceInputLabel': 'Replace with',
  'findInPage.replacePlaceholder': 'Replace with\u2026',
  'findInPage.replaceOne': 'Replace',
  'findInPage.replaceOneHint': 'Replace this match, then go to the next (Enter)',
  'findInPage.replaceAll': 'Replace all',
  'findInPage.replaceAllHint': 'Replace every match in the page (Ctrl+Alt+Enter)',
  'findInPage.replacing': 'Replacing',
  'findInPage.replaceUnavailable': 'Replace is not available in this view',
  'findInPage.unreplaceable_one':
    '{{count}} match is in a link, tag or block reference and will be left as it is',
  'findInPage.unreplaceable_other':
    '{{count}} matches are in a link, tag or block reference and will be left as they are',
  'findInPage.replaced_one': 'Replaced {{count}} match',
  'findInPage.replaced_other': 'Replaced {{count}} matches',
  'findInPage.replaceSkipped_one': '{{count}} in a link, tag or reference left as it is',
  'findInPage.replaceSkipped_other': '{{count}} in links, tags or references left as they are',
  'findInPage.replaceFailed_one': 'A save failed: stopped after {{count}} replaced',
  'findInPage.replaceFailed_other': 'A save failed: stopped after {{count}} replaced',
  'announce.findInPageOpened': 'Find in page opened',
  // Desktop header button that opens the Ctrl+K palette; the shortcut shows in its tooltip.
  'headerSearch.label': 'Search',
  // Mobile unified search sheet. The single touch entry point
  // collapses Ctrl+F (in-page find) + Cmd+K (palette) + Ctrl+Shift+F
  // (find-in-files) into one sheet with two segments. The in-page
  // Segment embeds the toolbar; the all-pages segment embeds
  // The palette with its existing escalation footer routing
  // to the find-in-files view.
  'searchSheet.openButton': 'Search',
  'searchSheet.title': 'Search',
  'searchSheet.dialogDescription':
    'Search within the current page or across all pages. Use the segment toggle to switch scope.',
  'searchSheet.segmentInPage': 'This page',
  'searchSheet.segmentAllPages': 'All pages',
  'searchSheet.emptyInPage': 'No page open yet — try All pages instead.',
  'searchSheet.emptyInPageSwitchCta': 'Switch to All pages',
  // The mobile escalation is a prominent, two-line
  // CTA (title + hint) rather than a muted footer row, so touch users
  // discover that filters / regex / history live in the full search
  // view. `escalateLabel` is the descriptive aria-label for the button;
  // `escalateCtaTitle` / `escalateCtaHint` are the visible two lines.
  'searchSheet.escalateCtaHint': 'Open full search',
  'searchSheet.escalateCtaTitle': 'Filters & regex',
  'searchSheet.escalateLabel': 'Open full search for filters, regex, and history',
  // #899 mobile-search polish batch.
  // #133 — pull-to-dismiss grab handle.
  'searchSheet.dragHandleLabel': 'Drag down to close search',
  // #135 — long-press a scope to pin it as the default; aria hint + toasts.
  'searchSheet.scopePinHint': 'Long-press a scope to pin it as your default',
  'searchSheet.scopePinned': 'Pinned “{{scope}}” as your default search scope',
  'searchSheet.scopeUnpinned': 'Unpinned default search scope',
  'searchSheet.scopePinnedBadge': 'Pinned default',
  // #131 — recent searches empty-state list.
  'searchSheet.recentSearchesTitle': 'Recent searches',
  'searchSheet.recentSearchesClear': 'Clear',
  'searchSheet.recentSearchRunLabel': 'Search again for “{{term}}”',
  // #2943 — dnd-kit screen-reader announcements for block drag-and-drop.
  // `DndContext`'s `accessibility` prop wires these in place of dnd-kit's
  // default announcements, which read the raw block ULID. `{{block}}` /
  // `{{target}}` resolve to the dragged/over block's trimmed content, or
  // `dnd.genericBlock` when that content is empty.
  'dnd.genericBlock': 'block',
  'dnd.pickedUp': 'Picked up {{block}}.',
  'dnd.movedOver': '{{block}} moved over {{target}}.',
  'dnd.movedOutside': '{{block}} is no longer over a drop target.',
  'dnd.dropped': '{{block}} dropped over {{target}}.',
  'dnd.droppedOutside': '{{block}} dropped.',
  'dnd.cancelled': 'Dragging {{block}} cancelled.',
  'dnd.screenReaderInstructions':
    'To pick up a block, press space or enter. While dragging, use the arrow keys to move the block up, down, or change its indent level. Press space or enter again to drop the block in its new position, or press escape to cancel.',
}
