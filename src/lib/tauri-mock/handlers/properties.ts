/**
 * Tauri mock handlers -- Block properties, property defs, and task columns (todo/priority/dates).
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import {
  type TypedHandlers,
  appErrorRejection,
  assertValidReservedPropertyValue,
  assertValidSetPropertyValue,
  notFoundRejection,
  returnEmptyPage,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, properties, propertyDefs, pushOp } from '@/lib/tauri-mock/seed'

/**
 * #3079 — reserved column-backed property keys and the block-row value channel
 * each one projects into. Mirrors the backend `reserved_key_blocks_column` /
 * `project_set_property_to_sql`: these keys are the single source of truth on
 * the block ROW, never a `block_properties` row.
 */
const RESERVED_PROPERTY_COLUMN: Record<string, 'value_text' | 'value_date'> = {
  todo_state: 'value_text',
  priority: 'value_text',
  due_date: 'value_date',
  scheduled_date: 'value_date',
}

/**
 * Route a reserved-key `set_property` onto the block's dedicated column (NOT
 * `block_properties`) and append the op. `from_value: null` keeps the op's
 * revert a no-op against the properties map — the column value is reverted via
 * the dedicated `set_<key>` op, never re-materialized into block_properties.
 * Returns the `WithOps<BlockRow>` response (or null when the block is absent).
 */
function setReservedColumnProperty(
  blockId: string,
  key: string,
  channel: 'value_text' | 'value_date',
  valueText: string | null,
  valueDate: string | null,
): Record<string, unknown> | null {
  const channelValue = channel === 'value_text' ? valueText : valueDate
  // #3091 — reserved keys carry their own value contract the backend VALIDATES
  // (never normalizes): todo_state membership (case-sensitive) and non-empty
  // dates. Enforce it here so an invalid reserved value (e.g. a lowercase
  // `done`) fails instead of landing raw on the column.
  assertValidReservedPropertyValue(key, channel, channelValue)
  const b = blocks.get(blockId)
  if (b) b[key] = channelValue
  const op = pushOp('set_property', { block_id: blockId, key, from_value: null })
  return b ? { ...b, op_refs: [{ device_id: op.device_id, seq: op.seq }] } : null
}

