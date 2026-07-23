/**
 * CodeLanguageSelector — inline, searchable picker for a code block's language.
 *
 * Extracted from FormattingToolbar to keep the main component focused, and reworked
 * for #3001 onto the shared inline-picker primitives (`InlinePicker.tsx`) so it and
 * the callout picker read the same. A filter input at the top narrows the language
 * list via `match-sorter` (same pattern as the page/tag pickers in
 * `useBlockResolve.ts`). The input auto-focuses on open; ArrowUp / ArrowDown move a
 * visual highlight across the filtered subset; Enter selects the highlighted
 * language; Escape closes. Space is deliberately excluded from the keyboard handler
 * so it stays a regular filter character — none of the languages contain spaces
 * today, but treating Space as "select" would surprise the user.
 *
 * Apply semantics are unchanged: outside a code block, selecting a language runs
 * `toggleCodeBlockSafely(editor, { language })` (single toggle chain that both
 * converts the block AND sets the language); inside one, it updates the
 * `codeBlock` node's `language` attribute directly.
 */

import type { Editor } from '@tiptap/react'
import { matchSorter } from 'match-sorter'
import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PickerFilterInput,
  PickerRow,
  useInlinePickerKeyboard,
} from '@/components/editor-toolbar/InlinePicker'
import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'
import { CODE_LANGUAGES } from '@/lib/toolbar-config'

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

  const { focusedIndex, handleFilterKeyDown } = useInlinePickerKeyboard({
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
    onClose,
  })

  return (
    <div className="flex flex-col gap-0.5">
      <PickerFilterInput
        value={filter}
        onChange={setFilter}
        ariaLabel={t('toolbar.codeBlockLanguage')}
        onKeyDown={handleFilterKeyDown}
      />
      {filteredLanguages.map((lang, idx) => (
        <PickerRow
          key={lang}
          label={lang}
          active={currentLanguage === lang}
          focused={idx === focusedIndex}
          onSelect={() => applyLanguage(lang)}
        />
      ))}
      {showCustom && (
        // #215 P2-10 — no built-in match: apply the raw typed language.
        <>
          <span className="px-2 py-1 text-xs text-muted-foreground" data-testid="no-language-match">
            {t('toolbar.noLanguageMatch')}
          </span>
          <PickerRow
            label={t('toolbar.useCustomLanguage', { language: customLang })}
            focused={focusedIndex === 0}
            testId="use-custom-language"
            onSelect={() => applyLanguage(customLang)}
          />
        </>
      )}
      <PickerRow
        label={t('toolbar.plainText')}
        active={isCodeBlock && !currentLanguage}
        onSelect={() => {
          if (isCodeBlock) {
            editor.chain().focus().updateAttributes('codeBlock', { language: '' }).run()
          } else {
            toggleCodeBlockSafely(editor)
          }
          onClose()
        }}
      />
    </div>
  )
}
