/**
 * i18n namespace: errors
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const errors: Record<string, string> = {
  // Translators: Empty-state messages: a page with no blocks, and a list with no pages.
  // "+ Add block" names the button under an empty page; keep it matching that button's label.
  'empty.noBlocks': 'No blocks yet. Click + Add block below to start writing.',
  'empty.noPages': 'No pages yet. Create one to get started.',

  // Translators: Small progress line under a "Load more" button at the end of a long list;
  // {{loaded}} = items shown so far, {{total}} = all items, e.g. "Loaded 50 of 120".
  'loadMore.progress': 'Loaded {{loaded}} of {{total}}',

  // Translators: Heading of the full-screen crash screen shown when the whole app fails.
  'error.generic': 'Something went wrong',

  // Translators: Error card shown in place of a list (pages, tags, history …) that could not
  // load, next to a Retry button.
  'error.loadFailed': 'Failed to load data',

  // Translators: Toasts (brief pop-up messages) when an action on a page or a block fails.
  // A "block" is one bullet/paragraph of the outliner; a "space" is a separate notebook.
  // #2921 — soft-failure toast when a background `refreshAvailableSpaces()`
  // rejects but a usable prior snapshot exists (so the app stays on the
  // previously-loaded spaces instead of freezing).
  'error.spacesLoadFailed': 'Failed to refresh spaces',
  'error.saveFailed': 'Failed to save',
  'error.createBlockFailed': 'Failed to create block',
  // #3276 — shown when a navigation jump (link click, search result) targets
  // a block that never mounts (e.g. still hidden under a collapse/mount-cap
  // reveal that didn't resolve in time), so the user gets a visible signal
  // instead of a silent no-op that looks like a broken link.
  'error.blockNotFound': 'Could not locate that block on the page',

  // Translators: Error box that replaces one crashed part of the window; {{section}} = the name
  // of that part (a view like "Journal", or one of the errorBoundary.section names below).
  // "An unexpected error occurred" is the detail line when the error has no message of its own.
  'error.sectionCrashed': '{{section}} encountered an error',
  'error.unexpected': 'An unexpected error occurred',

  // Translators: Red banner across the top of the window explaining why changes stop saving.
  // "Settings › Data" names the Data tab of Settings; keep it matching that tab's label.
  // #6554 — why commands are failing, shown once in StorageFailureBanner.
  'storage.full':
    'The disk is full, so changes are not being saved. Free up some space, then try again.',
  'storage.readOnly':
    'Agaric cannot write to its data folder, so changes are not being saved. Check that the folder and its disk can be written to.',
  'storage.corrupt':
    'The database is damaged, so some actions fail. Export your notes (Settings › Data) before changing anything else.',

  // Translators: Reassurance line in the error box of a crashed part of the window; "Retry" is
  // the button just below it, keep it matching that button's label.
  'errorBoundary.dataSafe': 'Your data is safe — Retry reloads this panel.',

  // Translators: Names of parts of the window, inserted as {{section}} at the start of
  // error.sectionCrashed ("{{section}} encountered an error"). Nouns, title case as a name.
  // "Quick access" = the strip of recent pages; "Search sheet" = the phone search panel;
  // "Gesture coach-mark" = a one-time hint teaching a swipe gesture; "Quick capture button" =
  // the floating "+" button; "Notifications" = the pop-up messages (toasts).
  // #1700: localized section names for FeatureErrorBoundary fallbacks. View
  // sections reuse the `sidebar.*` labels; the App-shell boundaries below have
  // no sidebar entry, so they get dedicated `errorBoundary.section.*` keys.
  'errorBoundary.section.pageEditor': 'Page editor',
  'errorBoundary.section.tabBar': 'Tab bar',
  'errorBoundary.section.quickAccess': 'Quick access',
  'errorBoundary.section.findInPage': 'Find in page',
  'errorBoundary.section.commandPalette': 'Command palette',
  'errorBoundary.section.searchSheet': 'Search sheet',
  'errorBoundary.section.keyboardShortcuts': 'Keyboard shortcuts',
  'errorBoundary.section.welcome': 'Welcome',
  'errorBoundary.section.gestureCoachMark': 'Gesture coach-mark',
  'errorBoundary.section.bugReport': 'Bug report',
  'errorBoundary.section.quickCaptureButton': 'Quick capture button',
  'errorBoundary.section.quickCapture': 'Quick capture',
  'errorBoundary.section.newPage': 'New page',
  'errorBoundary.section.newMeeting': 'New meeting',
  'errorBoundary.section.syncSetup': 'Sync setup',
  'errorBoundary.section.notifications': 'Notifications',

  // Translators: Toast (brief pop-up message) when a page's blocks cannot be loaded.
  'error.loadBlocksFailed': 'Failed to load blocks',

  // Translators: Info toasts when a tab or a recent-pages entry points to a page that is no
  // longer here: moved to another space (a separate notebook), or deleted to the trash.
  // #2802 — soft notice for a stale old-space reference (tab stack /
  // recent-pages entry) to a page that was moved to another space. The
  // backend rejects the space-scoped load with `validation`; this copy
  // replaces the raw `error.loadBlocksFailed` toast for that case.
  'error.pageNotInCurrentSpace': 'This page was moved to another space',
  // #5243 — the same heal for a stale reference to a page in the trash.
  'error.pageInTrash': 'This page is in the trash',

  // Translators: Toasts (brief pop-up messages) when editing or moving blocks fails.
  // "Indent" = move a block one level deeper in the outline; "dedent" = one level out.
  'error.deleteBlockFailed': 'Failed to delete block',
  'error.reorderBlockFailed': 'Failed to reorder block',
  'error.moveBlockFailed': 'Failed to move block',
  'error.indentBlockFailed': 'Failed to indent block',
  // Translators: Indent refused because the outline cannot go one level deeper.
  'error.maxNestingReached': 'Max nesting level reached',
  'error.dedentBlockFailed': 'Failed to dedent block',
  'error.moveBlockUpFailed': 'Failed to move block up',
  'error.moveBlockDownFailed': 'Failed to move block down',
  'error.createPageFailed': 'Failed to create page',
  'error.pasteBlocksFailed': 'Failed to paste blocks',

  // Translators: Warning toast when your preferences cannot be saved in the app's local browser
  // storage (usually because it is full).
  // #2925 — surfaced by `safePersistStorage` when a Zustand store's
  // localStorage write fails (typically QuotaExceededError). Deduped to a
  // single toast per burst, since the write path can't say which store
  // action triggered it.
  'error.settingsSaveFailed': 'Failed to save your changes locally — local storage may be full',

  // Translators: Error toast or inline error when an action fails for a reason the app did not
  // expect. {{id}} = a short code such as 7F3A2 that the user quotes when reporting the problem;
  // keep "(err: {{id}})" exactly as written, it is a code.
  'error.internal': 'Something went wrong (err: {{id}})',

  // Translators: Error toasts and inline errors when the app refuses a search, a filter or an
  // edit, each saying what was wrong with it. "Page name pattern" = a glob such as Journal* that
  // matches page titles. YYYY-MM-DD is the date format to type. In the repeat rule, keep what is
  // between backticks exactly as written: it is what the user types, N stands for a number.
  'errorCode.invalidGlob': 'That page name pattern is not valid.',
  'errorCode.invalidRegex': 'That regular expression is not valid.',
  'errorCode.invalidDateFilter':
    'That date filter is not valid. Use YYYY-MM-DD dates, with the start of a range before its end.',
  'errorCode.requiresRefresh': 'This changed after it was loaded. Reload it and try again.',
  'errorCode.invalidRepeatRule':
    'That repeat rule is not valid. Use `daily`, `weekly`, `monthly`, `yearly`, or `+Nd` / `+Nw` / `+Nm` / `+Ny` with N of 1 or more, optionally prefixed with `.+` (count from when you complete it) or `++` (catch up to today).',
  'errorCode.duplicateAgentName': 'Another agent already has this name.',
  'errorCode.builtinPropertyLocked': 'This property is built in, so it cannot be changed.',
  'errorCode.unacknowledgedPropertyLoss':
    'The values changed since the preview. Preview again before you confirm.',
}