export const propertiesHandlers = {
  query_by_property: (args) => {
    const a = args as Record<string, unknown>
    // #2277 item 7 — every query_by_property param (key/value/operator,
    // pagination, and the push-down filters) now nests under the single
    // `request` DTO; `scope` stays a separate top-level arg.
    const req = (a['request'] as Record<string, unknown>) ?? a
    const key = req['key'] as string
    const valueText = (req['valueText'] as string | null) ?? null
    const valueDate = (req['valueDate'] as string | null) ?? null
    // Honour `scope: SpaceScope` (mirrors
    // `query_by_property_inner`). Active scope drops rows whose owning
    // page is not stamped with `space = ?spaceId`. Global passes through.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // Push-down filters, now flat fields of the `request` DTO. Mirror the
    // backend semantics so FE tests can observe the filter going through.
    //   - `excludeParentId` skips rows whose `parent_id` matches.
    //   - `contentNonEmpty` drops null/empty/whitespace-only content.
    //   - `blockType` restricts to a single block_type.
    //   - `valueTextIn` is set-membership over value_text;
    //     mutually exclusive with `valueText`.
    //   - `valueDateRange` is half-open `[from, to)`.
    const excludeParentId = ((req['excludeParentId'] as string | null) ?? null) as string | null
    const contentNonEmpty = Boolean(req['contentNonEmpty'])
    const blockType = ((req['blockType'] as string | null) ?? null) as string | null
    const valueTextIn = ((req['valueTextIn'] as string[] | null) ?? null) as string[] | null
    const valueDateRange = ((req['valueDateRange'] as [string, string] | null) ?? null) as
      | [string, string]
      | null
    // Some well-known "properties" live on the block row itself in the seed
    // data (todo_state, priority, due_date, scheduled_date, completed_at,
    // created_at). The real backend exposes them through the properties
    // system, so the frontend calls query_by_property with those keys. We
    // fall back to reading the row-level field when the properties Map is
    // Empty or doesn't carry that key.
    const ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
      todo_state: 'text',
      priority: 'text',
      due_date: 'date',
      scheduled_date: 'date',
    }
    const rowKind = ROW_FIELD_KEYS[key]
    // The predicate below mirrors the SQL evaluation order from
    // `pagination/properties.rs::query_by_property` so the mock's
    // observable behaviour matches the backend across reserved-key /
    // non-reserved / row-fallback branches plus the four pushed-down
    // filters (excludeParentId, contentNonEmpty, blockType, value_text/
    // valueTextIn, valueDate/valueDateRange). Splitting this into helpers
    // would make the SQL→TS correspondence harder to audit and would
    // duplicate the keep/drop signal across multiple closures.
    // oxlint-disable-next-line eslint/complexity -- pre-existing
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      // Active-space scoping: drop rows whose owning page
      // doesn't carry the active space ref.
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      // Push-down filters short-circuit before the property lookup so
      // the mock matches the SQL evaluation order.
      if (excludeParentId !== null && b['parent_id'] === excludeParentId) return false
      if (contentNonEmpty) {
        const content = b['content'] as string | null | undefined
        if (content == null || (content as string).trim() === '') return false
      }
      if (blockType !== null && b['block_type'] !== blockType) return false
      const blockProps = properties.get(b['id'] as string)
      const prop = blockProps?.get(key)
      const matchesValueTextIn = (v: string | null | undefined): boolean =>
        valueTextIn === null || valueTextIn.length === 0 || (v != null && valueTextIn.includes(v))
      const matchesValueDateRange = (v: string | null | undefined): boolean => {
        if (valueDateRange === null) return true
        if (v == null) return false
        const [from, to] = valueDateRange
        // Half-open `[from, to)`: include `from`, exclude `to`.
        return v >= from && v < to
      }
      if (prop) {
        if (!matchesValueTextIn(prop['value_text'] as string | null | undefined)) return false
        if (!matchesValueDateRange(prop['value_date'] as string | null | undefined)) return false
        if (valueText !== null) return prop['value_text'] === valueText
        if (valueDate !== null) return prop['value_date'] === valueDate
        return true
      }
      if (rowKind !== undefined) {
        const rowValue = b[key] as string | null | undefined
        if (rowValue == null) return false
        if (rowKind === 'text' && !matchesValueTextIn(rowValue)) return false
        if (rowKind === 'date' && !matchesValueDateRange(rowValue)) return false
        if (valueText !== null) return rowKind === 'text' && rowValue === valueText
        if (valueDate !== null) return rowKind === 'date' && rowValue === valueDate
        return true
      }
      return false
    })
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  set_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    // Typed values are bundled under `value: SetPropertyArgs` (was 4 flat
    // args). Navigate the bundle to read each typed value column.
    const valueArgs = a['value'] as Record<string, unknown> | undefined
    const valueText = (valueArgs?.['value_text'] as string | null) ?? null
    const valueNum = (valueArgs?.['value_num'] as number | null) ?? null
    const valueDate = (valueArgs?.['value_date'] as string | null) ?? null
    const valueRef = (valueArgs?.['value_ref'] as string | null) ?? null
    const valueBool = (valueArgs?.['value_bool'] as boolean | null) ?? null
    // #2656 — mirror the real backend's op-log value validation so contract
    // drift fails e2e/unit instead of storing an invalid value silently.
    assertValidSetPropertyValue(key, valueText)
    // #3079 — reserved column-backed keys (todo_state/priority/due_date/
    // scheduled_date) are the single source of truth on the block ROW, not
    // block_properties. Route them to the same-named block column and DO NOT
    // add a block_properties row (see `setReservedColumnProperty`). Leaving
    // them in the properties map (the old behaviour) double-counted them: once
    // on the column, once as a spurious row the backend never writes.
    const reservedChannel = RESERVED_PROPERTY_COLUMN[key]
    if (reservedChannel !== undefined) {
      // #3091 — reserved-value validation runs inside setReservedColumnProperty.
      return setReservedColumnProperty(blockId, key, reservedChannel, valueText, valueDate)
    }
    // Capture the prior typed value (if any) so revert can restore it.
    // `from_value: null` signals "property did not exist" — revert removes it.
    const priorRow = properties.get(blockId)?.get(key)
    const fromValue = priorRow
      ? {
          value_text: (priorRow['value_text'] as string | null) ?? null,
          value_num: (priorRow['value_num'] as number | null) ?? null,
          value_date: (priorRow['value_date'] as string | null) ?? null,
          value_ref: (priorRow['value_ref'] as string | null) ?? null,
          value_bool: (priorRow['value_bool'] as number | null) ?? null,
        }
      : null
    if (!properties.has(blockId)) {
      properties.set(blockId, new Map())
    }
    properties.get(blockId)?.set(key, {
      key,
      value_text: valueText,
      value_num: valueNum,
      value_date: valueDate,
      value_ref: valueRef,
      value_bool: valueBool === null ? null : valueBool ? 1 : 0,
    })
    // #533/#3081 — `space` is column-backed: the backend projects a
    // `SetProperty(space)` op to the denormalized `blocks.space_id` column (it
    // writes NO `block_properties` row). Mirror that here so the mock's
    // `list_all_tags_in_space` / space-scoped queries (which read `space_id`)
    // stay consistent with the backend for any path that still sets space via
    // a property write.
    if (key === 'space') {
      const target = blocks.get(blockId)
      if (target) target['space_id'] = valueRef
    }
    const op = pushOp('set_property', { block_id: blockId, key, from_value: fromValue })
    const b = blocks.get(blockId)
    // #2468 — `WithOps<BlockRow>`.
    return b ? { ...b, op_refs: [{ device_id: op.device_id, seq: op.seq }] } : null
  },

  delete_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    // #3079 — reserved column-backed keys clear the block COLUMN (backend
    // routes the delete through `reserved_key_blocks_column` → clears
    // `blocks.<col>`), NOT a block_properties row (which never holds a
    // reserved key). The old handler only touched the properties map, so a
    // reserved-key delete was a silent no-op that left the column set.
    if (RESERVED_PROPERTY_COLUMN[key] !== undefined) {
      const b = blocks.get(blockId)
      if (b) b[key] = null
      const op = pushOp('delete_property', { block_id: blockId, key, from_value: null })
      return {
        block_id: blockId,
        key,
        op_refs: [{ device_id: op.device_id, seq: op.seq }],
      }
    }
    // Capture the prior typed value so revert can re-add it.
    const priorRow = properties.get(blockId)?.get(key)
    const fromValue = priorRow
      ? {
          value_text: (priorRow['value_text'] as string | null) ?? null,
          value_num: (priorRow['value_num'] as number | null) ?? null,
          value_date: (priorRow['value_date'] as string | null) ?? null,
          value_ref: (priorRow['value_ref'] as string | null) ?? null,
          value_bool: (priorRow['value_bool'] as number | null) ?? null,
        }
      : null
    const blockProps = properties.get(blockId)
    if (blockProps) blockProps.delete(key)
    const op = pushOp('delete_property', {
      block_id: blockId,
      key,
      from_value: fromValue,
    })
    // #2468 — previously returned `null`; now echoes `(block_id, key)` plus
    // `op_refs` (`WithOps<DeletePropertyResponse>`). Backend parity: the real
    // `delete_property_core` ALWAYS appends the op — even when the property
    // does not exist — so the ref is always surfaced. Undoing a no-prior
    // delete then fails (`resolveUndoTarget` mirrors the backend's "no prior
    // set_property" NotFound from `build_reverse_delete_property`).
    return {
      block_id: blockId,
      key,
      op_refs: [{ device_id: op.device_id, seq: op.seq }],
    }
  },

  get_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const blockProps = properties.get(blockId)
    if (!blockProps) return []
    return [...blockProps.values()]
  },

  // Single-key PK lookup. Returns the row or null.
  get_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    const propMap = properties.get(blockId)
    return propMap?.get(key) ?? null
  },

  get_batch_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = a['blockIds'] as string[]
    const result: Record<string, Record<string, unknown>[]> = {}
    for (const id of blockIds) {
      const blockProps = properties.get(id)
      result[id] = blockProps ? [...blockProps.values()] : []
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  list_property_keys: () => {
    // Collect all distinct property keys from mock data
    const keys = new Set<string>()
    for (const blockProps of properties.values()) {
      for (const key of blockProps.keys()) {
        keys.add(key)
      }
    }
    // Always include common keys
    keys.add('todo')
    keys.add('priority')
    return [...keys].toSorted()
  },

  // #1425 — distinct text values for a key, usage-ranked (most-used
  // first), `value ASC` tiebreaker. Mirrors the backend
  // `list_property_values`, surfacing only the `value_text` channel.
  list_property_values: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const counts = new Map<string, number>()
    for (const blockProps of properties.values()) {
      const prop = blockProps.get(key)
      const value = prop?.['value_text']
      if (typeof value !== 'string') continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts.entries()]
      .toSorted((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([value]) => value)
  },

  // ---------------------------------------------------------------------------
  // Sync / Peer-ref commands
  // ---------------------------------------------------------------------------

  set_todo_state: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw notFoundRejection(`block '${a['blockId'] as string}' not found`)
    const fromState = (b['todo_state'] as string | null) ?? null
    b['todo_state'] = (a['state'] as string | null) ?? null
    pushOp('set_todo_state', {
      block_id: a['blockId'],
      state: b['todo_state'],
      from_state: fromState,
    })
    return { ...b }
  },

  // Batch set/clear todo state. Iterates the
  // input list, sets `b.todo_state` on each live block, and emits a
  // single `set_property` op per affected block (mirrors the
  // backend's per-block op_log entry under one tx). Missing /
  // soft-deleted ids are silently skipped (lenient batch semantic).
  set_todo_state_batch: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    if (inputIds.length === 0) {
      throw validationRejection('block_ids list cannot be empty')
    }
    const newState = (a['state'] as string | null) ?? null
    let updated = 0
    for (const id of inputIds) {
      const b = blocks.get(id)
      if (!b || b['deleted_at']) continue
      b['todo_state'] = newState
      pushOp('set_property', {
        block_id: id,
        key: 'todo_state',
        value_text: newState,
      })
      updated++
    }
    return updated
  },

  // Batch set/clear an ALLOWLISTED reserved property across N blocks in one
  // tx (mirror of the backend `set_property_batch`). Only
  // `todo_state`/`priority`/`due_date`/`scheduled_date` are accepted — any
  // other key is rejected (the backend allowlist). The op payload's typed
  // value column is routed by key: `todo_state`/`priority` → `value_text`,
  // `due_date`/`scheduled_date` → `value_date`. A `null` value clears the
  // property, emitted as an op with no `value_*` field (matching the
  // single-row clear). Missing / soft-deleted ids are silently skipped
  // (lenient batch semantic); an empty id list is a hard error.
  set_property_batch: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    if (inputIds.length === 0) {
      throw validationRejection('block_ids list cannot be empty')
    }
    const key = a['key'] as string
    const value = (a['value'] as string | null) ?? null
    // Allowlist + value-column routing (mirror the backend's reserved keys).
    const valueColumn: Record<string, 'value_text' | 'value_date'> = {
      todo_state: 'value_text',
      priority: 'value_text',
      due_date: 'value_date',
      scheduled_date: 'value_date',
    }
    const column = valueColumn[key]
    if (!column) {
      throw validationRejection(`property key '${key}' is not settable in batch`)
    }
    // #3091 — same reserved-value validation the single `set_property` applies
    // (backend validates once for the whole batch: todo_state/priority
    // membership, non-empty dates). A `null` value is a clear and passes.
    assertValidReservedPropertyValue(key, column, value)
    let updated = 0
    for (const id of inputIds) {
      const b = blocks.get(id)
      if (!b || b['deleted_at']) continue
      // Keep the mock block row in sync so downstream reads observe the set,
      // mirroring the per-key single handlers (todo_state/priority/…).
      b[key] = value
      const op: Record<string, unknown> = { block_id: id, key }
      // `null` → clear: emit no `value_*` field (single-row clear parity).
      if (value !== null) op[column] = value
      pushOp('set_property', op)
      updated++
    }
    return updated
  },

  set_priority: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw notFoundRejection(`block '${a['blockId'] as string}' not found`)
    const fromLevel = (b['priority'] as string | null) ?? null
    b['priority'] = (a['level'] as string | null) ?? null
    pushOp('set_priority', {
      block_id: a['blockId'],
      level: b['priority'],
      from_level: fromLevel,
    })
    return { ...b }
  },

  set_due_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw notFoundRejection(`block '${a['blockId'] as string}' not found`)
    const fromDate = (b['due_date'] as string | null) ?? null
    b['due_date'] = (a['date'] as string | null) ?? null
    pushOp('set_due_date', {
      block_id: a['blockId'],
      date: b['due_date'],
      from_date: fromDate,
    })
    return { ...b }
  },

  set_scheduled_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw notFoundRejection(`block '${a['blockId'] as string}' not found`)
    const fromDate = (b['scheduled_date'] as string | null) ?? null
    b['scheduled_date'] = (a['date'] as string | null) ?? null
    pushOp('set_scheduled_date', {
      block_id: a['blockId'],
      date: b['scheduled_date'],
      from_date: fromDate,
    })
    return { ...b }
  },

  // ---------------------------------------------------------------------------
  // Batch count commands
  // ---------------------------------------------------------------------------

  count_agenda_batch: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    // Honour `scope: SpaceScope` (mirrors
    // `count_agenda_batch_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const result: Record<string, number> = {}
    for (const dateStr of dates) {
      const count = [...blocks.values()].filter((b) => {
        if (b['deleted_at'] as string | null) return false
        if (b['due_date'] !== dateStr && b['scheduled_date'] !== dateStr) return false
        if (spaceId !== null) {
          const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
          const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
          if (ownerSpace !== spaceId) return false
        }
        return true
      }).length
      result[dateStr] = count
    }
    return result
  },

  count_agenda_batch_by_source: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    // Honour `scope: SpaceScope` (mirrors
    // `count_agenda_batch_by_source_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const result: Record<string, Record<string, number>> = {}
    for (const dateStr of dates) {
      const sources: Record<string, number> = {}
      for (const b of blocks.values()) {
        if (b['deleted_at'] as string | null) continue
        if (spaceId !== null) {
          const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
          const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
          if (ownerSpace !== spaceId) continue
        }
        if (b['due_date'] === dateStr) {
          sources['column:due_date'] = (sources['column:due_date'] ?? 0) + 1
        }
        if (b['scheduled_date'] === dateStr) {
          sources['column:scheduled_date'] = (sources['column:scheduled_date'] ?? 0) + 1
        }
      }
      if (Object.keys(sources).length > 0) {
        result[dateStr] = sources
      }
    }
    return result
  },

  create_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const def = {
      key,
      value_type: a['valueType'] as string,
      options: (a['options'] as string | null) ?? null,
      created_at: new Date().toISOString(),
    }
    propertyDefs.set(key, def)
    return def
  },

  list_property_defs: () => ({
    // Paginated; the mock returns every def in one page (the
    // mock fixtures stay small enough that pagination is irrelevant).
    items: [...propertyDefs.values()],
    next_cursor: null,
    has_more: false,
    total_count: null,
  }),

  // Single-key PK lookup. Returns the entry or null.
  get_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    return propertyDefs.get(key) ?? null
  },

  update_property_def_options: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const def = propertyDefs.get(key)
    if (!def) throw notFoundRejection(`property definition '${key}'`)
    def['options'] = a['options'] as string
    return { ...def }
  },

  delete_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    propertyDefs.delete(key)
    return undefined
  },

  // ---------------------------------------------------------------------------
  // Peer name update
  // ---------------------------------------------------------------------------

  // Stub returns empty so scope is a no-op today. If this
  // becomes a real handler, mirror `list_projected_agenda_inner`'s
  // `SpaceScope` filter (see `src-tauri/src/commands/agenda.rs` ~L175).
  list_projected_agenda: returnEmptyPage,

  // ---------------------------------------------------------------------------
  // OS notifications
  // ---------------------------------------------------------------------------

  // Mirrors `commands::notifier::notify_task` — rejects a blank title with a
  // validation error, otherwise resolves void (the mock has no OS to dispatch
  // to). See `src-tauri/src/commands/notifier.rs::prepare_notification`.
  notify_task: (args) => {
    const a = args as { notification?: { title?: unknown } }
    const title = typeof a.notification?.title === 'string' ? a.notification.title : ''
    if (title.trim() === '') {
      throw appErrorRejection({
        kind: 'validation',
        message: 'notification title must not be empty',
      })
    }
    return undefined
  },

  // ---------------------------------------------------------------------------
  // Draft autosave (F-17)
  // ---------------------------------------------------------------------------
} satisfies Pick<
  TypedHandlers,
  | 'query_by_property'
  | 'set_property'
  | 'delete_property'
  | 'get_properties'
  | 'get_property'
  | 'get_batch_properties'
  | 'list_property_keys'
  | 'list_property_values'
  | 'set_todo_state'
  | 'set_todo_state_batch'
  | 'set_property_batch'
  | 'set_priority'
  | 'set_due_date'
  | 'set_scheduled_date'
  | 'count_agenda_batch'
  | 'count_agenda_batch_by_source'
  | 'create_property_def'
  | 'list_property_defs'
  | 'get_property_def'
  | 'update_property_def_options'
  | 'delete_property_def'
  | 'list_projected_agenda'
  | 'notify_task'
>
