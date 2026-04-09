/**
 * CodeLanguageSelector — popover content for selecting code block languages.
 *
 * Extracted from FormattingToolbar to keep the main component focused.
 */

import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { CODE_LANGUAGES } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

export interface CodeLanguageSelectorProps {
  editor: Editor
  isCodeBlock: boolean
  currentLanguage: string
  onClose: () => void
}

export function CodeLanguageSelector({
  editor,
  isCodeBlock,
  currentLanguage,
  onClose,
}: CodeLanguageSelectorProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-0.5">
      {CODE_LANGUAGES.map((lang) => (
        <Button
          key={lang}
          variant="ghost"
          size="sm"
          className={cn('justify-start text-sm', currentLanguage === lang && 'bg-accent')}
          onPointerDown={(e) => {
            e.preventDefault()
            const attrs = { language: lang }
            if (!isCodeBlock) {
              editor.chain().focus().toggleCodeBlock().updateAttributes('codeBlock', attrs).run()
            } else {
              editor.chain().focus().updateAttributes('codeBlock', attrs).run()
            }
            onClose()
          }}
        >
          {lang}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className={cn('justify-start text-sm', isCodeBlock && !currentLanguage && 'bg-accent')}
        onPointerDown={(e) => {
          e.preventDefault()
          if (isCodeBlock) {
            editor.chain().focus().updateAttributes('codeBlock', { language: '' }).run()
          } else {
            editor.chain().focus().toggleCodeBlock().run()
          }
          onClose()
        }}
      >
        {t('toolbar.plainText')}
      </Button>
    </div>
  )
}
