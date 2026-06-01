/**
 * <EmojiPickerDialog> — the responsive shell around <EmojiPicker> (#286).
 *
 * Renders the picker in a centred `Dialog` on pointer/desktop and a bottom
 * `Sheet` on mobile (coarse pointer / narrow viewport), mirroring how
 * `BlockPropertyDrawer` adapts. Surface integrations (block editor toolbar,
 * page-title button, tag-rename button) open this and forward `onSelect` to
 * insert at their caret — that wiring is the remaining sub-issue (#286 part 3)
 * and intentionally lives in each surface, not here.
 *
 * Closing on select is the default (most callers insert one emoji and dismiss)
 * but can be disabled via `closeOnSelect={false}` for a "keep picking" flow.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { useIsMobile } from '@/hooks/useIsMobile'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { EmojiPicker } from './EmojiPicker'

export interface EmojiPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the chosen native emoji `char` (skin tone already applied). */
  onSelect: (char: string) => void
  /** Dismiss the dialog/sheet after a selection (default true). */
  closeOnSelect?: boolean
}

export function EmojiPickerDialog({
  open,
  onOpenChange,
  onSelect,
  closeOnSelect = true,
}: EmojiPickerDialogProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const handleSelect = useCallback(
    (char: string) => {
      onSelect(char)
      if (closeOnSelect) onOpenChange(false)
    },
    [onSelect, closeOnSelect, onOpenChange],
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[80dvh]">
          <SheetHeader>
            <SheetTitle>{t('emojiPicker.title')}</SheetTitle>
          </SheetHeader>
          <EmojiPicker onSelect={handleSelect} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('emojiPicker.title')}</DialogTitle>
        </DialogHeader>
        <EmojiPicker onSelect={handleSelect} />
      </DialogContent>
    </Dialog>
  )
}
