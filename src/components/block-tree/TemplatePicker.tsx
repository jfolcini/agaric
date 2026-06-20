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

/**
 * Tab / Shift+Tab cycle focus *within* the picker so it honours its
 * aria-modal="true" claim (CR-A11Y, #151). Without this, Tab escapes to the
 * rest of the document while the dialog still announces itself as modal — a
 * lie to assistive tech.
 */
function trapTabFocus(dialog: HTMLElement, shiftKey: boolean): void {
  const buttons = dialog.querySelectorAll<HTMLElement>('button')
  if (buttons.length === 0) return
  const first = buttons[0]
  const last = [...buttons].at(-1)
  const active = document.activeElement as HTMLElement | null
  const atEdge = shiftKey ? active === first : active === last
  if (atEdge || !dialog.contains(active)) {
    ;(shiftKey ? last : first)?.focus()
    return
  }
  const idx = Array.from(buttons).indexOf(active as HTMLElement)
  buttons[shiftKey ? idx - 1 : idx + 1]?.focus()
}

/** ArrowUp/ArrowDown roving focus between the template buttons (wrapping). */
function moveFocusWithArrows(dialog: HTMLElement, key: 'ArrowDown' | 'ArrowUp'): void {
  const buttons = dialog.querySelectorAll<HTMLElement>('button')
  if (buttons.length === 0) return
  const current = document.activeElement as HTMLElement
  const idx = Array.from(buttons).indexOf(current)
  const next =
    key === 'ArrowDown' ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length
  buttons[next]?.focus()
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
        e.stopPropagation()
        onClose()
        return
      }
      const dialog = dialogRef.current
      if (!dialog) return
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        trapTabFocus(dialog, e.shiftKey)
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        moveFocusWithArrows(dialog, e.key)
      }
    }
    // Capture phase so the picker sees Escape/Arrow keys BEFORE the TipTap
    // editor's container-level capture listener (useBlockKeyboard attaches a
    // capture-phase keydown listener on `editor.view.dom.parentElement` that
    // calls stopPropagation()). A capture-phase listener on `document` fires
    // before any element-level capture listener below it, so the picker
    // dependably claims these keys whenever it is open — regardless of
    // whether focus is still inside the editor (a separate race where the
    // editor re-focuses itself after mount/auto-focus effects run).
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  useEffect(() => {
    // Remember whoever was focused before the picker opened (typically the
    // editor / trigger) so we can restore focus to it on close — the second
    // half of a real focus trap (CR-A11Y, #151).
    const previouslyFocused = document.activeElement as HTMLElement | null
    const btn = dialogRef.current?.querySelector<HTMLElement>('button')
    btn?.focus()
    return () => {
      previouslyFocused?.focus?.()
    }
  }, [])

  return (
    <>
      {/* Presentational backdrop: click-to-dismiss only. Keyboard users
          dismiss via Escape (handled by the document keydown listener above);
          role="presentation" marks it as non-interactive scenery, matching
          JournalCalendarDropdown's backdrop. */}
      <div role="presentation" className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={dialogRef}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA dialog pattern; a native <dialog> needs showModal()/close() imperative control and provides its own backdrop/focus-trap, which would conflict with this custom positioned picker
        role="dialog"
        aria-modal="true"
        aria-label={t('slash.templatePicker')}
        // `data-editor-portal` tells `useEditorBlur` to keep the TipTap editor
        // mounted while the picker is open (via EDITOR_PORTAL_SELECTORS).
        // Without it the editor unmounts on button-focus, clearing
        // `focusedBlockId`, so `handleTemplateSelect` bails out with no
        // Template inserted and no toast. See -B.
        data-editor-portal=""
        className="fixed z-50 rounded-md border bg-popover p-2 shadow-(--shadow-overlay) left-1/2 top-1/3 -translate-x-1/2 min-w-[200px] max-w-[calc(100vw-2rem)] sm:max-w-[300px] max-sm:left-2 max-sm:right-2 max-sm:translate-x-0"
      >
        <ScrollArea className="max-h-[60vh]">
          <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
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
