import type React from 'react'
import { useTranslation } from 'react-i18next'

export interface PageTitleEditorProps {
  title: string
  editableTitle: string
  titleRef: React.RefObject<HTMLDivElement | null>
  onInput: (e: React.FormEvent<HTMLDivElement>) => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

export function PageTitleEditor({
  title,
  titleRef,
  onInput,
  onBlur,
  onKeyDown,
}: PageTitleEditorProps) {
  const { t } = useTranslation()

  return (
    // biome-ignore lint/a11y/useSemanticElements: contentEditable div is intentional for inline title editing
    <div
      ref={titleRef as React.RefObject<HTMLDivElement>}
      role="textbox"
      tabIndex={0}
      aria-label={t('pageHeader.pageTitle')}
      contentEditable
      suppressContentEditableWarning
      className={[
        'flex-1 text-xl font-semibold outline-none rounded-md px-1',
        'focus:ring-2 focus:ring-ring/50',
        'hover:bg-accent/5 focus-within:bg-accent/5 transition-colors',
      ].join(' ')}
      onInput={onInput}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {title}
    </div>
  )
}
