/**
 * useExtraBlockProperties — derives the per-block "extra" property map
 * (everything except `todo_state`, `priority`, `due_date`,
 * `scheduled_date`) for the row UI from the shared
 * `BatchPropertiesProvider` (see `useBatchPropertyRows`).
 *
 * #2288: this hook USED to fire its own page-wide `getBatchProperties`
 * IPC over the windowed block ids — the exact same batch the
 * `BatchPropertiesProvider` already issues for image-property and
 * dependency-indicator consumers. That double-batched the identical
 * data with divergent invalidation. It now reads the raw
 * `PropertyRow[]` the provider already fetched and reshapes it into the
 * `{ blockId: { key, value }[] }` map the row UI wants. There is a
 * SINGLE page-wide batch (the provider's) and this hook is a pure
 * projection of it — so it MUST be called inside a
 * `BatchPropertiesProvider`. Outside one (`useBatchPropertyRows()` →
 * `null`, e.g. isolated unit renders) it returns an empty map.
 *
 * Because it now sources data from the provider it also inherits the
 * provider's stronger invalidation: the row chips refresh on every
 * `block:properties-changed` event and on space switch (the provider's
 * `invalidationKey`), not only when the set of block ids changes.
 *
 * Built-in fields are filtered out because they already render via the
 * dedicated badges (TodoToggle, PriorityBadge, DueChip, ScheduleChip).
 * Empty values are dropped so the row UI doesn't render empty rows.
 *
 * Identity invariants (PEND/perf): the derived map keeps prior per-block
 * array references when their content is unchanged so downstream
 * `React.memo` short-circuits (`SortableBlockWrapper`) survive a no-op
 * refetch. A drag-drop / indent in the page store reallocates the outer
 * `blocks` array with the SAME ids; because the provider keys its fetch
 * on id membership it does NOT refetch on such a move, so the raw rows
 * (and therefore this projection) stay reference-stable.
 */

import { useMemo, useRef } from 'react'

import { useBatchPropertyRows } from '@/hooks/useBatchPropertyRows'
import type { PropertyRow } from '@/lib/tauri'

const BUILTIN_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
])

export type BlockPropertiesMap = Record<string, Array<{ key: string; value: string }>>

/**
 * True iff two `{ key, value }` arrays are element-wise equal. Used to
 * keep prior array references stable when the underlying batch refetches
 * and returns the same data — critical for downstream `React.memo`
 * short-circuits.
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

/**
 * Reshape a block's raw `PropertyRow[]` into the row-UI `{ key, value }[]`
 * shape: drop the built-in badge fields, flatten the typed value columns
 * (text → date → num), and drop empty values.
 */
function mapRows(rows: readonly PropertyRow[]): Array<{ key: string; value: string }> {
  return rows
    .filter((p) => !BUILTIN_PROPERTY_KEYS.has(p.key))
    .map((p) => ({
      key: p.key,
      value: p.value_text ?? p.value_date ?? (p.value_num != null ? String(p.value_num) : '') ?? '',
    }))
    .filter((p) => p.value !== '')
}

export function useExtraBlockProperties(blocks: Array<{ id: string }>): BlockPropertiesMap {
  const batch = useBatchPropertyRows()
  // The provider's `get` identity changes iff its underlying map is
  // rebuilt — i.e. on a (re)fetch. It stays stable across drag/reorder
  // (no refetch), so keying the projection on it re-derives exactly when
  // fresh data lands and never in between.
  const get = batch?.get

  // Derive both the stable id signature AND the id list in one memo. The
  // NUL separator makes the join unambiguous for any id string.
  const { idSignature, ids } = useMemo(() => {
    const blockIds = blocks.map((b) => b.id)
    return { idSignature: blockIds.join('\0'), ids: blockIds }
  }, [blocks])

  // Holds the previously-returned map so we can reuse per-block array
  // references (and the whole-map reference) across re-derivations.
  const prevRef = useRef<BlockPropertiesMap>({})

  return useMemo(() => {
    const prev = prevRef.current
    const next: BlockPropertiesMap = {}
    let changed = false

    for (const id of ids) {
      const rows = get?.(id)
      // Block not present in the batch yet — initial fetch still pending,
      // or the id hasn't entered the provider's window (`undefined`). A
      // block the provider HAS fetched and confirmed has no properties
      // reads as `[]` (#2701) and falls through to `next[id] = []` below —
      // behaviorally equivalent to omitting the key for every downstream
      // consumer (both render zero rows).
      if (rows == null) continue
      const mapped = mapRows(rows)
      const prior = prev[id]
      if (arraysShallowEqual(prior, mapped)) {
        // Content unchanged — reuse the prior array reference so
        // `SortableBlockWrapper`'s `React.memo` can short-circuit.
        if (prior !== undefined) next[id] = prior
      } else {
        next[id] = mapped
        changed = true
      }
    }

    // A block that had an entry before but is now gone (dropped from the
    // window, or the backend no longer returns rows for it) counts as a
    // change even though the loop above only ever ADDS keys.
    if (!changed) {
      for (const key of Object.keys(prev)) {
        if (!(key in next)) {
          changed = true
          break
        }
      }
    }

    const result = changed ? next : prev
    prevRef.current = result
    return result
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `ids` is read inside but recomputed in the same memo as `idSignature` (the listed dep) so it changes iff the signature changes; a fresh array identity each render would defeat the signature-keyed projection. `get` re-derives the projection whenever the shared batch refetches.
  }, [idSignature, get])
}
