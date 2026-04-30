/**
 * useLocalStoragePreference — typed, defensive localStorage-backed
 * `useState`. Replaces three inconsistent ad-hoc variants in DuePanel /
 * useAgendaPreferences / DeadlineWarningSection (MAINT-129).
 *
 * Defensive against the three failure modes localStorage exhibits:
 *   1. Read throws (e.g. SecurityError in private mode) → fall back to
 *      `defaultValue`, log via the structured logger.
 *   2. Stored value can't be parsed (`parse` throws / invalid JSON) →
 *      fall back to `defaultValue`. No log — invalid stored data is
 *      common after schema migrations and not actionable.
 *   3. Write throws (quota exceeded, private mode) → swallow + log.
 *
 * The default `parse`/`serialize` use JSON. Pass custom transformers
 * when the existing on-disk format is a bare string that JSON can't
 * handle — e.g. `'date'` (not `'"date"'`) for legacy preferences.
 */

import { useCallback, useEffect, useState } from 'react'
import { logger } from '../lib/logger'

export interface LocalStoragePreferenceOptions<T> {
  /** Convert the raw stored string into a value. May throw on invalid input. */
  parse?: (raw: string) => T
  /** Convert the value back to a string for storage. */
  serialize?: (value: T) => string
  /**
   * Source label for `logger.warn` calls. Defaults to
   * `'useLocalStoragePreference'`.
   */
  source?: string
}

const DEFAULT_PARSE = <T>(raw: string): T => JSON.parse(raw) as T
const DEFAULT_SERIALIZE = <T>(value: T): string => JSON.stringify(value)

export function useLocalStoragePreference<T>(
  key: string,
  defaultValue: T,
  options: LocalStoragePreferenceOptions<T> = {},
): [T, (value: T | ((prev: T) => T)) => void] {
  const parse = options.parse ?? DEFAULT_PARSE<T>
  const serialize = options.serialize ?? DEFAULT_SERIALIZE<T>
  const source = options.source ?? 'useLocalStoragePreference'

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return defaultValue
      try {
        return parse(raw)
      } catch {
        // Invalid stored data — fall back silently. Not log-worthy: a
        // schema/format migration will hit this on first read.
        return defaultValue
      }
    } catch (err) {
      logger.warn(source, 'Failed to read localStorage preference', { key }, err)
      return defaultValue
    }
  })

  // Persist on every change. The effect runs once on mount with the
  // initial value (a no-op overwrite that matches the existing pattern
  // in `useAgendaPreferences`) and on every subsequent setValue call.
  // `serialize` and `source` are intentionally excluded — they're stable
  // once provided, and including them re-runs the effect every render
  // when callers inline-construct the options object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialize/source intentionally omitted
  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value))
    } catch (err) {
      logger.warn(source, 'Failed to write localStorage preference', { key }, err)
    }
  }, [key, value])

  const setPreference = useCallback((next: T | ((prev: T) => T)) => {
    setValue(next)
  }, [])

  return [value, setPreference]
}
