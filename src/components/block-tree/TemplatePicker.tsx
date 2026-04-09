/**
 * TemplatePicker — floating dialog for selecting a template page.
 *
 * Extracted from BlockTree.tsx.  A well-isolated presentational component
 * that receives all data via props.
 */

import type React from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface TemplatePickerProps {
  templatePages: Array<{ id: string; content: string; preview: string | null }>
  onSelect: (templatePageId: string) => void
  onClose: () => void
}

export function TemplatePicker({
  templatePages,
  onSelect,
  onClose,
}: TemplatePickerProps): React.ReactElement {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dialog = dialogRef.current
        if (!dialog) return
        const buttons = dialog.querySelectorAll<HTMLElement>('button')
        if (buttons.length === 0) return
        const current = document.activeElement as HTMLElement
        const idx = Array.from(buttons).indexOf(current)
        const next =
          e.key === 'ArrowDown'
            ? (idx + 1) % buttons.length
            : (idx - 1 + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const btn = dialogRef.current?.querySelector<HTMLElement>('button')
    btn?.focus()
  }, [])

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('slash.templatePicker')}
        className="fixed z-50 rounded-md border bg-popover p-2 shadow-lg left-1/2 top-1/3 -translate-x-1/2 min-w-[200px] max-w-[calc(100vw-2rem)] sm:max-w-[300px] max-sm:left-2 max-sm:right-2 max-sm:translate-x-0"
      >
        <ScrollArea className="max-h-[60vh]">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            {t('slash.selectTemplate')}
          </p>
          {templatePages.map((tp) => (
            <button
              key={tp.id}
              type="button"
              className="w-full text-left rounded px-2 py-1.5 text-sm hover:bg-accent transition-colors touch-target"
              onClick={() => onSelect(tp.id)}
            >
              <span className="font-medium">{tp.content || t('block.untitled')}</span>
              {tp.preview && (
                <span className="block text-xs text-muted-foreground truncate">{tp.preview}</span>
              )}
            </button>
          ))}
        </ScrollArea>
      </div>
    </>
  )
}
