/**
 * HeadingLevelSelector — popover content for selecting heading levels (H1–H6).
 *
 * Extracted from FormattingToolbar to keep the main component focused.
 */

import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

export interface HeadingLevelSelectorProps {
  editor: Editor
  headingLevel: number
  onClose: () => void
}

export function HeadingLevelSelector({
  editor,
  headingLevel,
  onClose,
}: HeadingLevelSelectorProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-0.5">
      {([1, 2, 3, 4, 5, 6] as const).map((level) => (
        <Button
          key={level}
          variant="ghost"
          size="sm"
          className={cn('justify-start text-sm', headingLevel === level && 'bg-accent')}
          onPointerDown={(e) => {
            e.preventDefault()
            editor.chain().focus().toggleHeading({ level }).run()
            onClose()
          }}
        >
          H{level}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className={cn('justify-start text-sm', headingLevel === 0 && 'bg-accent')}
        onPointerDown={(e) => {
          e.preventDefault()
          if (headingLevel > 0) {
            editor
              .chain()
              .focus()
              .toggleHeading({ level: headingLevel as 1 | 2 | 3 | 4 | 5 | 6 })
              .run()
          }
          onClose()
        }}
      >
        {t('toolbar.paragraph')}
      </Button>
    </div>
  )
}
