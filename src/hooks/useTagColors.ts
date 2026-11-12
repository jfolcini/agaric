/**
 * useTagColors — the tag colours the Tags view paints, and the one tag whose
 * colour picker is open.
 *
 * A tag paints its synced `color` property, else its localStorage colour. A
 * colour is written to localStorage first, then to the property; a failed
 * property write only logs and leaves the synced colour as it was.
 */

import { useCallback, useMemo, useState } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { clearTagColor, getTagColors, setTagColor } from '@/lib/tag-colors'
import { useResolveStore } from '@/stores/resolve'

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
  const [localColors, setLocalColors] = useState<Record<string, string>>(getTagColors)
  const syncedColors = useResolveStore((s) => s.tagColors)
  const tagColors = useMemo(
    () => ({ ...localColors, ...syncedColors }),
    [localColors, syncedColors],
  )
  const [colorPickerOpen, setColorPickerOpen] = useState<string | null>(null)

  const setColor = useCallback(async (tagId: string, color: string) => {
    setTagColor(tagId, color)
    setLocalColors((prev) => ({ ...prev, [tagId]: color }))
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
      useResolveStore.getState().setSyncedTagColor(tagId, color)
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
    setLocalColors((prev) => {
      const next = { ...prev }
      delete next[tagId]
      return next
    })
    setColorPickerOpen(null)
    try {
      unwrap(await commands.deleteProperty(tagId, 'color'))
      useResolveStore.getState().setSyncedTagColor(tagId, null)
    } catch (err) {
      logger.warn('useTagColors', 'failed to clear tag color via deleteProperty', { tagId }, err)
    }
  }, [])

  return { tagColors, colorPickerOpen, setColorPickerOpen, setColor, clearColor }
}
