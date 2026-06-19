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
 * stays under oxlint's eslint/complexity budget as more row types
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
  // #1521 — pages copy a pasteable `[[ULID]]` page link (the block row's
  // sibling copies `((ULID))`); the old `copy-id` action wrote a bare ULID
  // that pastes as dead text, so it was renamed/relabelled to match.
  const copyPageLink: PaletteAction = {
    id: 'copy-page-link',
    label: t('palette.actionCopyPageLink'),
  }
  if (rowType === 'recent') {
    return [
      open,
      newTab,
      pinned
        ? { id: 'unpin', label: t('palette.actionUnpin') }
        : { id: 'pin', label: t('palette.actionPin') },
      reveal,
      copyPageLink,
      { id: 'remove-from-recents', label: t('palette.actionRemoveFromRecents') },
    ]
  }
  if (rowType === 'page') return [open, newTab, reveal, copyPageLink]
  return [open, newTab, reveal, { id: 'copy-block-link', label: t('palette.actionCopyBlockLink') }]
}
