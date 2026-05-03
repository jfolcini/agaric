/**
 * CodeLanguageSelector — popover content for selecting code block languages.
 *
 * Extracted from FormattingToolbar to keep the main component focused.
 *
 * UX-300: a filter input is rendered at the top of the popover and
 * narrows the language list via `match-sorter` (same pattern as the
 * page/tag pickers in `useBlockResolve.ts`). The input is auto-focused
 * on open; ArrowUp / ArrowDown move a visual highlight across the
 * filtered subset; Enter selects the highlighted language. Space is
 * deliberately excluded from the keyboard handler so it remains a
 * regular filter character — none of the languages contain spaces
 * today, but treating Space as "select" would surprise the user.
 */

import type { Editor } from '@tiptap/react'
import { matchSorter } from 'match-sorter'
import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { CODE_LANGUAGES } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'

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
  const [filter, setFilter] = useState('')

  // `CODE_LANGUAGES` is `readonly [...] as const`; spread to satisfy
  // matchSorter's mutable-array typing without changing the source const.
  const filteredLanguages = useMemo<readonly string[]>(
    () => (filter ? matchSorter([...CODE_LANGUAGES], filter) : CODE_LANGUAGES),
    [filter],
  )

  function applyLanguage(lang: string): void {
    const attrs = { language: lang }
    if (!isCodeBlock) {
      editor.chain().focus().toggleCodeBlock().updateAttributes('codeBlock', attrs).run()
    } else {
      editor.chain().focus().updateAttributes('codeBlock', attrs).run()
    }
    onClose()
  }

  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: filteredLanguages.length,
    onSelect: (idx) => {
      const lang = filteredLanguages[idx]
      if (lang) applyLanguage(lang)
    },
  })

  return (
    <div className="flex flex-col gap-0.5">
      <Input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label={t('toolbar.codeBlockLanguage')}
        className="mb-1"
        onKeyDown={(e) => {
          // Space is a legitimate filter character — short-circuit before the
          // shared hook would otherwise treat it as "select".
          if (e.key === ' ') return
          if (handleKeyDown(e)) e.preventDefault()
        }}
      />
      {filteredLanguages.map((lang, idx) => (
        <Button
          key={lang}
          variant="ghost"
          size="sm"
          className={cn(
            'justify-start text-sm',
            currentLanguage === lang && 'bg-accent',
            idx === focusedIndex && 'bg-accent text-accent-foreground',
          )}
          onPointerDown={(e) => {
            e.preventDefault()
            applyLanguage(lang)
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
