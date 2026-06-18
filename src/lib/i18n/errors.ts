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
}
