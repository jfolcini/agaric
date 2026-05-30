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

import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'
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

  // #215 P2-10 — when the filter matches no built-in language, let the user
  // apply the raw typed string (e.g. Elixir, Kotlin, Swift, PHP, R). Lowlight
  // highlights what it knows and degrades to plain monospace otherwise.
  const customLang = filter.trim().toLowerCase()
  const showCustom = filteredLanguages.length === 0 && customLang.length > 0

  function applyLanguage(lang: string): void {
    const attrs = { language: lang }
    if (!isCodeBlock) {
      // toggleCodeBlockSafely handles the tiptap 3.23.6 deleteSelection
      // regression (see use-roving-editor.ts). Passing `attrs` here means
      // the language is set as part of the toggle — single chain, single
      // `run()`.
      toggleCodeBlockSafely(editor, attrs)
    } else {
      editor.chain().focus().updateAttributes('codeBlock', attrs).run()
    }
    onClose()
  }

  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    // When no built-in language matches, the single "Use «typed»" row is the
    // only selectable item, so Enter applies the custom language.
    itemCount: showCustom ? 1 : filteredLanguages.length,
    onSelect: (idx) => {
      if (showCustom) {
        applyLanguage(customLang)
        return
      }
      const lang = filteredLanguages[idx]
      if (lang) applyLanguage(lang)
    },
  })

  return (
    <div className="flex flex-col gap-0.5">
      <Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: language filter input is rendered inside a popover that opens on user action, so typing filters immediately
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
      {showCustom && (
        // #215 P2-10 — no built-in match: apply the raw typed language.
        <>
          <span className="px-2 py-1 text-xs text-muted-foreground" data-testid="no-language-match">
            {t('toolbar.noLanguageMatch')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'justify-start text-sm',
              focusedIndex === 0 && 'bg-accent text-accent-foreground',
            )}
            data-testid="use-custom-language"
            onPointerDown={(e) => {
              e.preventDefault()
              applyLanguage(customLang)
            }}
          >
            {t('toolbar.useCustomLanguage', { language: customLang })}
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        className={cn('justify-start text-sm', isCodeBlock && !currentLanguage && 'bg-accent')}
        onPointerDown={(e) => {
          e.preventDefault()
          if (isCodeBlock) {
            editor.chain().focus().updateAttributes('codeBlock', { language: '' }).run()
          } else {
            toggleCodeBlockSafely(editor)
          }
          onClose()
        }}
      >
        {t('toolbar.plainText')}
      </Button>
    </div>
  )
}
