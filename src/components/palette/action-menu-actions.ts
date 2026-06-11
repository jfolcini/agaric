/**
 * Per-row action-menu action-set builder. Extracted from
 * CommandPalette.tsx (#751).
 */

import type { useTranslation } from 'react-i18next'

import type { PaletteAction } from './PaletteActionMenu'

/** Row types that expose a Tab / `…` action menu. */
export type ActionMenuRowType = 'recent' | 'page' | 'block'

/**
 * PEND-67 Phase 5 — build the action set for the currently-open
 * action menu. Pulled out of `PaletteBody` so the inner component
 * stays under Biome's cognitive-complexity budget as more row types
 * and actions land.
 */
export function buildActionMenuActions(
  rowType: ActionMenuRowType,
  pinned: boolean,
  t: ReturnType<typeof useTranslation>['t'],
): readonly PaletteAction[] {
  const open: PaletteAction = {
    id: 'open',
    label: rowType === 'block' ? t('palette.actionOpenPage') : t('palette.actionOpen'),
    hint: '↵',
  }
  const newTab: PaletteAction = {
    id: 'open-new-tab',
    label: t('palette.actionOpenNewTab'),
    hint: '⌘↵',
  }
  const reveal: PaletteAction = { id: 'reveal-in-pages', label: t('palette.actionReveal') }
  const copyId: PaletteAction = { id: 'copy-id', label: t('palette.actionCopyId') }
  if (rowType === 'recent') {
    return [
      open,
      newTab,
      pinned
        ? { id: 'unpin', label: t('palette.actionUnpin') }
        : { id: 'pin', label: t('palette.actionPin') },
      reveal,
      copyId,
      { id: 'remove-from-recents', label: t('palette.actionRemoveFromRecents') },
    ]
  }
  if (rowType === 'page') return [open, newTab, reveal, copyId]
  return [open, newTab, reveal, { id: 'copy-block-link', label: t('palette.actionCopyBlockLink') }]
}
