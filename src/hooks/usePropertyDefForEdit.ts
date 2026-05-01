/**
 * usePropertyDefForEdit — loads the property definition for the prop the
 * user is currently editing, and exposes the derived UI state needed by
 * the property-editor popover (select options / ref-page picker / search).
 *
 * Owns: `selectOptions`, `isRefProp`, `refPages`, `refSearch`. Resets
 * everything when `editingProp` becomes `null`. Failures are logged via
 * `logger.warn` and degrade to a plain text input.
 *
 * Extracted from `SortableBlock` (MAINT-128).
 */

import { useEffect, useState } from 'react'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import { listBlocks, listPropertyDefs } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

export interface UsePropertyDefForEditReturn {
  selectOptions: string[] | null
  isRefProp: boolean
  refPages: BlockRow[]
  refSearch: string
  setRefSearch: (search: string) => void
}

export function usePropertyDefForEdit(
  editingProp: { key: string; value: string } | null,
): UsePropertyDefForEditReturn {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [selectOptions, setSelectOptions] = useState<string[] | null>(null)
  const [isRefProp, setIsRefProp] = useState(false)
  const [refPages, setRefPages] = useState<BlockRow[]>([])
  const [refSearch, setRefSearch] = useState('')

  useEffect(() => {
    if (!editingProp) {
      setSelectOptions(null)
      setIsRefProp(false)
      setRefPages([])
      setRefSearch('')
      return
    }
    let stale = false
    listPropertyDefs()
      .then((defs) => {
        if (stale) return
        const def = defs.find((d) => d.key === editingProp.key)
        if (def?.value_type === 'select' && def.options) {
          try {
            setSelectOptions(JSON.parse(def.options) as string[])
          } catch (err) {
            logger.warn(
              'SortableBlock',
              'failed to parse select options',
              {
                key: def.key,
                options: def.options,
              },
              err,
            )
            setSelectOptions(null)
          }
          setIsRefProp(false)
        } else if (def?.value_type === 'ref') {
          setIsRefProp(true)
          setSelectOptions(null)
          // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. The `?? ''`
          // fallback is intentional pre-bootstrap behaviour: empty
          // string forces a no-match SQL filter rather than a runtime
          // null deref.
          listBlocks({ blockType: 'page', spaceId: currentSpaceId ?? '' })
            .then((res) => {
              if (!stale) setRefPages(res.items)
            })
            .catch((err) => {
              logger.warn('SortableBlock', 'ref page resolution failed', undefined, err)
              if (!stale) setRefPages([])
            })
        } else {
          setSelectOptions(null)
          setIsRefProp(false)
        }
      })
      .catch((err) => {
        logger.warn('SortableBlock', 'property def resolution failed', undefined, err)
        if (stale) return
        setSelectOptions(null)
        setIsRefProp(false)
      })
    return () => {
      stale = true
    }
  }, [editingProp, currentSpaceId])

  return { selectOptions, isRefProp, refPages, refSearch, setRefSearch }
}
