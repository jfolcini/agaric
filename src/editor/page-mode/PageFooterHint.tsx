/**
 * Page mode's footer hint, "Supports Markdown. Type / for commands": each
 * half opens its reference sheet. A press does not take the focus from the
 * editor, so closing the sheet returns it there with its selection.
 */

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MarkdownReferenceSheet } from '@/components/editor/MarkdownReferenceSheet'
import { SlashCommandReferenceSheet } from '@/components/editor/SlashCommandReferenceSheet'
import { Button } from '@/components/ui/button'

function keepFocus(e: React.MouseEvent): void {
  e.preventDefault()
}

export function PageFooterHint(): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState<'markdown' | 'commands' | null>(null)
  const sheetProps = (sheet: 'markdown' | 'commands') => ({
    open: open === sheet,
    onOpenChange: (next: boolean) => setOpen(next ? sheet : null),
  })
  return (
    <p>
      <Button
        variant="link"
        size="xs"
        className="px-0 text-muted-foreground"
        aria-haspopup="dialog"
        onMouseDown={keepFocus}
        onClick={() => setOpen('markdown')}
      >
        {t('pageMode.footerHint.markdown')}
      </Button>
      {'. '}
      <Button
        variant="link"
        size="xs"
        className="px-0 text-muted-foreground"
        aria-haspopup="dialog"
        onMouseDown={keepFocus}
        onClick={() => setOpen('commands')}
      >
        {t('pageMode.footerHint.commands')}
      </Button>
      <MarkdownReferenceSheet {...sheetProps('markdown')} />
      <SlashCommandReferenceSheet {...sheetProps('commands')} />
    </p>
  )
}
