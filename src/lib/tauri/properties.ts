import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BlockRow,
  DeletePropertyResponse,
  PageResponse,
  PropertyDefinition,
  WithOps,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'

export interface PropertyRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_date: string | null
  value_ref: string | null
  /** native boolean property storage; SQLite represents it as 0/1/null. */
  value_bool: number | null
}

/** Set (upsert) a property on a block. Exactly one value field must be non-null. */
export async function setProperty(params: {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
  valueBool?: boolean | null | undefined
}): Promise<WithOps<BlockRow>> {
  return unwrap(
    await commands.setProperty(params.blockId, params.key, {
      value_text: params.valueText ?? null,
      value_num: params.valueNum ?? null,
      value_date: params.valueDate ?? null,
      value_ref: params.valueRef ?? null,
      value_bool: params.valueBool ?? null,
    }),
  )
}

/** Delete a property from a block by key. */
/**
 * #2468: previously resolved `void`; the command now echoes `(block_id, key)`
 * plus the appended op ref(s) so callers can seed the ref-addressed undo
 * stack. Additive for legacy callers (they discard the result).
 */
export async function deleteProperty(
  blockId: string,
  key: string,
): Promise<WithOps<DeletePropertyResponse>> {
  return unwrap(await commands.deleteProperty(blockId, key))
}

/** Get all properties for a block. */
export async function getProperties(blockId: string): Promise<PropertyRow[]> {
  return unwrap(await commands.getProperties(blockId))
}

/** Get a single property row by `(block_id, key)` primary key
 *.
 *
 * Returns the row, or `null` when no property exists for `key` on the
 * given block. Replaces the pattern of calling `getProperties(blockId)`
 * (which ships every row across the IPC boundary) just to read one
 * well-known key — `loadJournalTemplateForSpace`, the `StaticBlock`
 * `image_width` read, and the three `blocked_by` dependency probes
 * (gutter cycle, slash command, checkbox syntax) all migrated to this
 * dedicated PK lookup.
 */
export async function getProperty(blockId: string, key: string): Promise<PropertyRow | null> {
  return unwrap(await commands.getProperty(blockId, key))
}

/** Batch-fetch properties for multiple blocks in a single IPC call. */
export async function getBatchProperties(
  blockIds: string[],
): Promise<Record<string, PropertyRow[]>> {
  return unwrap(await commands.getBatchProperties(blockIds))
}

// ---------------------------------------------------------------------------
// Batch count commands (#604)
// ---------------------------------------------------------------------------

/**
 * Batch set/clear an ALLOWLISTED reserved property on N blocks in one tx.
 * Allowed keys: `todo_state`, `priority`, `due_date`, `scheduled_date`.
 * Pass `value = null` to clear the property. Returns the number of live
 * blocks updated (missing / soft-deleted ids are skipped). Single IPC,
 * mirroring `setTodoStateBatch`.
 */
export async function setPropertyBatch(
  blockIds: string[],
  key: string,
  value: string | null,
): Promise<number> {
  return unwrap(await commands.setPropertyBatch(blockIds, key, value))
}

/** List all distinct property keys currently in use. */
export async function listPropertyKeys(): Promise<string[]> {
  return unwrap(await commands.listPropertyKeys())
}

/**
 * List the distinct text values in use for a property `key`, usage-ranked
 * (most-used first). Powers the property-VALUE autocomplete (#1425).
 */
export async function listPropertyValues(key: string): Promise<string[]> {
  return unwrap(await commands.listPropertyValues(key))
}

// ---------------------------------------------------------------------------
// Property definition commands
// ---------------------------------------------------------------------------

/** Create a new property definition. */
export async function createPropertyDef(params: {
  key: string
  valueType: string
  options?: string | null | undefined
}): Promise<PropertyDefinition> {
  return unwrap(
    await commands.createPropertyDef(params.key, params.valueType, params.options ?? null),
  )
}

/** Fetch a single property definition by key.
 *
 * Returns the row, or `null` when no definition exists for `key`.
 * Replaces the pattern of calling `listPropertyDefs()` (which paginates
 * the entire vocabulary) just to read one well-known key — boot
 * recovery's `priority` lookup and the per-block property-editor popover
 * each used to ship the full def list to the renderer for a one-row
 * read.
 */
export async function getPropertyDef(key: string): Promise<PropertyDefinition | null> {
  return unwrap(await commands.getPropertyDef(key))
}

/** List all property definitions, paginated.
 *
 * Returns the canonical [`PageResponse`] envelope (`items`,
 * `next_cursor`, `has_more`). Single-page consumers (the typical case
 * for property-defs picker UIs — the seeded vocabulary fits well under
 * a single page) destructure `.items` and ignore the cursor. Callers
 * that genuinely walk every page must thread `next_cursor` back via
 * `cursor` until `has_more === false`.
 *
 * Pre-M-85: `listPropertyDefs(): Promise<PropertyDefinition[]>`.
 */
export async function listPropertyDefs(opts?: {
  cursor?: string | null | undefined
  limit?: SafeLimit | null | undefined
}): Promise<PageResponse<PropertyDefinition>> {
  return unwrap(await commands.listPropertyDefs(opts?.cursor ?? null, opts?.limit ?? null))
}

/** Update the options JSON for a select-type property definition. */
export async function updatePropertyDefOptions(
  key: string,
  options: string,
): Promise<PropertyDefinition> {
  return unwrap(await commands.updatePropertyDefOptions(key, options))
}

/** Delete a property definition by key. */
export async function deletePropertyDef(key: string): Promise<void> {
  unwrap(await commands.deletePropertyDef(key))
}

// ---------------------------------------------------------------------------
// Sync / Peer-ref commands
// ---------------------------------------------------------------------------
// NOTE: Only peer_refs CRUD exists on the backend so far. Full sync protocol
// commands (startPairing, startSync, etc.) will be added when the backend
// implements them.
