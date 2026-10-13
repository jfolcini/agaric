/**
 * useTagColors — the tag colours the Tags view paints, and the one tag whose
 * colour picker is open.
 *
 * A colour is written to localStorage first, which is what renders; the
 * block's `color` property follows best-effort, so a failed write only logs.
 */

import { useCallback, useState } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { clearTagColor, getTagColors, setTagColor } from '@/lib/tag-colors'

export interface TagColors {
  /** Tag id → an accent token or a custom `#rrggbb`. */
  tagColors: Record<string, string>
  /** The tag whose colour picker is open, or null. */
  colorPickerOpen: string | null
  setColorPickerOpen: (tagId: string | null) => void
  /** Colours the tag and closes the picker. Never rejects. */
  setColor: (tagId: string, color: string) => Promise<void>
  /** Uncolours the tag and closes the picker. Never rejects. */
  clearColor: (tagId: string) => Promise<void>
}

export function useTagColors(): TagColors {
  const [tagColors, setTagColors] = useState<Record<string, string>>(getTagColors)
  const [colorPickerOpen, setColorPickerOpen] = useState<string | null>(null)

  const setColor = useCallback(async (tagId: string, color: string) => {
    setTagColor(tagId, color)
    setTagColors((prev) => ({ ...prev, [tagId]: color }))
    setColorPickerOpen(null)
    try {
      unwrap(
        await commands.setProperty(tagId, 'color', {
          value_text: color,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        }),
      )
    } catch (err) {
      logger.warn(
        'useTagColors',
        'failed to persist tag color via setProperty',
        { tagId, color },
        err,
      )
    }
  }, [])

  const clearColor = useCallback(async (tagId: string) => {
    clearTagColor(tagId)
    setTagColors((prev) => {
      const next = { ...prev }
      delete next[tagId]
      return next
    })
    setColorPickerOpen(null)
    try {
      unwrap(await commands.deleteProperty(tagId, 'color'))
    } catch (err) {
      logger.warn('useTagColors', 'failed to clear tag color via deleteProperty', { tagId }, err)
    }
  }, [])

  return { tagColors, colorPickerOpen, setColorPickerOpen, setColor, clearColor }
}
