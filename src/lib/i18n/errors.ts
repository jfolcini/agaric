/**
 * i18n namespace: errors
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const errors: Record<string, string> = {
  'empty.noBlocks': 'No blocks yet. Click + Add block below to start writing.',
  'empty.noPages': 'No pages yet. Create one to get started.',
  'loadMore.progress': 'Loaded {{loaded}} of {{total}}',
  'error.generic': 'Something went wrong',
  'error.loadFailed': 'Failed to load data',
  // #2921 — soft-failure toast when a background `refreshAvailableSpaces()`
  // rejects but a usable prior snapshot exists (so the app stays on the
  // previously-loaded spaces instead of freezing).
  'error.spacesLoadFailed': 'Failed to refresh spaces',
  'error.saveFailed': 'Failed to save',
  'error.createBlockFailed': 'Failed to create block',
  'error.sectionCrashed': '{{section}} encountered an error',
  'error.unexpected': 'An unexpected error occurred',
  'errorBoundary.dataSafe': 'Your data is safe — Retry reloads this panel.',
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
  'errorBoundary.section.syncSetup': 'Sync setup',
  'errorBoundary.section.notifications': 'Notifications',
  'error.loadBlocksFailed': 'Failed to load blocks',
  // #2802 — soft notice for a stale old-space reference (tab stack /
  // recent-pages entry) to a page that was moved to another space. The
  // backend rejects the space-scoped load with `validation`; this copy
  // replaces the raw `error.loadBlocksFailed` toast for that case.
  'error.pageNotInCurrentSpace': 'This page was moved to another space',
  'error.deleteBlockFailed': 'Failed to delete block',
  'error.reorderBlockFailed': 'Failed to reorder block',
  'error.moveBlockFailed': 'Failed to move block',
  'error.indentBlockFailed': 'Failed to indent block',
  'error.maxNestingReached': 'Max nesting level reached',
  'error.dedentBlockFailed': 'Failed to dedent block',
  'error.moveBlockUpFailed': 'Failed to move block up',
  'error.moveBlockDownFailed': 'Failed to move block down',
  'error.createPageFailed': 'Failed to create page',
  'error.pasteBlocksFailed': 'Failed to paste blocks',
  // #2925 — surfaced by `safePersistStorage` when a Zustand store's
  // localStorage write fails (typically QuotaExceededError). Deduped to a
  // single toast per burst, since the write path can't say which store
  // action triggered it.
  'error.settingsSaveFailed': 'Failed to save your changes locally — local storage may be full',
}
