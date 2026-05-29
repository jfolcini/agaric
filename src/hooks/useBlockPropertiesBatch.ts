/**
 * useBlockPropertiesBatch — batch-fetches per-block "extra" properties
 * (everything except `todo_state`, `priority`, `due_date`,
 * `scheduled_date`) for the currently-loaded block list.
 *
 * Returns a `{ blockId: { key, value }[] }` map keyed by block id.
 * Built-in fields are filtered out because they already render via the
 * dedicated badges (TodoToggle, PriorityBadge, DueChip, ScheduleChip).
 * Empty values are dropped so the row UI doesn't render empty rows.
 * Extracted from BlockTree.tsx for MAINT-128.
 *
 * Identity invariants (PEND/perf): the effect re-fires only when the
 * *set of block ids* changes, not on every fresh `blocks` array — a
 * drag-drop / indent in the page store creates a new outer array even
 * when the same ids are present, and re-issuing the IPC on every move
 * would defeat `SortableBlockWrapper`'s `React.memo` and re-render the
 * whole tree. After the IPC resolves, per-block arrays are reused by
 * reference when their content is unchanged so memo short-circuits
 * survive a no-op refetch.
 */

import { useEffect, useMemo, useState } from 'react'

import { logger } from '../lib/logger'
import { getBatchProperties } from '../lib/tauri'

const BUILTIN_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
])

export type BlockPropertiesMap = Record<string, Array<{ key: string; value: string }>>

/**
 * True iff two `{ key, value }` arrays are element-wise equal. Used to
 * keep prior array references stable when an IPC refetch returns the
 * same data — critical for downstream `React.memo` short-circuits.
 *
 * Only handles the `{key, value}` shape this hook produces; we never
 * insert `undefined` elements, so a null-element guard is unnecessary.
 */
function arraysShallowEqual(
  a: Array<{ key: string; value: string }> | undefined,
  b: Array<{ key: string; value: string }> | undefined,
): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ae = a[i]
    const be = b[i]
    // a/b non-null + index < length means element is defined; the
    // non-null check satisfies TS without runtime cost.
    if (ae == null || be == null) return false
    if (ae.key !== be.key || ae.value !== be.value) return false
  }
  return true
}

export function useBlockPropertiesBatch(blocks: Array<{ id: string }>): BlockPropertiesMap {
  const [blockProperties, setBlockProperties] = useState<BlockPropertiesMap>({})

  // Derive both the stable signature AND the id list inside the same
  // memo. The effect depends on `idSignature` (which only changes when
  // the set/order of ids changes — NOT when the outer `blocks` array
  // is reallocated with the same ids by the page store's
  // reorder/indent/dedent path); it reads `ids` to drive the IPC.
  // ` ` (NUL) is used as the separator so the join is unambiguous
  // for any conceivable id string — not just the ULIDs this codebase
  // uses today.
  const { idSignature, ids } = useMemo(() => {
    const ids = blocks.map((b) => b.id)
    return { idSignature: ids.join(' '), ids }
  }, [blocks])

  useEffect(() => {
    if (ids.length === 0) {
      // Drop any prior payload when the visible set empties (e.g. page
      // unmounts mid-fetch) so consumers don't render stale chips.
      setBlockProperties((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    let cancelled = false
    getBatchProperties(ids)
      .then((result) => {
        if (cancelled) return
        // The IPC contract says `Record<string, PropertyRow[]>`. Any
        // other shape is a backend bug (or a test fixture that hasn't
        // mocked this command); surface it via the logger and treat
        // it as empty rather than crashing the render or silently
        // hiding the regression.
        if (result == null || typeof result !== 'object' || Array.isArray(result)) {
          logger.warn('BlockTree', 'get_batch_properties returned an unexpected payload shape', {
            actual: typeof result,
          })
          return
        }
        const record = result as Record<string, unknown>
        setBlockProperties((prev) => {
          const next: BlockPropertiesMap = {}
          let changed = Object.keys(prev).length !== Object.keys(record).length
          for (const [blockId, props] of Object.entries(record)) {
            if (!Array.isArray(props)) {
              logger.warn(
                'BlockTree',
                'get_batch_properties returned a non-array value for a block',
                { blockId, actual: typeof props },
              )
              continue
            }
            const mapped = props
              .filter((p) => !BUILTIN_PROPERTY_KEYS.has(p.key))
              .map((p) => ({
                key: p.key,
                value:
                  p.value_text ??
                  p.value_date ??
                  (p.value_num != null ? String(p.value_num) : '') ??
                  '',
              }))
              .filter((p) => p.value !== '')
            // Reuse the prior array reference if the content is identical
            // — keeps `properties` prop stable across renders so
            // `SortableBlockWrapper`'s `React.memo` can short-circuit.
            const prior = prev[blockId]
            if (arraysShallowEqual(prior, mapped)) {
              if (prior !== undefined) next[blockId] = prior
            } else {
              next[blockId] = mapped
              changed = true
            }
          }
          return changed ? next : prev
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        logger.warn('BlockTree', 'Failed to load batch properties for blocks', undefined, err)
      })
    return () => {
      cancelled = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- ids/ids.length are read inside the effect; ids is recomputed in the same memo as idSignature (the listed dep) so it changes iff the signature changes. A fresh array identity each render would defeat the signature-keyed refetch.
  }, [idSignature])

  return blockProperties
}
