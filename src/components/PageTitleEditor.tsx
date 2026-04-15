import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import { renderRichContent } from './RichContentRenderer'

export interface PageTitleEditorProps {
  title: string
  editableTitle: string
  titleRef: React.RefObject<HTMLDivElement | null>
  onInput: (e: React.FormEvent<HTMLDivElement>) => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

/** Check whether the title contains inline tokens that need rich rendering. */
function hasInlineTokens(text: string): boolean {
  return text.includes('[[') || text.includes('#[')
}

const TITLE_CLASS = [
  'flex-1 text-xl font-semibold outline-hidden rounded-md px-1',
  'focus:ring-2 focus:ring-ring/50',
  'hover:bg-accent/5 focus-within:bg-accent/5 transition-colors',
].join(' ')

export function PageTitleEditor({
  title,
  titleRef,
  onInput,
  onBlur,
  onKeyDown,
}: PageTitleEditorProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const richCallbacks = useRichContentCallbacks()

  const needsRich = hasInlineTokens(title)

  // Plain-text title or currently editing: render the contentEditable div
  if (!needsRich || editing) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: contentEditable div is intentional for inline title editing
      <div
        ref={titleRef as React.RefObject<HTMLDivElement>}
        role="textbox"
        tabIndex={0}
        aria-label={t('pageHeader.pageTitle')}
        contentEditable
        suppressContentEditableWarning
        className={TITLE_CLASS}
        onInput={onInput}
        onBlur={() => {
          setEditing(false)
          onBlur()
        }}
        onKeyDown={onKeyDown}
      >
        {title}
      </div>
    )
  }

  // Rich display mode: render parsed title with pill chips
  return (
    // biome-ignore lint/a11y/useSemanticElements: display div mirrors the contentEditable textbox role for consistency
    <div
      role="textbox"
      tabIndex={0}
      aria-label={t('pageHeader.pageTitle')}
      className={TITLE_CLASS}
      onClick={() => {
        setEditing(true)
        requestAnimationFrame(() => {
          titleRef.current?.focus()
        })
      }}
      onFocus={() => {
        setEditing(true)
        requestAnimationFrame(() => {
          titleRef.current?.focus()
        })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setEditing(true)
          requestAnimationFrame(() => {
            titleRef.current?.focus()
          })
        }
      }}
    >
      {renderRichContent(title, { interactive: false, ...richCallbacks })}
    </div>
  )
}
