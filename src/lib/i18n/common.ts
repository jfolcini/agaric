/**
 * i18n namespace: common
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const common: Record<string, string> = {
  // Translators: BootGate, the full-screen screen shown while Agaric starts: the loading text,
  // and the heading of the error screen shown when startup fails.
  'boot.starting': 'Starting Agaric\u2026',
  'boot.failedToStart': 'Failed to start',

  // Translators: toast (brief pop-up) at startup: unsaved typing from before the app last closed
  // was recovered; {{count}} = number of recovered drafts.
  'boot.recoveredDrafts_one': 'Recovered {{count}} unsaved draft',
  'boot.recoveredDrafts_other': 'Recovered {{count}} unsaved drafts',

  // Translators: BootGate startup-error screen: a small link-style toggle that shows or hides the
  // technical error details, and a button that copies them ("Copied!" briefly replaces its label).
  'boot.showDetailsButton': 'Show details',
  'boot.hideDetailsButton': 'Hide details',
  'boot.copyDiagnosticsLabel': 'Copy diagnostics',
  'boot.copiedLabel': 'Copied!',

  // Translators: warning toast at startup that stays until the user closes it.
  // #1255: boot op-log replay failure — the materialized view may be
  // stale/incomplete. Surfaced as a persistent warning so the user knows
  // before layering more edits on top (nothing is lost — the op log is
  // canonical — but a restart usually re-runs recovery cleanly).
  'boot.recoveryDegradedBody':
    'A startup recovery step did not finish, so recent edits may not appear yet. Your data is safe — restarting Agaric usually fixes this. Avoid making large edits until it is resolved.',

  // Translators: warning toast at startup that stays until closed, with a "Review" button that
  // opens Settings › Sync & devices; {{count}} = number of changes received from another device.
  // #6057: shown only on the boot that moved inbound sync deltas to quarantine.
  'boot.syncQuarantinedBody_one':
    '{{count}} change from another device could not be applied. It has been kept, not lost.',
  'boot.syncQuarantinedBody_other':
    '{{count}} changes from another device could not be applied. They have been kept, not lost.',

  // Translators: error message on the BootGate startup-error screen, under "Failed to start".
  // A space is a separate set of pages, such as "Personal" or "Work".
  // #2921 — generic fallback shown on the BootGate error screen when
  // `refreshAvailableSpaces()` hard-fails during boot (no prior snapshot)
  // and the caught value carries no readable message of its own.
  'boot.spacesLoadFailed': 'Could not load your spaces. Check your connection and try again.',

  // Translators: names of the app's main views: Sidebar (left navigation) items, view titles, and
  // inserted as {{view}} in announce.navigatedTo. Short nouns. "Journal" = dated daily notes;
  // "Trash" = deleted items; "History" = log of every edit; "Graph" = map of links between pages.
  'sidebar.pages': 'Pages',
  'sidebar.journal': 'Journal',
  // Translators: button at the top of the Sidebar that creates a new page.
  'sidebar.newPage': 'New page',
  // Translators: screen-reader label of the Sidebar footer icon button that syncs now with the
  // user's other paired devices (an action).
  'sidebar.sync': 'Sync',
  'sidebar.search': 'Search',
  'sidebar.tags': 'Tags',
  'sidebar.trash': 'Trash',
  'sidebar.history': 'History',
  'sidebar.templates': 'Templates',
  'sidebar.graph': 'Graph',
  'sidebar.query': 'Advanced query',

  // Translators: Sidebar header icon button (tooltip and screen-reader label) that shrinks the
  // Sidebar to an icon strip or widens it again; on phones it closes the navigation drawer.
  'sidebar.collapseSidebar': 'Collapse sidebar',
  'sidebar.expandSidebar': 'Expand sidebar',

  // Translators: screen-reader label and tooltip of the controls that show or hide the Sidebar,
  // including its thin draggable edge.
  'sidebar.toggleSidebar': 'Toggle sidebar',

  // Translators: screen-reader label of the ☰ button in the phone header that opens the
  // navigation drawer.
  // Accessible name for the mobile header hamburger. Deliberately NOT
  // `sidebar.toggleSidebar` ("Toggle Sidebar"): on a phone there is no
  // visible sidebar to "toggle", the control opens a navigation drawer, and
  // "menu" is the word touch users are scanning the header for.
  'sidebar.openMenu': 'Open navigation menu',

  // Translators: header buttons that return to the previous / next view visited, like a web
  // browser's Back and Forward. "Back" is also a button in a property dialog.
  'nav.back': 'Back',
  'nav.forward': 'Forward',

  // Translators: tooltip of the "New Page" button when the Sidebar is shrunk to icons; keep the
  // keyboard shortcut "(Ctrl+N)" as is.
  'sidebar.newPageTooltip': 'New page (Ctrl+N)',

  // Translators: Sidebar footer sync button: label and tooltip when the device has no network
  // ("Offline", adjective), its default tooltip, and its tooltip while a sync runs.
  'sidebar.offline': 'Offline',
  'sidebar.syncTooltip': 'Sync all devices',
  'sidebar.syncing': 'Syncing...',

  // Translators: Sidebar "Bookmarks" section, listing the pages the user bookmarked: its heading
  // and the hint shown while it is empty.
  // #4713 — the sidebar Bookmarks section over the one bookmark list.
  'bookmarks.title': 'Bookmarks',
  'bookmarks.emptyHint': 'Bookmark a page to keep it here.',
  // Translators: screen-reader label of a bookmark's remove button; {{title}} = the page title.
  'bookmarks.remove': 'Remove {{title}} from bookmarks',
  // Translators: error toast when saving a change to the bookmark list fails.
  'bookmarks.writeFailed': 'Could not save your bookmarks. The list was restored.',
  // Translators: screen-reader instructions read when a bookmark gets keyboard focus; "space",
  // "escape", "enter" and the arrow keys are keyboard keys.
  'bookmarks.reorderInstructions':
    'To reorder a bookmark, press space to pick it up, use the up and down arrow keys to move it, and press space again to drop it. Press escape to cancel. Press enter to open the page.',

  // Translators: SpaceSwitcher, the dropdown at the top of the Sidebar that picks the active space
  // (a separate set of pages, e.g. "Personal" or "Work"): its screen-reader label / placeholder,
  // and its last item, which opens Settings › Spaces.
  'space.switch': 'Switch space',
  'space.manage': 'Manage spaces…',

  // Translators: moving a page to another space: a PageHeader kebab (⋮) menu item that expands into
  // the list of spaces, then a success toast ({{space}} = target space name) or an error toast.
  'space.moveTo': 'Move to space',
  'space.movedToast': 'Page moved to {{space}}',
  'space.moveFailed': 'Failed to move page',

  // Translators: ConfirmDialog before moving a page to a space that defines some of its properties
  // (typed fields) differently, so their values are removed; {{space}} = target space name.
  'spaceMove.lossTitle': 'Move and remove properties?',
  'spaceMove.lossDescription':
    '{{space}} does not define these properties the same way, so the move removes their values. Undo puts them back.',
  'spaceMove.lossConfirm': 'Move and remove',
  // Translators: note in that dialog when the list changed after the user confirmed.
  'spaceMove.lossChanged': 'Something changed since you confirmed. Check the list again.',
  // Translators: screen-reader label of the list of properties in that dialog.
  'spaceMove.lossListLabel': 'Properties the move removes',
  // Translators: chip (very short) beside each property; {{count}} = number of values removed.
  'spaceMove.valueCount_one': '{{count}} value',
  'spaceMove.valueCount_other': '{{count}} values',
  // Translators: small badge on a value whose block is in the Trash; also in the property
  // type-change dialogs.
  'spaceMove.inTrash': 'In Trash',
  // Translators: error shown in place of the list of values when it cannot be loaded; also in the
  // property type-change dialogs.
  'spaceMove.valuesFailed': 'Could not load the values',

  // Translators: error toast when an action needs the active space but spaces are still loading.
  'space.notReady': 'Loading spaces…',

  // Translators: warning toast; {{space}} = name of the space the app switched to.
  'space.activeDeletedNotification':
    'Your active space was deleted on another device. Switched to {{space}}.',

  // Translators: Settings › Spaces (SpacesTab), one row per space: label of the name field, label
  // of the color picker (the code adds ":" after it), and the screen-reader label of each color
  // swatch; {{color}} = an English color name such as "blue".
  'space.renameLabel': 'Rename space',
  'space.accentColorLabel': 'Accent color',
  'space.accentSwatchLabel': 'Use {{color}} accent',

  // Translators: Settings › Spaces, delete (trash-can) button of a space: screen-reader label,
  // the reasons and a hint explaining why it is disabled, the screen-reader label of the (i)
  // button beside it that shows the reason, its ConfirmDialog ({{name}} = the space name), and
  // an error toast.
  'space.deleteSpaceLabel': 'Delete space',
  'space.deleteSpaceTooltipDisabled':
    'Delete every page in this space first — spaces can only be deleted when empty.',
  'space.deleteSpaceInlineHint': 'Move or delete the pages in this space first to enable deletion.',
  'space.deleteLastTooltipDisabled':
    'You must keep at least one space — delete is disabled on the last remaining space.',
  'space.deleteDisabledInfo': 'Why this space cannot be deleted',
  'space.deleteConfirmTitle': "Delete space '{{name}}'?",
  'space.deleteConfirmDescription': 'This space must already be empty. This cannot be undone.',
  'space.deleteFailed': 'Failed to delete space',

  // Translators: error toasts in Settings › Spaces.
  'space.renameFailed': 'Failed to rename space',
  'space.accentFailed': 'Failed to update accent color',

  // Translators: Settings › Spaces: "Create new space" button that opens a form (name field with
  // a placeholder, color picker, Cancel and Create buttons), and an error toast. The Cancel label
  // is also the cancel button of the delete-space dialog.
  'space.createSpaceLabel': 'Create new space',
  'space.createSpaceCta': 'Create',
  'space.createSpaceFailed': 'Failed to create space',
  'space.newSpacePlaceholder': 'New space name',
  'space.cancelLabel': 'Cancel',

  // Translators: SpaceAccentBadge, the colored space indicator shown when the Sidebar is shrunk to
  // icons; a click switches to the next space. Screen-reader label, then tooltip;
  // {{name}} = the space name.
  'space.accentBadge': '{{name}} space — click to switch',

  // Translators: generic action labels reused across the app (buttons in dialogs, toolbars, toasts
  // and error screens); keep them short. "Add block" appends an empty block to a page.
  'action.addBlock': 'Add block',
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.delete': 'Delete',
  'action.undo': 'Undo',
  'action.redo': 'Redo',
  'action.retry': 'Retry',
  'action.dismiss': 'Dismiss',
  // Translators: button on a startup warning toast that opens the settings page to review it.
  'action.review': 'Review',
  'action.reload': 'Reload',
  // Translators: button under a list that loads more items; "Loading…" replaces it meanwhile.
  'action.loadMore': 'Load more',
  'action.loading': 'Loading\u2026',
  // Translators: screen-reader label of the × button that empties a search field (verb).
  'action.clear': 'Clear',

  // Translators: Announcer: live announcements, spoken by the screen reader after an action and
  // never seen. These follow Journal shortcuts that go to the previous / next period, or to today.
  'announce.navigatedToPrevious': 'Navigated to previous day/week/month',
  'announce.navigatedToNext': 'Navigated to next day/week/month',
  'announce.jumpedToToday': 'Jumped to today',

  // Translators: Announcer (spoken by the screen reader) after a new page is created.
  'announce.newPageCreated': 'New page created',

  // Translators: Announcer (spoken) after switching views; {{view}} = a view name such as
  // "Search" or "Pages" (the sidebar.* names).
  // #2944 — single announcement for every `currentView` switch (palette
  // `go-<view>` commands, sidebar clicks, keyboard shortcuts), replacing
  // the one-off `announce.searchOpened` that only the `focusSearch`
  // shortcut used. `{{view}}` is the localized nav-item label (e.g.
  // `sidebar.search`, `sidebar.pages`).
  'announce.navigatedTo': 'Navigated to {{view}}',

  // Translators: Announcer (spoken) after the "repeat last command" shortcut re-runs the last
  // command-palette command, and after Escape closes every open popup and dialog.
  // Phase 8 — runLastCommand global shortcut announcement.
  'announce.ranLastCommand': 'Re-ran last command',
  'announce.overlaysClosed': 'Overlays closed',

  // Translators: Announcer (spoken) when a block enters editing; {{preview}} = the first 50
  // characters of its text, or "empty block" when it has none (inserted mid-sentence: lowercase).
  'announce.editingBlock': 'Editing block: {{preview}}',
  'announce.emptyBlock': 'empty block',

  // Translators: Announcer (spoken) after block actions in the editor; indented / outdented =
  // moved one level deeper / shallower in the outline.
  'announce.blockDeleted': 'Block deleted',
  'announce.blockIndented': 'Block indented',
  'announce.blockDedented': 'Block outdented',
  'announce.blockCreated': 'Block created',
  'announce.blockMovedUp': 'Block moved up',
  'announce.blockMovedDown': 'Block moved down',

  // Translators: Announcer (spoken) when moving, indenting or outdenting a block failed.
  // R6 (#405): announced when a move/indent fails so assistive tech does not
  // report a phantom success. Paired with the toast in the store action.
  'announce.moveFailed': 'Move failed',

  // Translators: Announcer (spoken) after a block's nested children are hidden / shown again.
  'announce.blockCollapsed': 'Block collapsed',
  'announce.blockExpanded': 'Block expanded',

  // Translators: Announcer (spoken) after a block's task state, priority or scheduled date changes;
  // {{state}} = a task state such as "To do" (or "none"); {{level}} = "High", "Medium", "Low" or
  // "none", in English; {{date}} = a date written 2026-06-17.
  'announce.taskState': 'Task state: {{state}}',
  'announce.prioritySet': 'Priority set to {{level}}',
  'announce.scheduledDateSet': 'Scheduled date set to {{date}}',

  // Translators: Announcer (spoken) in the PairingDialog (linking a new device) as the pairing
  // session nears its end; {{seconds}} = seconds left.
  'announce.pairingCountdown': 'Pairing session expires in {{seconds}} seconds',
  'announce.pairingCountdownMinute': 'Pairing session expires in 1 minute',
  'announce.pairingExpired': 'Pairing session expired',

  // Translators: Announcer (spoken) in the PairingDialog as pairing goes on or fails; the
  // passphrase is the words the user enters on both devices to confirm.
  // #3469 — waiting-state transitions, announced once per transition (not
  // per tick) so screen-reader users learn the outcome without being spammed.
  'announce.pairingWaiting': 'Waiting for the other device to confirm pairing',
  'announce.pairingProofRejected': 'Pairing passphrase did not match',
  'announce.pairingWaitTimedOut': 'Pairing timed out waiting for the other device',

  // Translators: Announcer (spoken) when blocks are selected in the editor; {{count}} = number of
  // selected blocks.
  'announce.blocksSelected_one': '{{count}} block selected',
  'announce.blocksSelected_other': '{{count}} blocks selected',
  'announce.selectionCleared': 'Selection cleared',

  // Translators: Announcer (spoken) in the History view (log of every edit) after undoing selected
  // changes or restoring to an earlier point; {{count}} = number of changes ("operations").
  'announce.opsReverted_one': '{{count}} operation reverted',
  'announce.opsReverted_other': '{{count}} operations reverted',

  // Translators: Announcer (spoken) when a sync with the user's other devices starts.
  'announce.syncStarted': 'Sync started',

  // Translators: Announcer (spoken) when moving a task to another day (dragged onto it or picked in
  // its date picker) fails.
  'announce.rescheduleFailed': 'Reschedule failed',

  // Translators: Announcer (spoken) after a task's date is changed or removed; {{date}} = a date
  // written 2026-06-17.
  'announce.dateUpdated': 'Date updated to {{date}}',
  'announce.dateCleared': 'Date cleared',

  // Translators: Announcer (spoken) after adding or removing a page alias (another name the page
  // can be linked by) in the PageHeader.
  'announce.aliasAdded': 'Alias added',
  'announce.aliasRemoved': 'Alias removed',

  // Translators: spoken when "Read aloud" (the device reading the page out loud) is stopped or
  // reaches the end.
  'announce.readAloudStopped': 'Stopped reading aloud',
  'announce.readAloudFinished': 'Finished reading aloud',

  // Translators: block context menu (opened by right-click or long-press on a block). With several
  // blocks selected these items act on all of them; {{count}} = number of selected blocks,
  // {{state}} = a task state such as "To do".
  'contextMenu.delete': 'Delete',
  'contextMenu.deleteSelected': 'Delete {{count}} selected',
  'contextMenu.cycleTodoSelected': 'Cycle task state',
  'contextMenu.setTodoSelected': 'Set task state to {{state}}',
  'contextMenu.clearTodoSelected': 'Clear task state',
  'contextMenu.cyclePrioritySelected': 'Cycle priority',

  // Translators: block context menu items. "Move & arrange" expands a sub-list: Indent / Dedent
  // (one level deeper / shallower in the outline), Move Up / Down, Merge (into the block above).
  // Collapse / Expand hide / show the nested children; "History" lists this block's past edits.
  'contextMenu.indent': 'Indent',
  'contextMenu.dedent': 'Dedent',
  'contextMenu.moveUp': 'Move up',
  'contextMenu.moveDown': 'Move down',
  'contextMenu.merge': 'Merge with previous',
  'contextMenu.moveArrange': 'Move & arrange',
  'contextMenu.collapse': 'Collapse',
  'contextMenu.expand': 'Expand',
  'contextMenu.history': 'History',
  // Translators: screen-reader name of the block context menu, and its title on phones.
  'contextMenu.blockActions': 'Block actions',

  // Translators: block context menu item that steps the task state; it shows the change it will
  // make. TODO, DOING, DONE, CANCELLED are task keywords typed in notes: keep them as is.
  // "Clear" = no task state.
  'contextMenu.todoToDoing': 'TODO → DOING',
  'contextMenu.doingToDone': 'DOING → DONE',
  'contextMenu.doneToCancelled': 'DONE → CANCELLED',
  'contextMenu.cancelledToClear': 'CANCELLED → Clear',
  'contextMenu.setTodo': 'Set as TODO',

  // Translators: block context menu item that steps the task priority (1 = highest); it shows the
  // change it will make. "Clear" = no priority.
  'contextMenu.priority1To2': 'Priority 1 → 2',
  'contextMenu.priority2To3': 'Priority 2 → 3',
  'contextMenu.priority3ToClear': 'Priority 3 → Clear',
  'contextMenu.setPriority1': 'Set priority 1',

  // Translators: block context menu items. "Properties..." opens the BlockPropertyDrawer (side
  // panel of the block's typed fields); "Zoom in" shows only this block and its children.
  'contextMenu.properties': 'Properties...',
  'contextMenu.zoomIn': 'Zoom in',
  'contextMenu.duplicate': 'Duplicate',

  // Translators: actions on a web link (URL) in a block: a button in the link's pop-up toolbar, a
  // block context menu item, and the toasts after copying.
  'contextMenu.openLink': 'Open link',
  'contextMenu.copyUrl': 'Copy URL',
  'contextMenu.urlCopied': 'URL copied to clipboard',
  'contextMenu.copyUrlFailed': 'Failed to copy URL',

  // Translators: block context menu items that copy a reference (a link other blocks can embed) to
  // this block or to its page, and the toasts after copying.
  // #1445 — copy a Roam-style reference to this block (`((ULID))`) or its
  // containing page (`[[ULID]]`) to the clipboard for pasting elsewhere.
  'contextMenu.copyBlockRef': 'Copy block reference',
  'contextMenu.copyPageRef': 'Copy page reference',
  'contextMenu.blockRefCopied': 'Block reference copied to clipboard',
  'contextMenu.pageRefCopied': 'Page reference copied to clipboard',
  'contextMenu.copyRefFailed': 'Failed to copy reference',

  // Translators: block context menu items that copy the block's text, the block with all its nested
  // children ("subtree"), or all selected blocks; and the toasts after copying.
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

  // Translators: generic error toast when a menu or toolbar action fails.
  'contextMenu.actionFailed': 'Action failed',

  // Translators: "Turn into" submenu that changes a block's type (block context menu,
  // FormattingToolbar, Edit as Markdown toolbar), then the type names; "Text" = a plain paragraph.
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

  // Translators: navigation label for Properties, the typed fields (such as status or due date)
  // that pages and blocks can carry.
  'sidebar.properties': 'Properties',

  // Translators: title of the keyboard-shortcut reference panel (opened with "?"), and the heading
  // of its section on Markdown text syntax.
  'shortcuts.title': 'Quick reference',
  'shortcuts.syntaxSection': 'Syntax',

  // Translators: "No" answer button of a yes/no question dialog.
  'dialog.no': 'No',

  // Translators: screen-reader label of a collapsible panel header in the Journal;
  // {{section}} = the panel title, such as "Due" or "Done".
  'common.expand': 'Expand {{section}}',
  'common.collapse': 'Collapse {{section}}',

  // Translators: "(empty)" stands in for the text of a block that has none (search results, task
  // lists); "Untitled" stands in for the title of a page that has none.
  'common.empty': '(empty)',
  'common.untitled': 'Untitled',

  // Translators: sort direction, inserted as {{direction}} in backlink.sortDirectionLabel ("Sorted
  // {{direction}}, click to reverse"), so lowercase.
  // #2232 — direction tokens interpolated into translated sort aria-labels.
  'common.ascending': 'ascending',
  'common.descending': 'descending',

  // Translators: screen-reader label of a loading placeholder (grey shapes shown while content
  // loads).
  // #2232 — default label for the shared LoadingSkeleton busy region.
  'common.loading': 'Loading',

  // Translators: skip link, visible only when a keyboard user tabs to it at the top of the window.
  'accessibility.skipToMain': 'Skip to main content',

  // Translators: screen-reader name of the Sidebar (left navigation), and the hidden description of
  // the navigation drawer on phones.
  'sidebar.label': 'Sidebar',
  'sidebar.mobileDescription': 'Displays the mobile sidebar.',

  // Translators: screen-reader label of the "…" button in a breadcrumb (the page's path) that shows
  // the hidden middle parts.
  'breadcrumb.showHidden': 'Show hidden breadcrumbs',

  // Translators: "Close" = screen-reader label of the × button of dialogs and panels, also a
  // visible button in the Edit as Markdown view; "Loading…" = screen-reader label of spinners.
  'ui.close': 'Close',
  'ui.loading': 'Loading…',

  // Translators: names of the dark and light color themes.
  'sidebar.themeDark': 'Dark mode',
  'sidebar.themeLight': 'Light mode',

  // Translators: second line of the Sidebar sync button's tooltip, also in the paired-devices list;
  // {{time}} = a relative time such as "5m ago" or "just now".
  'sidebar.lastSynced': 'Last synced {{time}}',
  'sidebar.lastSyncedNever': 'Never synced',

  // Translators: relative times inserted as {{time}} / {{ago}} in "Last synced …", "Last checked …"
  // and similar lines, so "just now" is lowercase. Keep them very short; m / h / d = minutes /
  // hours / days. One form serves every {{count}}.
  'sidebar.justNow': 'just now',
  'sidebar.minutesAgo': '{{count}}m ago',
  'sidebar.hoursAgo': '{{count}}h ago',
  'sidebar.daysAgo': '{{count}}d ago',

  // Translators: WelcomeModal, the welcome dialog on first launch: title and subtitle.
  'welcome.title': 'Welcome to Agaric',
  'welcome.description': 'A local-first note-taking app for organizing your thoughts.',

  // Translators: WelcomeModal, three tips, each a short title and a description. "/", "[[" and "@"
  // are characters the user types: keep them. The "Touch" pair replaces the formatting tip on
  // phones and tablets.
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

  // Translators: WelcomeModal buttons. "Import notes" opens Settings › Data; the pair buttons open
  // Settings › Sync & devices to link another of the user's devices (the "computer" one on phones);
  // "Get Started" closes the dialog; "Create sample pages" adds two example pages.
  'welcome.importNotes': 'Import notes',
  'welcome.pairDevice': 'Pair a device',
  'welcome.pairComputer': 'Pair with your computer',
  'welcome.getStarted': 'Get started',
  'welcome.createSamplePages': 'Create sample pages',

  // Translators: toasts after "Create sample pages" succeeds or fails (the failure has a Retry
  // button).
  'welcome.samplePagesCreated': 'Sample pages created!',
  'welcome.samplePagesFailed': 'Failed to create sample pages',

  // Translators: titles and block text of the two example pages created in the user's notes. The
  // text is Markdown: keep the ** markers (bold) and the keys "?", "Ctrl+N" and "/".
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

  // Translators: name of the Settings view: Sidebar footer button and view title.
  'sidebar.settings': 'Settings',

  // Translators: screen-reader name of the strip of recently visited pages under the header.
  'recent.ariaLabel': 'Recently visited pages',

  // Translators: shown in the Sidebar Bookmarks section for a page that has no title.
  'recent.untitled': 'Untitled',

  // Translators: closing an editor tab (pages open as tabs in the TabBar above the view);
  // {{label}} = the tab's page title.
  'tabs.close': 'Close tab',
  'tabs.closeTab': 'Close tab: {{label}}',

  // Translators: opening a page in a new editor tab: error toast when the shortcut is used with no
  // page open, a menu item (block menu, right-click on a page link), and an Announcer message
  // (spoken by the screen reader) when it opens; {{title}} = the page title.
  'tabs.openInNewTabEmpty': 'No page to open in a new tab',
  'tabs.openInNewTab': 'Open in new tab',
  'tabs.openedInBackground': 'Opened {{title}} in a new tab',

  // Translators: TabBar (strip of open editor tabs above the view) and its tab-switcher pop-up:
  // fallback tab name, screen-reader names, the switcher's filter placeholder and no-match message,
  // and a hidden screen-reader marker on the current tab.
  'tabs.untitled': 'Untitled',
  'tabs.tabList': 'Editor tabs',
  'tabs.switcher': 'Switch tab',
  'tabs.switcherFilter': 'Filter open tabs',
  'tabs.switcherNoMatch': 'No open tab matches',
  'tabs.activeTab': 'Active tab',

  // Translators: names of tab actions: close the current tab, go to the next / previous tab.
  'tabs.closeActiveTab': 'Close active tab',
  'tabs.nextTab': 'Next tab',
  'tabs.previousTab': 'Previous tab',

  // Translators: screen-reader instructions read when a tab gets keyboard focus; "space", "escape"
  // and the arrow keys are keyboard keys.
  'tabs.reorderInstructions':
    'To move a tab, press space to pick it up, use the left and right arrow keys to move it, and press space again to drop it. Press escape to cancel.',

  // Translators: screen-reader label of the round floating pen button on phones that opens Quick
  // capture (jot a note straight into the journal).
  'quickCapture.fabLabel': 'Quick capture',

  // Translators: dialog shown once on phones and tablets to teach touch gestures: title, intro,
  // close button, then three rows, each a title and a description.
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

  // Translators: default buttons of ConfirmDialog; "Confirm" is also its default title.
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Confirm',

  // Translators: Settings › Data, Import card: title and description.
  'data.importTitle': 'Import',
  'data.importDesc':
    'Import Markdown, text and Org files, Logseq graphs, Obsidian vaults, Notion exports, and Evernote and Joplin notes as pages.',

  // Translators: Settings › Data, Import card: one button per source, also the screen-reader label
  // of its file picker. Keep product names (Obsidian, Evernote, Joplin) and file extensions.
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
  // Translators: error toast; {{name}} = the picked file's name.
  // #1282 — a `.enex` file whose XML could not be parsed.
  'data.importEnexParseFailed': 'Could not read {{name}}: not a valid Evernote export.',
  // #2513 (part 2) — fourth affordance: import Joplin `.jex` archives. Each note
  // in the archive becomes its own page (Markdown, frontend-only).
  'data.importJexButton': 'Import Joplin (.jex)',
  // Translators: error toast; {{name}} = the picked file's name.
  // #2513 (part 2) — a `.jex` archive whose tar could not be read / had no notes.
  'data.importJexParseFailed': 'Could not read {{name}}: not a valid Joplin export.',

  // Translators: warnings listed in the import result panel; {{count}} = number of links, items,
  // files, queries or tables concerned.
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
  // #6754 — a Logseq `{{query}}` with no query-block equivalent stays as a code block.
  'data.importLogseqQueriesKept_one':
    '{{count}} Logseq query has no equivalent here and was kept as a code block to rebuild.',
  'data.importLogseqQueriesKept_other':
    '{{count}} Logseq queries have no equivalent here and were kept as code blocks to rebuild.',
  // A Notion export's database table; its rows are pages of the export too.
  'data.importNotionDatabases_one':
    'Skipped {{count}} Notion database table (.csv); its rows import as pages.',
  'data.importNotionDatabases_other':
    'Skipped {{count}} Notion database tables (.csv); their rows import as pages.',

  // Translators: Settings › Data, Import card: button that imports a bibliography (list of cited
  // references); keep ".bib/.json".
  // #1454 — fifth affordance: import a BibTeX (`.bib`) or CSL-JSON
  // (`.json`) bibliography. One reference page per entry.
  'data.importBibliographyButton': 'Import bibliography (.bib/.json)',

  // Translators: Settings › Data, Import card: label at the start of each row, naming the kind of
  // source the row's button imports.
  'data.importFilesLabel': 'Markdown, text or Org files',
  'data.importFolderLabel': 'Folder (Logseq graph, Notion export, or any Markdown folder)',
  'data.importObsidianLabel': 'Obsidian vault',
  'data.importEnexLabel': 'Evernote',
  'data.importJexLabel': 'Joplin',
  'data.importBibliographyLabel': 'Bibliography',

  // Translators: toasts after a bibliography import: success ({{count}} = pages created, one per
  // reference; {{skipped}} = entries skipped) or errors ({{name}} = the file name).
  // #1454 — success toast + result-panel summary. `count` drives the plural
  // (pages created); `skipped` is the entries the backend skipped.
  'data.importBibliographyResult_one': 'Imported {{count}} reference page ({{skipped}} skipped)',
  'data.importBibliographyResult_other': 'Imported {{count}} reference pages ({{skipped}} skipped)',
  // #1454 — picked a file whose extension maps to no bibliography format.
  'data.importBibliographyUnsupported':
    'Cannot import {{name}}: only .bib and .json bibliography files are supported.',
  // #1454 — picked file has no content to import.
  'data.importBibliographyEmpty': 'Cannot import {{name}}: the file is empty.',

  // Translators: button shown while an import runs, and the message after the user stopped it;
  // {{count}} = files imported before it stopped.
  // #1927 — Cancel a long-running multi-file/vault import between files.
  'data.importCancelButton': 'Cancel',
  // #1927 — partial result after the user cancels a multi-file import.
  'data.importCancelled_one': 'Import cancelled — {{count}} file imported.',
  'data.importCancelled_other': 'Import cancelled — {{count}} files imported.',

  // Translators: line under the import buttons; {{name}} = the space (set of pages) that receives
  // the imported pages.
  // #1927 — show the target space near the controls so the destination
  // is never silent.
  'data.importTargetSpace': 'Importing into: {{name}}',

  // Translators: button on the success toast and in the result panel that opens the imported page.
  // #1927 — post-import navigation action (success toast + result panel).
  'data.importViewAction': 'View',

  // Translators: Settings › Data, import in progress: the import button's label while it runs, a
  // hint shown while no space is active yet, and the progress lines below.
  'data.importingMessage': 'Importing...',
  'data.importSpaceNotReady': 'Select a space before importing.',
  // Translators: {{index}} = number of the file being imported, {{total}} = number of files,
  // {{name}} = its file name.
  'data.importingProgress': 'Importing file {{index}} of {{total}}: {{name}}',
  // Translators: {{blocks}} = blocks imported so far, {{bytes}} = a size such as "1.2 MB".
  'data.importingProgressDetail': '{{blocks}} blocks · {{bytes}} processed',
  // Translators: {{done}} = blocks done in the current file, {{total}} = its number of blocks.
  'data.importingBlocks': 'Block {{done}} of {{total}}',

  // Translators: success toast after an import; {{totalBlocks}} = blocks created, {{count}} = files
  // (or Evernote notes) imported.
  'data.importedMessage_one': 'Imported {{totalBlocks}} blocks from {{count}} file',
  'data.importedMessage_other': 'Imported {{totalBlocks}} blocks from {{count}} files',
  // #2513 — Evernote `.enex` aggregate success toast. Each unit is a NOTE (one
  // page per note), so label it "note(s)" rather than the file-worded string.
  'data.importedNotesMessage_one': 'Imported {{totalBlocks}} blocks from {{count}} note',
  'data.importedNotesMessage_other': 'Imported {{totalBlocks}} blocks from {{count}} notes',

  // Translators: Settings › Data, import result panel, summary line; {{title}} = the imported
  // page's title, or "N files" / "N notes" (keys below); {{count}} = blocks created.
  // Result-panel summary line. `count` is the number of blocks created so the
  // i18next plural selector picks the right form; `title` is the page title
  // (single file) or the multi-file placeholder (`data.importResultFilesTitle`).
  'data.importResultSummary_one': 'Imported “{{title}}”: {{count}} block',
  'data.importResultSummary_other': 'Imported “{{title}}”: {{count}} blocks',
  // Translators: appended to the summary after ", " (so lowercase); {{count}} = properties set.
  'data.importResultProperties_one': '{{count}} property',
  'data.importResultProperties_other': '{{count}} properties',
  // Translators: inserted as {{title}} in the summary when several files were imported.
  // Multi-file placeholder title used in place of a single page_title.
  'data.importResultFilesTitle_one': '{{count}} file',
  'data.importResultFilesTitle_other': '{{count}} files',
  // #2513 — multi-note placeholder title for the Evernote `.enex` result panel.
  'data.importResultNotesTitle_one': '{{count}} note',
  'data.importResultNotesTitle_other': '{{count}} notes',

  // Translators: import outcome (toasts and result panel): nothing imported, nothing changed, files
  // that failed, warnings; {{count}} = files or warnings, {{name}} = a file name, {{reason}} = the
  // error message.
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

  // Translators: warning in the import result panel; {{reason}} = the error message.
  'data.importLinkingFailed':
    'The links between the imported notes could not be completed: {{reason}}',

  // Translators: warnings in the import result panel when an Agaric export's settings could not be
  // restored; keep ".agaric/space.json". {{key}} = a property name, {{reason}} = the error message.
  // #6277 decision 8 — an export's `.agaric/space.json` restores the space's
  // property definitions and the titles its file names cannot spell.
  'data.importSpaceFileFailed': 'The export’s .agaric/space.json could not be restored: {{reason}}',
  'data.importPropertyDefFailed': 'The property “{{key}}” could not be restored: {{reason}}',

  // Translators: appended to the import summary after ", " (so lowercase); {{count}} = existing
  // pages the import updated / that were already identical to their file.
  // #6277 decision 7 — a file whose title names an existing page merges into it.
  'data.importResultUpdated_one': '{{count}} existing page updated',
  'data.importResultUpdated_other': '{{count}} existing pages updated',
  'data.importResultUpToDate_one': '{{count}} existing page already up to date',
  'data.importResultUpToDate_other': '{{count}} existing pages already up to date',

  // Translators: ConfirmDialog before an import that updates existing pages of the same title;
  // {{count}} = number of such pages.
  'data.importMergeTitle_one': 'Update an existing page?',
  'data.importMergeTitle_other': 'Update {{count}} existing pages?',
  'data.importMergeDescription_one':
    'A file has the title of this page, so the import updates it in place: changed lines update their blocks, new lines add blocks, and lines missing from the file go to the Trash. Undo on the page reverts the update.',
  'data.importMergeDescription_other':
    'These files have the titles of existing pages, so the import updates each in place: changed lines update their blocks, new lines add blocks, and lines missing from a file go to the Trash. Undo on a page reverts its update.',
  'data.importMergeConfirm': 'Update and import',
  // Translators: line heading each space's list of pages when several spaces are restored;
  // {{name}} = a space name.
  // #6554 — which space's pages the question is about, in a restore of several.
  'data.importMergeSpace': 'In the space {{name}}:',

  // Translators: ConfirmDialog when the picked folder is an "Export all spaces" backup, which
  // restores every space; {{count}} = number of spaces. List rows: {{name}} = a space name.
  // #6554 — a folder pick of an unzipped Export all spaces ZIP restores each space.
  'data.importVaultTitle_one': 'Restore {{count}} space?',
  'data.importVaultTitle_other': 'Restore {{count}} spaces?',
  'data.importVaultDescription':
    'This folder is an export of every space. Each space’s notes and property definitions import into the space of its name, which is created when there is none; the active space stays as it is. History, block ids and the Trash are not restored.',
  'data.importVaultConfirm': 'Restore spaces',
  'data.importVaultExisting': '{{name}}: imported into the existing space',
  'data.importVaultNew': '{{name}}: created',

  // Translators: inserted as {{reason}} in data.importFailedFileDetail ("Failed to import {{name}}:
  // {{reason}}"), so lowercase; its own {{reason}} = the error message.
  'data.importSpaceCreateFailed': 'the space could not be created: {{reason}}',

  // Translators: warning in the import result panel; {{reason}} = the error message.
  'data.importMergeCheckFailed':
    'The import did not run: the pages it would update could not be read: {{reason}}',

  // Translators: link-style toggle under the import result's list of failures and warnings.
  'data.importShowAll': 'Show all',
  'data.importShowLess': 'Show less',

  // Translators: screen-reader names of the two import progress bars (files; blocks of the current
  // file).
  // Accessible names for the two progress bars (#1929).
  'data.importFileProgressLabel': 'File import progress',
  'data.importBlockProgressLabel': 'Block import progress',

  // Translators: Settings › Data, Export card: title, "Current space" row (description, button,
  // button label while running), label of the "All spaces" row, and the result toasts.
  'data.exportTitle': 'Export all pages',
  'data.exportDesc': 'Download all pages as a ZIP of Markdown files.',
  'data.exportButton': 'Export this space',
  'data.exportCurrentSpaceLabel': 'Current space',
  'data.exportAllSpacesLabel': 'All spaces',
  'data.exporting': 'Exporting...',
  'data.exportSuccess': 'Export complete',
  'data.exportFailed': 'Export failed',

  // Translators: warning toast; {{detail}} = the skipped-item parts below, joined with "; ".
  // #2965 — partial-export warning: some pages/attachments were skipped but
  // the ZIP (with an `.agaric/export-report.txt` ledger) still downloaded.
  'data.exportPartial': 'Export finished with some items skipped: {{detail}}',
  'data.exportSkippedPages_one': '{{count}} page skipped',
  'data.exportSkippedPages_other': '{{count}} pages skipped',
  'data.exportSkippedAttachments_one': '{{count}} attachment skipped',
  'data.exportSkippedAttachments_other': '{{count}} attachments skipped',

  // Translators: Settings › Data, Export card, "All spaces" row: description, button, button label
  // while running, and toasts ({{count}} = number of spaces exported).
  // #2964 — whole-vault "Export all spaces" action: every space's pages in
  // one ZIP, one top-level folder per space. Separate from the
  // `data.export*` keys above, which only ever cover the active space.
  'data.exportAllSpacesDesc': 'Download every space as a single ZIP, with one folder per space.',
  'data.exportAllSpacesButton': 'Export all spaces',
  'data.exportingAllSpaces': 'Exporting all spaces...',
  'data.exportAllSpacesSuccess_one': 'Exported {{count}} space',
  'data.exportAllSpacesSuccess_other': 'Exported {{count}} spaces',
  'data.exportAllSpacesFailed': 'Export failed',

  // Translators: Android success toast after saving a file; {{fileName}} = the saved file's name.
  // #6546 — Android's file save: every export, attachment and report lands in Downloads.
  'data.savedToDownloads': 'Saved {{fileName}} to Downloads',

  // Translators: Settings › Data, "Daily snapshot" row (an automatic daily backup copy of the
  // database): label, description, status line ({{time}} = a localized date and time), and the
  // "Open folder" button with its error toast.
  // #6554 — the daily snapshot row: when the last copy of the database was
  // taken, and on desktop the folder that holds the copies.
  'data.snapshotLabel': 'Daily snapshot',
  'data.snapshotDesc':
    'Once a day Agaric saves a copy of its database beside it and keeps the most recent ones. Restore puts one back in place of your notes.',
  'data.snapshotLast': 'Last snapshot: {{time}}',
  'data.snapshotNone': 'No snapshot yet. The first is taken shortly after Agaric starts.',
  'data.snapshotUnreadable': 'The time of the last snapshot could not be read.',
  'data.snapshotOpenFolder': 'Open folder',
  'data.snapshotOpenFolderFailed': 'Could not open the data folder',
  // Translators: Settings › Data, the daily snapshot row's Restore dialog: the button, the dialog
  // title and text, the snapshot picker's label, the confirm button, and two error toasts
  // ({{reason}} = the error message). The restore runs when Agaric starts again.
  'data.snapshotRestoreButton': 'Restore…',
  'data.snapshotRestoreTitle': 'Restore a daily snapshot?',
  'data.snapshotRestoreDesc':
    'Agaric restarts with your notes as they were when the snapshot was taken. Edits and attachments made since then come back only from a paired device that has them, at its next sync. The notes you have now and the files attached since the snapshot are kept beside the database for 30 days, then deleted.',
  'data.snapshotRestoreSelectLabel': 'Snapshot',
  'data.snapshotRestoreConfirm': 'Restore and restart',
  'data.snapshotRestoreListFailed': 'Could not list the snapshots',
  'data.snapshotRestoreFailed': 'The snapshot was not restored: {{reason}}',

  // Translators: Settings › Data, "Markdown mirror" card (Agaric keeps a .md file of every page in
  // a folder the user picks): title, description, the folder row and its buttons. The "Not on this
  // device yet" text replaces the card on phones. "Undo on that page" is the page's own Undo (its
  // menu or Ctrl+Z there). The 90 days are TOMBSTONE_RETENTION_DAYS in src-tauri/src/maintenance.rs.
  // #5363 — the Markdown mirror: one `.md` file per page in a folder this
  // device writes to. A file edited elsewhere is read back into its page.
  'data.mirrorTitle': 'Markdown mirror',
  'data.mirrorDesc':
    'Agaric writes every page as a .md file into a folder you choose and keeps it up to date. A file you edit elsewhere is read back into its page, and Undo on that page reverts it. Deleting a file moves its page to the Trash, which deletes it for good after 90 days.',
  'data.mirrorFolderLabel': 'Mirror folder',
  'data.mirrorUnsupported':
    'Not on this device yet: the mirror runs in the desktop app only. Turn it on on your computer; notes written here reach its folder by sync.',
  'data.mirrorOff': 'Off. No folder chosen.',
  'data.mirrorChooseButton': 'Choose folder…',
  'data.mirrorTurnOffButton': 'Turn off',
  // Translators: Markdown mirror: "Open a folder of notes" (#6540) keeps an existing folder of
  // Markdown notes (an Obsidian vault) where it is: its notes are imported into a new space named
  // after the folder, then the folder becomes that space's mirror folder. A dialog shows first
  // how the files would change; {{name}} = the folder's name, {{current}}/{{total}} = files
  // imported so far / in all, {{reason}} = the error message. "Import above" is the Import card.
  'data.mirrorAdoptLabel': 'Open a folder of notes',
  'data.mirrorAdoptDesc':
    "Keep an Obsidian vault or a folder of Markdown files where it is: its notes are imported into a new space, and the folder becomes that space's mirror folder, with no file rewritten or moved. A Logseq graph is imported instead, as Evernote and Org files are.",
  'data.mirrorAdoptButton': 'Open a folder of notes…',
  'data.mirrorAdoptImporting': 'Importing {{current}} of {{total}}…',
  'data.mirrorAdoptCancel': 'Cancel',
  'data.mirrorAdoptLogseq':
    'That folder is a Logseq graph. Logseq graphs are imported, not opened in place: use Import above.',
  'data.mirrorAdoptFailed': 'The folder was not opened: {{reason}}',
  'data.mirrorAdoptTitle': 'Keep “{{name}}” as it is?',
  'data.mirrorAdoptDescription':
    "Its notes are pages of the new space “{{name}}”. Agaric writes no file of the folder now. A block you change in Agaric is written to its file in Agaric's form; a page you rename renames its file in its folder, moving it only if the part before its last / changes; a page you delete sends its file to the system trash.",
  'data.mirrorAdoptConfirm': 'Keep it in place',
  'data.mirrorAdoptDecline': 'Not now',
  'data.mirrorAdoptChangesHeading_one':
    '{{count}} file has lines Agaric writes in its own form once their block is changed',
  'data.mirrorAdoptChangesHeading_other':
    '{{count}} files have lines Agaric writes in its own form once their block is changed',
  'data.mirrorAdoptNoChanges': 'Agaric reads every note as it is written.',
  'data.mirrorAdoptLeftAloneHeading_one': '{{count}} file left alone: no note Agaric imported',
  'data.mirrorAdoptLeftAloneHeading_other': '{{count}} files left alone: no notes Agaric imported',
  'data.mirrorAdopted': 'Agaric keeps “{{name}}” in step with its space.',

  // Translators: Markdown mirror: error toast, and a status line when the mirror stopped;
  // {{reason}} = the error message.
  'data.mirrorFailed': 'The mirror folder was not changed: {{reason}}',
  'data.mirrorPaused': 'Paused: {{reason}}',

  // Translators: Markdown mirror: lists of files changed outside Agaric or failing (headings,
  // empty message, rows: {{path}} = file path, {{message}} = the error), and a warning toast after
  // a file was read in ({{count}} = number of warnings, {{first}} = the first warning).
  'data.mirrorDivergedHeading': 'Changed outside Agaric; not read in yet',
  'data.mirrorDivergedNone': 'No file has changed outside Agaric.',
  'data.mirrorFailedHeading': 'Could not be written or read',
  'data.mirrorIngestedWarnings_one': '{{path}} was read in with a warning: {{first}}',
  'data.mirrorIngestedWarnings_other': '{{path}} was read in with {{count}} warnings: {{first}}',
  // Translators: The same warning toast when several files were read in with warnings at once;
  // {{count}} = number of files.
  'data.mirrorIngestedWarningsFiles_one': '{{count}} file was read in with warnings',
  'data.mirrorIngestedWarningsFiles_other': '{{count}} files were read in with warnings',
  'data.mirrorFailedItem': '{{path}}: {{message}}',

  // Translators: Markdown mirror: toast after pages changed because their files were deleted,
  // renamed or moved, or added in the mirror folder outside Agaric. One page is named ({{path}} =
  // its file's path in the folder); several are counted: {{changes}} = the counts below joined as
  // a list ("1 page moved to the Trash, 2 new pages"), {{count}} = number of pages. Its button
  // opens the Trash.
  'data.mirrorReadBackTrashed':
    '{{path}} was deleted from the mirror folder, so its page moved to the Trash',
  'data.mirrorReadBackRenamed':
    '{{path}} was renamed or moved in the mirror folder, and its page with it',
  'data.mirrorReadBackCreated': '{{path}} was added to the mirror folder and is now a page',
  'data.mirrorReadBackSeveral': 'From changes in the mirror folder: {{changes}}',
  'data.mirrorReadBackTrashedCount_one': '{{count}} page moved to the Trash',
  'data.mirrorReadBackTrashedCount_other': '{{count}} pages moved to the Trash',
  'data.mirrorReadBackRenamedCount_one': '{{count}} page renamed or moved',
  'data.mirrorReadBackRenamedCount_other': '{{count}} pages renamed or moved',
  'data.mirrorReadBackCreatedCount_one': '{{count}} new page',
  'data.mirrorReadBackCreatedCount_other': '{{count}} new pages',

  // Translators: Markdown mirror: switch row that reads outside edits of the files back into Agaric
  // (label, description), and its error toast; {{reason}} = the error message.
  'data.mirrorReadBackLabel': 'Read changes back',
  'data.mirrorReadBackDesc':
    'Edits, new files, renames and moves made to the files outside Agaric are read back into Agaric, and a deleted file moves its page to the Trash. Off, Agaric still writes the files and never overwrites one changed elsewhere.',
  'data.mirrorReadBackFailed': 'Reading changes back was not changed: {{reason}}',

  // Translators: Markdown mirror: heading of the list of spaces to mirror (checkboxes), and its
  // error toast; {{reason}} = the error message.
  'data.mirrorSpacesHeading': 'Spaces mirrored',
  'data.mirrorSpaceFailed': 'Which spaces are mirrored was not changed: {{reason}}',

  // Translators: Markdown mirror: switch row that copies attachments into the folder (label,
  // description), and its error toast; {{reason}} = the error message.
  'data.mirrorCopyFilesLabel': 'Copy attachments into the folder',
  'data.mirrorCopyFilesDesc':
    'Images and files your pages link are copied into an assets folder beside them, and the pages link the copies. A copy you change there is kept and listed below.',
  'data.mirrorCopyFilesFailed': 'Copying attachments was not changed: {{reason}}',

  // Translators: Markdown mirror: switch row that makes Agaric ask before reading in many files of
  // a space changed or deleted outside Agaric at once (label, description), and its error toast;
  // {{reason}} = the error message.
  'data.mirrorAskMassChangeLabel': 'Ask before reading in many changes',
  'data.mirrorAskMassChangeDesc':
    'When many files of a space change or vanish at once, as when a folder is deleted, nothing is read back until you have seen them listed and chosen to read them in. Turn it off if you often change many files on purpose, such as renaming a note that many others link to.',
  'data.mirrorAskMassChangeFailed':
    'Asking before reading in many changes was not changed: {{reason}}',

  // Translators: Markdown mirror: shown when Agaric stopped reading back because many files of a
  // space changed or vanished at once: the read-in question's text in that case, a sentence saying
  // asking can be turned off, and a button that moves to the "Ask before reading in many changes"
  // switch.
  'data.mirrorReadMassChangeDesc':
    'Many files of a space changed or vanished outside Agaric at once, so Agaric asks before reading them in. Reading them in applies every change listed, and a page whose file was deleted moves to the Trash.',
  'data.mirrorMassChangeTurnOff':
    'If you change many files at once on purpose, such as renaming a note that many others link to, you can stop Agaric asking.',
  'data.mirrorMassChangeShowSetting': 'Show the setting',

  // Translators: Markdown mirror: toast when Agaric stopped reading back because many files of one
  // or more spaces changed or vanished outside Agaric at once; {{spaces}} = the spaces' folder
  // names joined as a list ("Work and Home"). It stays until closed; its button opens
  // Settings › Data, where the files are listed.
  'data.mirrorHeld':
    'Many files in {{spaces}} changed or vanished outside Agaric at once, so nothing is read back until you review them',

  // Translators: ConfirmDialog when "Read changes back" is turned on, or a folder is chosen, while
  // files there changed outside Agaric; {{count}} = number of files; its two buttons. The files are
  // listed under three headings by what reading them in does: edited files, files that are new
  // (or a page's file moved), and files that are gone (deleted, or a page's file moved).
  'data.mirrorReadPendingTitle': 'Read in what changed?',
  'data.mirrorReadPendingDesc_one':
    'This file changed outside Agaric and has not been read in. Turning reading back on reads it in.',
  'data.mirrorReadPendingDesc_other':
    'These {{count}} files changed outside Agaric and have not been read in. Turning reading back on reads them in.',
  'data.mirrorPendingEdited': 'Edited: read into their pages',
  'data.mirrorPendingNew': 'New: each becomes a page, or is the new place of a moved file',
  'data.mirrorPendingGone': 'Gone: their pages move to the Trash, unless the file was moved',
  'data.mirrorReadPendingConfirm': 'Read them in',
  'data.mirrorReadPendingCancel': 'Keep it off',

  // Translators: warning toast when "Export all spaces" finds no space to export.
  // The vault genuinely has no spaces at all — distinct from a space that
  // simply has no pages, so an empty ZIP is never downloaded silently.
  'data.exportAllSpacesNoSpaces': 'No spaces to export',

  // Translators: Settings › App health, "Integrity check" card (checks that the data the app
  // derives from the notes still matches them): title, description, Run button and its label while
  // running, screen-reader name of the result area, and an error toast.
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

  // Translators: integrity check result when nothing differs; {{count}} = blocks checked,
  // {{date}} = a date written 2026-06-17.
  'integrity.cleanTitle': 'Everything matches',
  'integrity.cleanDetail_one':
    'Rebuilt every derived table from {{count}} block on {{date}} and found no differences.',
  'integrity.cleanDetail_other':
    'Rebuilt every derived table from {{count}} blocks on {{date}} and found no differences.',

  // Translators: integrity check summary when rows differ; {{count}} = rows, {{blocks}} = blocks
  // checked, {{date}} = a date written 2026-06-17.
  'integrity.divergedSummary_one':
    '{{count}} row does not match a fresh rebuild ({{blocks}} blocks checked, {{date}}).',
  'integrity.divergedSummary_other':
    '{{count}} rows do not match a fresh rebuild ({{blocks}} blocks checked, {{date}}).',

  // Translators: technical lines (monospace) under each integrity problem; {{artefact}} = an
  // internal table.column name shown as is, {{count}} = rows, {{keys}} = example ids (a, b, c).
  'integrity.artefactLine_one': '{{count}} row diverged in {{artefact}}',
  'integrity.artefactLine_other': '{{count}} rows diverged in {{artefact}}',
  'integrity.sampleKeys': 'Examples: {{keys}}',

  // Translators: integrity check result: button that copies the report for a bug report, its
  // toasts, and the bug report's prefilled message ({{count}} = number of differences found).
  'integrity.copyButton': 'Copy for a bug report',
  'integrity.copied': 'Integrity report copied',
  'integrity.copyFailed': 'Could not copy the integrity report',
  'integrity.reportTitle_one': 'Integrity check: {{count}} divergence',
  'integrity.reportTitle_other': 'Integrity check: {{count}} divergences',

  // Translators: parts of the integrity check summary line, joined with a space.
  // {{count}} = rows (blocks checked, in the last part); {{table}} = a lowercase table name from
  // integrity.tableInline.*; {{tables}} = a number of tables; {{date}} = a date written 2026-06-17.
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

  // Translators: integrity check: one section per kind of problem, each a heading, an explanation
  // and what to do. The sync engine is the part of the app that merges changes between devices.
  'integrity.groupRebuildableTitle': 'Out-of-date caches (rebuildable)',
  'integrity.groupRebuildableDetail':
    'These tables are copies the app builds from your notes, and they fell behind, usually after an update changed how they are built. Rebuilding them from your notes is safe and loses nothing.',
  'integrity.groupRebuildableAction':
    'Copy the report first if you want to report it, then rebuild.',
  'integrity.groupEngineTitle': 'Disagreements with the sync engine',
  'integrity.groupEngineDetail':
    'Your notes database and the sync engine hold different versions of these rows. A rebuild does not fix this, and syncing can spread either version.',
  'integrity.groupEngineAction': 'Copy the report and file a bug before you sync again.',

  // Translators: integrity check: summary part ({{count}} = blocks) and section for blocks whose
  // internal id is written in a non-standard form. "Empty trash", "Restore all" = Trash buttons.
  'integrity.summaryIds_one':
    '{{count}} block has an id in a non-standard form (bulk Trash actions skip it).',
  'integrity.summaryIds_other':
    '{{count}} blocks have ids in a non-standard form (bulk Trash actions skip them).',
  'integrity.groupIdsTitle': 'Blocks with ids in a non-standard form',
  'integrity.groupIdsDetail':
    'These blocks were stored under an id written differently from the standard form, likely by an older version. Bulk Trash actions such as Empty trash and Restore all skip them. A rebuild does not change ids.',
  'integrity.groupIdsAction': 'Copy the report and file a bug so the repair can be decided.',

  // Translators: integrity problem name, shown after a table name and ": " (so lowercase).
  'integrity.problem.idForm': 'ids in a non-standard form',

  // Translators: names of the app's internal data tables, shown in the integrity check before ": "
  // and the problem name.
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

  // Translators: the same table names, inserted as {{table}} mid-sentence in
  // integrity.summaryRebuildableOneTable ("… rows in {{table}} are out of date"), so lowercase.
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

  // Translators: integrity problem names, shown after a table name and ": " (so lowercase).
  'integrity.problem.olderStrip': 'text indexed with an older rule',
  'integrity.problem.duplicate': 'blocks indexed more than once',
  'integrity.problem.rows': 'rows missing or left behind',
  'integrity.problem.counts': 'counts out of date',
  'integrity.problem.sortKey': 'sort order out of date',
  'integrity.problem.values': 'values out of date',
  'integrity.problem.engineRows': 'rows only one side holds',
  'integrity.problem.engineValues': 'values that differ from the sync engine',

  // Translators: example values (monospace) under an integrity problem; {{value}} = the expected /
  // found value; {{found}} / {{expected}} = an id as stored / in standard form; {{keys}} = example
  // ids, {{count}} = how many more.
  'integrity.sampleExpected': 'Expected: {{value}}',
  'integrity.sampleActual': 'Found: {{value}}',
  'integrity.sampleIdForm': 'Found: {{found}} (expected {{expected}})',
  'integrity.sampleKeysMore_one': 'Examples: {{keys}} and {{count}} more',
  'integrity.sampleKeysMore_other': 'Examples: {{keys}} and {{count}} more',

  // Translators: integrity check: button that rebuilds the out-of-date caches, its label while
  // running, and its toasts.
  'integrity.rebuildButton': 'Rebuild caches',
  'integrity.rebuilding': 'Rebuilding…',
  'integrity.rebuilt': 'Caches rebuilt',
  'integrity.rebuildFailed': 'Could not rebuild the caches',

  // Translators: Settings › About, "Report a bug" row: label, description, and the button that
  // opens the bug report dialog.
  'help.reportBugTitle': 'Report a bug',
  'help.reportBugDescription':
    'Found a problem? Send us what happened and — if you like — the recent logs from your device.',
  'help.reportBugButton': 'Report a bug',

  // Translators: Settings › About, "Updates" row on desktop: label, description, the check button
  // and its label while checking.
  'help.updateTitle': 'Updates',
  'help.updateDescription':
    'Agaric checks for updates automatically when it starts. You can also check manually.',
  'help.updateCheckNowButton': 'Check for updates now',
  'help.updateCheckingLabel': 'Checking...',
  // Translators: status lines under the row; {{ago}} = a relative time such as "5m ago",
  // {{version}} = a version number such as 1.4.2, {{error}} = the error message.
  'help.updateLastCheckedLabel': 'Last checked {{ago}}',
  'help.updateLastCheckedNever': 'Never checked',
  'help.updateUpToDateLabel': 'Up to date (v{{version}})',
  'help.updateUpToDateLabelNoVersion': 'Up to date',
  'help.updateAvailableStatus': 'Update available: v{{version}}',
  'help.updateCheckFailedLabel': 'Last check failed: {{error}}',
  // Translators: toast when a new version is found, with Install & restart / Later buttons;
  // {{version}} = a version number such as 1.4.2.
  'help.updateAvailableToast': 'Agaric {{version}} is available',
  'help.updateInstallActionLabel': 'Install & restart',
  'help.updateLaterActionLabel': 'Later',
  // Translators: toast after a manual check finds no newer version.
  'help.updateNoneFoundToast': "You're on the latest version",
  // Translators: fallback error text, inserted as {{error}} in help.updateCheckFailedLabel.
  'help.updateInstallFailedToast': 'Update install failed',
  // Translators: on Android, replaces the description; the button opens the download page
  // (an APK is the Android app file).
  'help.updateMobileHint':
    "Agaric does not update itself on Android. Once a day it looks for a newer version and tells you; install the newest APK from Agaric's GitHub releases page.",
  'help.updateOpenReleasesButton': 'Open releases page',

  // Translators: SpaceSwitcher (Sidebar dropdown of spaces): tooltip tip, keep "Alt+1–9"; and a
  // dropdown item shown when the user has only one space, which opens Settings › Spaces.
  'spaceSwitcher.shortcutHint': 'Tip: Alt+1–9 to switch spaces',
  'spaceSwitcher.createAnotherHint': 'Create another space\u2026',

  // Translators: in-page find toolbar (Ctrl+F, searches the open page only): screen-reader name of
  // the toolbar, placeholder and screen-reader label of its search field.
  // \u2014 in-page find toolbar.
  'findInPage.toolbarLabel': 'Find in page',
  'findInPage.inputPlaceholder': 'Find in page\u2026',
  'findInPage.inputLabel': 'Find in page',

  // Translators: in-page find toolbar icon buttons (tooltip and screen-reader label). Keep the
  // glyphs in parentheses (Aa, Ab|, .*).
  'findInPage.previousMatch': 'Previous match',
  'findInPage.nextMatch': 'Next match',
  'findInPage.close': 'Close',

  // Translators: in-page find match counter, must stay short; {{current}} = number of the current
  // match, {{total}} = number of matches.
  'findInPage.counter': '{{current}} of {{total}}',
  'findInPage.counterEmpty': '0 of 0',

  // Translators: error under the find field when the regular-expression pattern cannot be used;
  // {{message}} = the browser's error text (English).
  'findInPage.regexTooLong': 'Pattern is too long (max 1 KB).',
  'findInPage.regexInvalid': 'Invalid regex: {{message}}',
  'findInPage.regexTooSlow': 'Pattern is too slow — try a simpler expression.',

  // Translators: note under the find toolbar: very long passages were not searched;
  // {{count}} = number of passages.
  'findInPage.skippedLongPassages_one': '{{count}} long passage skipped',
  'findInPage.skippedLongPassages_other': '{{count}} long passages skipped',

  // Translators: in-page find, Replace row: the toggle button, the replacement field (also in the
  // Search view), Replace / Replace all buttons, and a spinner's screen-reader label.
  'findInPage.toggleReplace': 'Replace',
  'findInPage.replaceInputLabel': 'Replace with',
  'findInPage.replacePlaceholder': 'Replace with\u2026',
  'findInPage.replaceOne': 'Replace',
  'findInPage.replaceAll': 'Replace all',
  'findInPage.replacing': 'Replacing',

  // Translators: status text of the Replace row (also in the Search view's replace bar);
  // {{count}} = number of matches. "Replaced …" and "… left as it is" are joined with " · ".
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

  // Translators: Announcer (spoken by the screen reader) when the in-page find toolbar opens.
  'announce.findInPageOpened': 'Find in page opened',

  // Translators: desktop header button that opens the command palette (Ctrl+K): its short visible
  // label and screen-reader label.
  // Desktop header button that opens the Ctrl+K palette; the shortcut shows in its tooltip.
  'headerSearch.label': 'Search',

  // Translators: phone search sheet (a panel sliding up from the bottom) with two tabs: the open
  // page or all pages. Screen-reader label of the header icon that opens it, hidden title and
  // description, the tab names, and the message (with button) shown when no page is open.
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

  // Translators: phone search sheet, "All pages" tab: two-line button that opens the full Search
  // view (title on line 1, hint on line 2), and its screen-reader label.
  // The mobile escalation is a prominent, two-line
  // CTA (title + hint) rather than a muted footer row, so touch users
  // discover that filters / regex / history live in the full search
  // view. `escalateLabel` is the descriptive aria-label for the button;
  // `escalateCtaTitle` / `escalateCtaHint` are the visible two lines.
  'searchSheet.escalateCtaHint': 'Open full search',
  'searchSheet.escalateCtaTitle': 'Filters & regex',
  'searchSheet.escalateLabel': 'Open full search for filters, regex, and history',

  // Translators: phone search sheet: long-pressing a tab makes it the default. Screen-reader hint,
  // toasts ({{scope}} = "This page" or "All pages"), and the pin icon's screen-reader label.
  // #135 — long-press a scope to pin it as the default; aria hint + toasts.
  'searchSheet.scopePinHint': 'Long-press a scope to pin it as your default',
  'searchSheet.scopePinnedBadge': 'Pinned default',

  // Translators: phone search sheet, list of recent search terms: heading, a Clear button that
  // empties the list (verb), and each row's screen-reader label ({{term}} = the search text).
  // #131 — recent searches empty-state list.
  'searchSheet.recentSearchesTitle': 'Recent searches',
  'searchSheet.recentSearchesClear': 'Clear',
  'searchSheet.recentSearchRunLabel': 'Search again for “{{term}}”',

  // Translators: drag-and-drop messages spoken by the screen reader while reordering blocks,
  // bookmarks, tabs or board cards; {{block}} = the dragged item's text, {{target}} = the item
  // under it. "block" replaces that text when a block is empty (inserted mid-sentence: lowercase).
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
  // Translators: read when a block's drag handle gets keyboard focus; "space", "enter", "escape"
  // and the arrow keys are keyboard keys.
  'dnd.screenReaderInstructions':
    'To pick up a block, press space or enter. While dragging, use the arrow keys to move the block up, down, or change its indent level. Press space or enter again to drop the block in its new position, or press escape to cancel.',
}
