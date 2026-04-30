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
  'error.loadBlocksFailed': 'Failed to load blocks',
  'error.deleteBlockFailed': 'Failed to delete block',
  'error.reorderBlockFailed': 'Failed to reorder block',
  'error.moveBlockFailed': 'Failed to move block',
  'error.indentBlockFailed': 'Failed to indent block',
  'error.dedentBlockFailed': 'Failed to dedent block',
  'error.moveBlockUpFailed': 'Failed to move block up',
  'error.moveBlockDownFailed': 'Failed to move block down',
  'error.createPageFailed': 'Failed to create page',
}
