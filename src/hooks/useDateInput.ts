/**
 * useDateInput -- shared hook for date input with NL parsing and preview.
 *
 * Manages the common parseDate -> preview -> blur-save pattern used by
 * BlockPropertyDrawer (PropertyRow), PropertyRowEditor, and DateChipEditor.
 *
 * Returns controlled state (`dateInput`, `setDateInput`), a live preview
 * of the parsed date, an error flag for invalid input after blur, and
 * `handleChange` / `handleBlur` event handlers.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { parseDate } from '@/lib/parse-date'

export interface UseDateInputOptions {
  /** Initial value for the date input (e.g. from a prop). Synced on change. */
  initialValue?: string
  /** Called on blur when the input resolves to a valid date (or empty string). */
  onSave?: ((isoDate: string) => void) | undefined
}

export interface UseDateInputReturn {
  /** Current controlled value of the text input. */
  dateInput: string
  /** State setter — useful for resetting or programmatic changes. */
  setDateInput: React.Dispatch<React.SetStateAction<string>>
  /** Live ISO preview while typing, or null if unparseable / empty. */
  datePreview: string | null
  /** True after a blur with an unparseable non-empty value. */
  dateError: boolean
  /** onChange handler for the text input. */
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** onBlur handler — parses input, calls onSave, updates state. */
  handleBlur: () => void
}

export function useDateInput({
  initialValue = '',
  onSave,
}: UseDateInputOptions = {}): UseDateInputReturn {
  const [dateInput, setDateInput] = useState(initialValue)
  const [datePreview, setDatePreview] = useState<string | null>(null)
  const [dateError, setDateError] = useState(false)

  // Re-sync when the external value changes (e.g. prop updated by parent)
  useEffect(() => {
    setDateInput(initialValue)
    setDatePreview(null)
    setDateError(false)
  }, [initialValue])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setDateInput(raw)
    setDateError(false)
    const trimmed = raw.trim()
    if (!trimmed) {
      setDatePreview(null)
      return
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      setDatePreview(trimmed)
    } else {
      setDatePreview(parseDate(trimmed))
    }
  }, [])

  const handleBlur = useCallback(() => {
    const trimmed = dateInput.trim()
    setDatePreview(null)
    setDateError(false)
    if (!trimmed) {
      onSave?.('')
      return
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      onSave?.(trimmed)
      return
    }
    const parsed = parseDate(trimmed)
    if (parsed) {
      setDateInput(parsed)
      onSave?.(parsed)
    } else {
      setDateError(true)
    }
  }, [dateInput, onSave])

  return { dateInput, setDateInput, datePreview, dateError, handleChange, handleBlur }
}
