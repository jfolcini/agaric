/**
 * BlockDatePicker — floating date picker overlay with text input + calendar.
 *
 * Renders a modal-like popover with:
 *   - A text input that accepts natural language dates (today, +3d, Apr 15)
 *   - A Calendar widget for visual date selection
 *   - Escape to close, focus-trap via Tab
 *
 * Extracted from BlockTree.tsx for file organization (F-22).
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseDate } from '../../lib/parse-date'
import { Calendar } from '../ui/calendar'

export function BlockDatePicker({
  onSelect,
  onClose,
}: {
  onSelect: (day: Date | undefined) => void
  onClose: () => void
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [dateTextInput, setDateTextInput] = useState('')
  const [dateTextPreview, setDateTextPreview] = useState<string | null>(null)

  /** Convert a parsed YYYY-MM-DD string to a Date and call onSelect. */
  const handleDateSelected = useCallback(
    (dateStr: string) => {
      const [y, m, d] = dateStr.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      onSelect(date)
    },
    [onSelect],
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      // Focus trap: keep Tab within the dialog
      if (e.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'a[href], input, select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Auto-focus the text input on mount
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const input = dialog.querySelector<HTMLElement>('input')
    input?.focus()
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
        aria-label="Date picker"
        className="date-picker-popup fixed z-50 rounded-md border bg-popover p-2 shadow-lg left-1/2 top-1/3 -translate-x-1/2 max-[479px]:left-2 max-[479px]:right-2 max-[479px]:translate-x-0 max-[479px]:max-h-[70vh] max-[479px]:overflow-y-auto"
      >
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="flex-1 rounded border px-2 py-1 text-sm"
              placeholder="Type a date... (today, +3d, Apr 15)"
              value={dateTextInput}
              onChange={(e) => {
                setDateTextInput(e.target.value)
                const parsed = parseDate(e.target.value)
                setDateTextPreview(parsed)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dateTextPreview) {
                  e.preventDefault()
                  handleDateSelected(dateTextPreview)
                  setDateTextInput('')
                  setDateTextPreview(null)
                }
              }}
              aria-label="Type a date"
            />
          </div>
          {dateTextInput && (
            <p className="mt-1 text-xs text-muted-foreground">
              {dateTextPreview ? (
                <>
                  Parsed: <strong>{dateTextPreview}</strong> (press Enter to apply)
                </>
              ) : (
                <span className="text-destructive">Could not parse date</span>
              )}
            </p>
          )}
        </div>
        <Calendar mode="single" weekStartsOn={1} showOutsideDays onSelect={onSelect} />
      </div>
    </>
  )
}
