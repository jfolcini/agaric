import { Pencil } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useRichContentCallbacks, useTagClickHandler } from '../hooks/useRichContentCallbacks'
import { cn } from '../lib/utils'
import { renderRichContent } from './RichContentRenderer'

export interface PageTitleEditorProps {
  title: string
  editableTitle: string
  titleRef: React.RefObject<HTMLDivElement | null>
  onInput: (e: React.FormEvent<HTMLDivElement>) => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  /** Fired on keyup so the parent can track the caret offset (#286). */
  onKeyUp?: () => void
}

/** Check whether the title contains inline tokens that need rich rendering. */
function hasInlineTokens(text: string): boolean {
  return text.includes('[[') || text.includes('#[')
}

const TITLE_CLASS = cn(
  'flex-1 text-xl font-semibold outline-hidden rounded-md px-1 cursor-text',
  'focus:ring-2 focus:ring-ring/50',
  'hover:bg-accent/5 focus-within:bg-accent/5 transition-colors',
)

export function PageTitleEditor({
  title,
  titleRef,
  onInput,
  onBlur,
  onKeyDown,
  onKeyUp,
}: PageTitleEditorProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const richCallbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()

  const needsRich = hasInlineTokens(title)

  // Plain-text title or currently editing: render the contentEditable div
  if (!needsRich || editing) {
    return (
      <div
        ref={titleRef as React.RefObject<HTMLDivElement>}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- contentEditable div editing rich inline-token title; <input>/<textarea> cannot host the chip markup
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
        onKeyUp={onKeyUp}
      >
        {title}
      </div>
    )
  }

  // Rich display mode: render parsed title with pill chips
  return (
    <div className="relative group flex flex-1 items-center">
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- rich display surface hosting parsed pill chips; <input>/<textarea> cannot render that markup
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
        {/* PageTitleEditor wraps content in role="textbox"; keep chips inert
            to avoid nested-interactive. `onTagClick` is threaded so the gate
            can be flipped later. See UX-249. */}
        {renderRichContent(title, { interactive: false, onTagClick, ...richCallbacks })}
      </div>
      <Pencil
        aria-hidden="true"
        className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-60 group-focus-within:opacity-60 transition-opacity pointer-events-none"
      />
    </div>
  )
}
