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
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseDate } from '@/lib/parse-date'

/** Delay (ms) before NL date parsing fires while typing. */
const NL_PARSE_DEBOUNCE_MS = 300

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPendingParse = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  // Re-sync when the external value changes (e.g. prop updated by parent)
  useEffect(() => {
    setDateInput(initialValue)
    setDatePreview(null)
    setDateError(false)
    cancelPendingParse()
  }, [initialValue, cancelPendingParse])

  // Cancel pending parse on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value
      setDateInput(raw)
      setDateError(false)
      cancelPendingParse()
      const trimmed = raw.trim()
      if (!trimmed) {
        setDatePreview(null)
        return
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        // ISO is synchronous and reliable
        setDatePreview(trimmed)
        return
      }
      // Debounce NL parse — only set datePreview when parsing succeeds, so
      // partial keystrokes (e.g. "tomo" on the way to "tomorrow") do not
      // briefly flash a null preview or stale "could not parse" hints.
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        const parsed = parseDate(trimmed)
        if (parsed) setDatePreview(parsed)
      }, NL_PARSE_DEBOUNCE_MS)
    },
    [cancelPendingParse],
  )

  const handleBlur = useCallback(() => {
    cancelPendingParse()
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
  }, [dateInput, onSave, cancelPendingParse])

  return { dateInput, setDateInput, datePreview, dateError, handleChange, handleBlur }
}
