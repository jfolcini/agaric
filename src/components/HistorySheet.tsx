/**
 * HistorySheet — renders the block history panel inside a side-drawer Sheet.
 *
 * Wraps HistoryPanel in a right-side Sheet opened from the block gutter
 * or context menu via BlockTree state.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { HistoryPanel } from './HistoryPanel'
import { ScrollArea } from './ui/scroll-area'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'

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
      <SheetContent side="right" className="w-3/4 sm:w-80">
        <SheetHeader>
          <SheetTitle>{t('history.title')}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="mt-4 space-y-3 px-4 pb-4">
            {blockId && <HistoryPanel blockId={blockId} />}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
