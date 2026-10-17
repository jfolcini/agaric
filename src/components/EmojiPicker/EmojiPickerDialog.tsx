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
 *
 * Both shells carry `data-editor-portal`: opened from a block (`/emoji`, the
 * toolbar button), the pick inserts at the roving editor's caret, so taking
 * focus must not unmount that editor (`useEditorBlur`).
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { EmojiPicker } from '@/components/EmojiPicker/EmojiPicker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/useIsMobile'

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
        <SheetContent side="bottom" data-editor-portal="">
          <SheetHeader>
            <SheetTitle>{t('emojiPicker.title')}</SheetTitle>
            <SheetDescription className="sr-only">
              {t('emojiPicker.dialogDescription')}
            </SheetDescription>
          </SheetHeader>
          <EmojiPicker onSelect={handleSelect} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mouse: just wider than the 8-column grid. Touch keeps the room its
          44px category tabs and skin-tone buttons need. */}
      <DialogContent
        className="sm:max-w-sm [@media(pointer:coarse)]:sm:max-w-md"
        data-editor-portal=""
      >
        <DialogHeader>
          <DialogTitle>{t('emojiPicker.title')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('emojiPicker.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <EmojiPicker onSelect={handleSelect} />
      </DialogContent>
    </Dialog>
  )
}
