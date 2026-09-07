/**
 * useBlockPropertyIpc — typed wrapper around the trio of property IPCs
 * a single property surface (`BlockPropertyDrawer`) needs to load + edit
 * per-block properties:
 *
 *   - `getProperties(blockId)` — fetch the block's property rows
 *   - `listPropertyDefs()` — fetch the typed property definitions
 *     (vocabulary) so editors can render the right input
 *   - `setProperty(params)` — write a single property value
 *
 * Centralizes the IPC imports so the drawer is hook-driven and tests
 * can stub the hook instead of mocking three distinct exports of
 * `lib/tauri`. Mirrors the surface of `useBlockReschedule` /
 * `useLinkMetadata` / `useBatchAttachments`. final pass.
 *
 * Distinct from `useBlockProperties` (which owns task-state / priority
 * cycling against the block store) and `usePropertySave` (which owns
 * save+reload semantics with toast/announce). This hook is the
 * lower-level direct-IPC wrapper; the higher-level hooks compose it
 * (or `lib/property-save-utils` directly) when they need different
 * semantics. No state is owned here — the consumer drives loading /
 * pending / error UI as it sees fit. The hook returns stable
 * references via `useCallback` so downstream effect dependency arrays
 * are honest.
 */

import { useCallback } from 'react'

import { unwrap } from '@/lib/app-error'
import type { BlockRow, WithOps } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import {
  getProperties as getPropertiesIpc,
  listPropertyDefs as listPropertyDefsIpc,
} from '@/lib/tauri'

/** Named-param shape the drawer writes properties with. */
export interface SetPropertyParams {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
}

export interface UseBlockPropertyIpcReturn {
  /** Fetch all property rows for the given block. Throws on IPC failure. */
  getProperties: typeof getPropertiesIpc
  /** Fetch every typed property definition (the vocabulary). Throws on IPC failure. */
  listPropertyDefs: typeof listPropertyDefsIpc
  /** Write a single property row. Returns the updated `BlockRow` on success; throws on IPC failure. */
  setProperty: (params: SetPropertyParams) => Promise<WithOps<BlockRow>>
}

export function useBlockPropertyIpc(): UseBlockPropertyIpcReturn {
  const getProperties = useCallback<typeof getPropertiesIpc>(
    (blockId) => getPropertiesIpc(blockId),
    [],
  )
  const listPropertyDefs = useCallback<typeof listPropertyDefsIpc>(() => listPropertyDefsIpc(), [])
  const setProperty = useCallback(
    async (params: SetPropertyParams) =>
      unwrap(
        await commands.setProperty(params.blockId, params.key, {
          value_text: params.valueText ?? null,
          value_num: params.valueNum ?? null,
          value_date: params.valueDate ?? null,
          value_ref: params.valueRef ?? null,
          value_bool: null,
        }),
      ),
    [],
  )
  return { getProperties, listPropertyDefs, setProperty }
}
