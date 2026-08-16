/**
 * usePropertyDefForEdit — loads the property definition for the prop the
 * user is currently editing, and exposes the derived UI state needed by
 * the property-editor popover (select options / ref-page picker / search).
 *
 * Owns: `selectOptions`, `isRefProp`, `refPages`, `refSearch`, `valueType`.
 * Resets everything when `editingProp` becomes `null`. Failures are logged
 * via `logger.warn` and degrade to a plain text input.
 *
 * Extracted from `SortableBlock`.
 */

import { useEffect, useState } from 'react'

import { unwrap } from '@/lib/app-error'
import type { BlockRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

export interface UsePropertyDefForEditReturn {
  selectOptions: string[] | null
  isRefProp: boolean
  refPages: BlockRow[]
  refSearch: string
  setRefSearch: (search: string) => void
  /**
   * The value type of the property definition currently being edited
   * (`'text' | 'number' | 'date' | 'select' | 'ref' | 'boolean'`), or `null`
   * when no type has been resolved *for the current key* — i.e. nothing is
   * being edited, or the `getPropertyDef(editingProp.key)` lookup is still in
   * flight. A lookup that MISSES resolves to `'text'`, not `null`; `null`
   * means "unknown yet", never "no definition".
   *
   * #3275 — this is what lets `BlockPropertyEditor` route inline chip edits
   * through `buildPropertyParams` instead of hard-coding `value_text` and
   * nulling every other typed column.
   *
   * `null` is a hard "do not commit" signal for consumers: writing against a
   * guessed type is a data-loss bug (a `date` string pushed through
   * `Number(...)` lands as garbage in `value_num`), so `BlockPropertyEditor`
   * aborts the commit and toasts instead of assuming `'text'`.
   *
   * NOTE: unlike `BlockPropertyDrawer`, this hook cannot fall back to a
   * synchronous default. The drawer holds a `definitions` ARRAY that is
   * loaded once and already in memory before any edit starts, so its
   * `getType(key)` is a pure synchronous lookup whose `?? 'text'` fallback
   * can only mean "no such definition". This hook re-fetches per key on every
   * `editingProp` change, so a `?? 'text'` here would be indistinguishable
   * from "still loading" — and, worse, a plain `valueType` state would keep
   * showing the PREVIOUS key's type until the new fetch landed. The resolved
   * type is therefore stored together with the key it belongs to and read
   * back only for a matching key.
   */
  valueType: string | null
}

export function usePropertyDefForEdit(
  editingProp: { key: string; value: string } | null,
): UsePropertyDefForEditReturn {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [selectOptions, setSelectOptions] = useState<string[] | null>(null)
  const [isRefProp, setIsRefProp] = useState(false)
  const [refPages, setRefPages] = useState<BlockRow[]>([])
  const [refSearch, setRefSearch] = useState('')
  // #3275 (review finding 1) — the resolved type is stored WITH the key it was
  // resolved for. Storing a bare `valueType` string let a key switch expose the
  // previous property's type for the whole duration of the new lookup, and a
  // commit landing in that window wrote the value into the wrong typed column.
  const [resolvedType, setResolvedType] = useState<{ key: string; valueType: string } | null>(null)

  useEffect(() => {
    if (!editingProp) {
      setSelectOptions(null)
      setIsRefProp(false)
      setRefPages([])
      setRefSearch('')
      setResolvedType(null)
      return
    }
    const key = editingProp.key
    let stale = false
    // Single-key PK lookup instead of paginating the
    // entire property-definition vocabulary every time the user opens
    // the per-block property-editor popover.
    commands
      .getPropertyDef(key)
      .then(unwrap)
      .then((def) => {
        if (stale) return
        // A lookup MISS (unknown key / no definition row) is a real answer:
        // 'text', the same fallback `BlockPropertyDrawer.getType` applies to
        // its already-loaded `definitions` array. It is tagged with `key` so
        // it is only ever read back for the key it was resolved for.
        setResolvedType({ key, valueType: def?.value_type ?? 'text' })
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
          // #2248 — `listBlocks` requires an active space; there is no
          // cross-space listing. With no active space, skip the fetch and
          // leave the ref-page list empty rather than invoking (which would
          // throw in `requireActiveScope`).
          if (!currentSpaceId) {
            if (!stale) setRefPages([])
          } else {
            commands
              .listBlocks(
                {
                  parentId: null,
                  blockType: 'page',
                  tagId: null,
                  date: null,
                  dateRange: null,
                  source: null,
                  cursor: null,
                  limit: null,
                },
                { kind: 'active', space_id: currentSpaceId },
              )
              .then(unwrap)
              .then((res) => {
                if (!stale) setRefPages(res.items)
              })
              .catch((err) => {
                logger.warn('SortableBlock', 'ref page resolution failed', undefined, err)
                if (!stale) setRefPages([])
              })
          }
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
        // A failed lookup degrades to the plain text input, so the commit path
        // gets the matching 'text' type rather than being blocked forever.
        setResolvedType({ key, valueType: 'text' })
      })
    return () => {
      stale = true
    }
  }, [editingProp, currentSpaceId])

  // Derived during RENDER, not stored: a key switch cannot expose the previous
  // key's type for even a single render, no matter how the effect/promise
  // ordering falls out.
  const valueType =
    editingProp !== null && resolvedType?.key === editingProp.key ? resolvedType.valueType : null

  return { selectOptions, isRefProp, refPages, refSearch, setRefSearch, valueType }
}
