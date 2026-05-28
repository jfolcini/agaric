/**
 * HistorySheet — renders the block history panel inside a side-drawer Sheet.
 *
 * Wraps HistoryPanel in a right-side Sheet opened from the block gutter
 * or context menu via BlockTree state.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { HistoryPanel } from './HistoryPanel'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet'

export interface HistorySheetProps {
  blockId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function HistorySheet({
  blockId,
  open,
  onOpenChange,
}: HistorySheetProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-lg` (≈512 px) overrides the Sheet primitive's default
          `sm:max-w-sm` (≈384 px) — history rows are dense (timestamp +
          op-icon + author + multi-line preview + diff toggle + restore
          button) and 384 px guarantees aggressive single-word wrapping in
          the diff content. 512 px keeps the filter bar on one row and the
          diff hunks readable. Per-call override; other Sheet consumers
          keep the default width. */}
      <SheetContent side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('history.title')}</SheetTitle>
          <SheetDescription>{t('history.description')}</SheetDescription>
        </SheetHeader>
        <SheetBody>{blockId && <HistoryPanel blockId={blockId} />}</SheetBody>
      </SheetContent>
    </Sheet>
  )
}
