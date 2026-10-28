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
  BUILTIN_PROPERTY_DEFS,
  NON_DELETABLE_PROPERTIES,
  REPEAT_RULE_BOUNDS,
  SYSTEM_MANAGED_PROPERTY_KEYS,
} from '@/lib/property-save-utils'
import { isIsoDate } from '@/lib/search-query/is-iso-date'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { blocksHandlers } from '@/lib/tauri-mock/handlers/blocks'
import {
  type TypedHandlers,
  appErrorRejection,
  assertValidDateFormat,
  assertValidReservedPropertyValue,
  assertValidSetPropertyValue,
  definitionSpaceOf,
  isLiveSpace,
  notFoundRejection,
  ownerSpaceOf,
  propertyDefinition,
  returnEmptyPage,
  validationRejection,
  readActiveSpaceScope,
} from '@/lib/tauri-mock/handlers/shared'
import { resolveRefValue } from '@/lib/tauri-mock/names'
import { shiftDate } from '@/lib/tauri-mock/recurrence'
import { setPageGroupSpace, valueFieldsOf } from '@/lib/tauri-mock/revert'
import {
  appSettings,
  blocks,
  type MockOpLogEntry,
  properties,
  propertyDefs,
  pushOp,
  spacePropertyDefs,
  todayDate,
} from '@/lib/tauri-mock/seed'

/** #4554 — the two `app_settings` keys `reminders::get_settings` reads; `'1'` = enabled. */
const REMINDERS_ENABLED_KEY = 'reminders.enabled'
const REMINDERS_TIME_KEY = 'reminders.time'

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

/** A `block_properties` row's typed value columns: the `from_value` its undo restores. */
function typedValueOf(row: Record<string, unknown>): Record<string, unknown> {
  return {
    value_text: (row['value_text'] as string | null) ?? null,
    value_num: (row['value_num'] as number | null) ?? null,
    value_date: (row['value_date'] as string | null) ?? null,
    value_ref: (row['value_ref'] as string | null) ?? null,
    value_bool: (row['value_bool'] as number | null) ?? null,
  }
}

/**
 * Delete `key`'s `block_properties` row, appending the op with the prior value
 * its undo re-adds.
 */
function deletePropertyRow(blockId: string, key: string): { device_id: string; seq: number } {
  const priorRow = properties.get(blockId)?.get(key)
  const fromValue = priorRow ? typedValueOf(priorRow) : null
  properties.get(blockId)?.delete(key)
  const op = pushOp('delete_property', { block_id: blockId, key, from_value: fromValue })
  return { device_id: op.device_id, seq: op.seq }
}

/**
 * `set_property_in_tx` for a `block_properties` key: the row, and the op with
 * the value its undo restores (`from_value: null` when the block held none).
 */
function writePropertyRow(
  blockId: string,
  key: string,
  value: Record<string, unknown>,
): MockOpLogEntry {
  const prior = properties.get(blockId)?.get(key)
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set(key, {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...value,
  })
  return pushOp('set_property', {
    block_id: blockId,
    key,
    from_value: prior ? typedValueOf(prior) : null,
  })
}

/** Stamp `key` with today's date. */
function stampToday(blockId: string, key: string): void {
  writePropertyRow(blockId, key, { value_date: todayDate() })
}

/**
 * `write_todo_timestamp_transitions_in_tx` (`commands/properties.rs`), which
 * every `todo_state` writer runs: `created_at` first, then `completed_at`.
 */
function writeTaskStampTransitions(
  blockId: string,
  fromState: string | null,
  toState: string | null,
): void {
  writeCreatedAtTransition(blockId, fromState, toState)
  writeCompletedAtTransition(blockId, fromState, toState)
}

/**
 * The `created_at` half: stamped today when a block becomes an open task (from
 * no state or DONE), cleared when it stops being a task, and only when the
 * block holds one.
 */
function writeCreatedAtTransition(
  blockId: string,
  fromState: string | null,
  toState: string | null,
): void {
  if ((fromState === null || fromState === 'DONE') && (toState === 'TODO' || toState === 'DOING')) {
    stampToday(blockId, 'created_at')
  } else if (fromState !== null && toState === null && properties.get(blockId)?.has('created_at')) {
    deletePropertyRow(blockId, 'created_at')
  }
}

/**
 * The `completed_at` half: present iff `todo_state = 'DONE'` (#5074). Stamped
 * today on an edge into DONE; cleared on an edge out of it, or when a block
 * stops being a task, and only when the block holds one.
 */
function writeCompletedAtTransition(
  blockId: string,
  fromState: string | null,
  toState: string | null,
): void {
  const wasDone = fromState === 'DONE'
  const isDone = toState === 'DONE'
  const prior = properties.get(blockId)?.get('completed_at')
  if (isDone && !wasDone) {
    stampToday(blockId, 'completed_at')
  } else if (!isDone && prior && (wasDone || (fromState !== null && toState === null))) {
    deletePropertyRow(blockId, 'completed_at')
  }
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

/**
 * #533 — `space` is the `blocks.space_id` column, never a `block_properties`
 * row (migration 0088). `validate_space_target_in_tx`: only a page or a
 * top-level tag holds it, and it names a live space. Returns the
 * `WithOps<BlockRow>` response.
 */
function setSpaceProperty(
  target: Record<string, unknown>,
  valueRef: string | null,
): Record<string, unknown> {
  const blockId = target['id'] as string
  if (
    target['block_type'] !== 'page' &&
    !(target['block_type'] === 'tag' && target['parent_id'] == null)
  ) {
    throw validationRejection(
      `property 'space' can only be set on a page or top-level tag block; block '${blockId}' is a '${target['block_type'] as string}' block`,
    )
  }
  if (valueRef === null || !isLiveSpace(valueRef)) {
    throw validationRejection(
      `space_id '${valueRef}' does not refer to a live, registered space block`,
    )
  }
  const fromSpace = (target['space_id'] as string | null | undefined) ?? null
  setPageGroupSpace(blocks, blockId, valueRef)
  const op = pushOp('set_property', {
    block_id: blockId,
    key: 'space',
    from_value: fromSpace === null ? null : typedValueOf({ value_ref: fromSpace }),
  })
  return { ...target, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
}

/**
 * `set_todo_state_in_tx` (`commands/properties.rs`), which every single-block
 * `todo_state` writer runs: `write` sets the state and appends its op, the
 * #5074 stamps follow, and the edge into DONE makes the task's next occurrence
 * (`handle_recurrence_in_tx`). The backend writes it all in one transaction,
 * so the occurrence is read before the first write: a rule that cannot advance
 * refuses the whole write. The batch writers skip the occurrence, as the
 * backend's do.
 */
function writeTodoState<R>(
  blockId: string,
  toState: string | null,
  write: (fromState: string | null) => R,
): R {
  const fromState = (blocks.get(blockId)?.['todo_state'] as string | null | undefined) ?? null
  const next = toState === 'DONE' && fromState !== 'DONE' ? nextOccurrence(blockId) : null
  const result = write(fromState)
  writeTaskStampTransitions(blockId, fromState, toState)
  if (next !== null) createOccurrence(next)
  return result
}

/** What `build_recurrence_sibling_in_tx` reads before it writes the next occurrence. */
interface Occurrence {
  original: Record<string, unknown>
  rule: string
  due: string | null
  scheduled: string | null
  until: string | null
  count: number | null
  seq: number | null
  originId: string
}

/** A date column shifted by `rule`, refused as `shift_date`'s `Err` refuses. */
function shiftedColumn(date: unknown, rule: string): string | null {
  if (typeof date !== 'string') return null
  const shifted = shiftDate(date, rule, new Date())
  if ('err' in shifted) throw validationRejection(shifted.err)
  return shifted.ok
}

/**
 * The reads of `build_recurrence_sibling_in_tx` (`agaric-engine/src/recurrence/compute.rs`)
 * and `remaining_repeat_bounds`: null when the block has no `repeat` rule or
 * an end condition fires. `repeat-until` is checked against the shifted due
 * date, else the scheduled one, and only when there is one; one that is not a
 * `YYYY-MM-DD` date ends the chain.
 */
function nextOccurrence(blockId: string): Occurrence | null {
  const props = properties.get(blockId)
  const read = (key: string, column: string): unknown => props?.get(key)?.[column] ?? null
  const rule = read('repeat', 'value_text') as string | null
  const original = blocks.get(blockId)
  if (rule === null || !original) return null
  const due = shiftedColumn(original['due_date'], rule)
  const scheduled = shiftedColumn(original['scheduled_date'], rule)
  const reference = due ?? scheduled
  const until = read('repeat-until', 'value_date') as string | null
  if (until !== null && reference !== null && (!isIsoDate(until) || reference > until)) return null
  // `as i64` truncates the counter's `f64`.
  const count = read('repeat-count', 'value_num') as number | null
  const seq = read('repeat-seq', 'value_num') as number | null
  if (count !== null && Math.trunc(seq ?? 0) >= Math.trunc(count)) return null
  const originId = (read('repeat-origin', 'value_ref') as string | null) ?? blockId
  return { original, rule, due, scheduled, until, count, seq, originId }
}

/**
 * `create_recurrence_sibling`: the next occurrence appended under the
 * original's parent, then its properties in the backend's order
 * (`seed_sibling_todo_and_repeat`, `copy_shifted_dates`, `copy_repeat_bounds`).
 * The state is the column alone: a `set_property_in_tx` write stamps nothing.
 * `repeat-seq` advances only beside a `repeat-count` (`copy_repeat_counter`).
 */
function createOccurrence(next: Occurrence): void {
  const { original } = next
  const { id } = blocksHandlers.create_block({
    blockType: original['block_type'],
    content: original['content'] ?? '',
    parentId: original['parent_id'] ?? null,
    index: null,
    scope: {
      kind: 'active',
      space_id: (original['space_id'] as string | null) ?? ownerSpaceOf(original),
    },
  })
  setReservedColumnProperty(id, 'todo_state', 'value_text', 'TODO', null)
  writePropertyRow(id, 'repeat', { value_text: next.rule })
  if (next.due !== null) setReservedColumnProperty(id, 'due_date', 'value_date', null, next.due)
  if (next.scheduled !== null) {
    setReservedColumnProperty(id, 'scheduled_date', 'value_date', null, next.scheduled)
  }
  if (next.until !== null) writePropertyRow(id, 'repeat-until', { value_date: next.until })
  if (next.count !== null) {
    writePropertyRow(id, 'repeat-count', { value_num: next.count })
    writePropertyRow(id, 'repeat-seq', { value_num: Math.trunc(next.seq ?? 0) + 1 })
  }
  writePropertyRow(id, 'repeat-origin', { value_ref: next.originId })
}

/** The `value_type` vocabulary `validate_property_def_shape` matches on. */
const PROPERTY_DEF_VALUE_TYPES = new Set([
  'text',
  'number',
  'date',
  'select',
  'ref',
  'boolean',
  'url',
])

/** `serde_json::from_str::<Vec<String>>`: anything but an array of strings is refused. */
function parsePropertyDefOptions(options: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(options)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed) || parsed.some((o) => typeof o !== 'string')) {
    throw validationRejection('options must be a JSON array of strings')
  }
  return parsed as string[]
}

/** Mock twin of `refuse_builtin_definition_write` (`commands/properties.rs`, #5841). */
function refuseBuiltinDefinitionWrite(key: string): void {
  if (NON_DELETABLE_PROPERTIES.has(key)) {
    throw appErrorRejection({
      kind: 'validation',
      code: 'BuiltinPropertyLocked',
      message: `property '${key}' is built in and cannot be changed`,
    })
  }
}

/**
 * Mock twin of `validate_property_def_shape` (`commands/properties.rs`). The
 * mock used to accept every key, every value_type and every options blob, so a
 * conformance op could not tell a refusal from a write (#3830).
 */
function validatePropertyDefShape(key: string, valueType: string, options: string | null): void {
  refuseBuiltinDefinitionWrite(key)
  if (key.length === 0 || key.length > 64) {
    throw validationRejection('property definition key must be 1-64 characters')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw validationRejection(
      'property definition key must contain only alphanumeric, underscore, or hyphen characters',
    )
  }
  if (!PROPERTY_DEF_VALUE_TYPES.has(valueType)) {
    throw validationRejection(
      `invalid value_type '${valueType}': must be text, number, date, select, ref, boolean, or url`,
    )
  }
  if (valueType === 'select') {
    if (options === null) {
      throw validationRejection('select-type definitions require an options array')
    }
    if (parsePropertyDefOptions(options).length === 0) {
      throw validationRejection('select-type options must not be empty')
    }
  } else if (options !== null) {
    throw validationRejection(
      `options are only allowed for select-type definitions, not '${valueType}'`,
    )
  }
}

export const propertiesHandlers = {
  // Mirrors `pagination::query_by_property` (#3827). One `block_properties`
  // (or native-column) row per block; the comparison operator applies to
  // whichever of `valueText` / `valueDate` is given, `neq` also matches a
  // NULL value, `valueDateRange` is `>= from AND < to`, `valueTextIn` is set
  // membership, and the push-downs read the BLOCK: `parent_id IS NOT
  // excludeParentId` (a NULL parent passes), `TRIM(content, space/tab/LF/CR)
  // != ''`, `todo_state IS NULL OR todo_state NOT IN (excludeTodoStates)`.
  // Ordered `b.id ASC`.
  query_by_property: (args) => {
    const a = args as Record<string, unknown>
    // Accept either the `{ request, scope }` wire shape or a flat arg bag.
    const req = (a['request'] as Record<string, unknown>) ?? a
    const key = req['key'] as string
    if (typeof key !== 'string' || key.trim() === '') {
      throw validationRejection('property key must not be empty')
    }
    const valueText = (req['valueText'] as string | null) ?? null
    const valueDate = (req['valueDate'] as string | null) ?? null
    const operator = (req['operator'] as string | null) ?? 'eq'
    const spaceId = readActiveSpaceScope('query_by_property', a)
    const excludeParentId = (req['excludeParentId'] as string | null) ?? null
    const contentNonEmpty = Boolean(req['contentNonEmpty'])
    const blockType = (req['blockType'] as string | null) ?? null
    const valueTextIn = (req['valueTextIn'] as string[] | null) ?? []
    const valueDateRange = (req['valueDateRange'] as [string, string] | null) ?? null
    const excludeTodoStates = (req['excludeTodoStates'] as string[] | null) ?? []
    if (valueText !== null && valueDate !== null) {
      throw validationRejection(
        'query_by_property: at most one of value_text / value_date may be supplied',
      )
    }
    if (valueTextIn.length > 0 && valueText !== null) {
      throw validationRejection(
        'query_by_property: value_text_in and value_text are mutually exclusive',
      )
    }
    const ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
      todo_state: 'text',
      priority: 'text',
      due_date: 'date',
      scheduled_date: 'date',
    }
    const rowKind = ROW_FIELD_KEYS[key]
    // SQL `a <op> b` on TEXT: NULL never compares true, except that the
    // non-reserved `neq` predicate is written `IS NULL OR !=` (#384). Only
    // the non-reserved path reaches this with a NULL: the reserved one
    // returns on a NULL column first.
    const compare = (actual: string | null, wanted: string | null): boolean => {
      if (wanted === null) return true
      if (actual === null) return operator === 'neq'
      switch (operator) {
        case 'neq': {
          return actual !== wanted
        }
        case 'lt': {
          return actual < wanted
        }
        case 'gt': {
          return actual > wanted
        }
        case 'lte': {
          return actual <= wanted
        }
        case 'gte': {
          return actual >= wanted
        }
        default: {
          return actual === wanted
        }
      }
    }
    const blockPredicates = (b: Record<string, unknown>): boolean => {
      if (b['deleted_at']) return false
      if (ownerSpaceOf(b) !== spaceId) return false
      if (excludeParentId !== null && b['parent_id'] === excludeParentId) return false
      if (contentNonEmpty) {
        const content = b['content'] as string | null | undefined
        if (content == null || content.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '') === '') return false
      }
      if (blockType !== null && b['block_type'] !== blockType) return false
      if (excludeTodoStates.length > 0) {
        const todo = (b['todo_state'] as string | null) ?? null
        if (todo !== null && excludeTodoStates.includes(todo)) return false
      }
      return true
    }
    const inSet = (v: string | null): boolean =>
      valueTextIn.length === 0 || (v !== null && valueTextIn.includes(v))
    const inRange = (v: string | null): boolean => {
      if (valueDateRange === null) return true
      if (v === null) return false
      const [from, to] = valueDateRange
      return v >= from && v < to
    }
    const items = [...blocks.values()].filter((b) => {
      if (!blockPredicates(b)) return false
      if (rowKind !== undefined) {
        // Reserved key: the native column, `WHERE b.<col> IS NOT NULL`.
        const rowValue = (b[key] as string | null | undefined) ?? null
        if (rowValue === null) return false
        const wanted = rowKind === 'date' ? (valueDate ?? valueText) : (valueText ?? valueDate)
        return compare(rowValue, wanted) && inSet(rowValue) && inRange(rowValue)
      }
      const prop = properties.get(b['id'] as string)?.get(key)
      if (!prop) return false
      const text = (prop['value_text'] as string | null | undefined) ?? null
      const date = (prop['value_date'] as string | null | undefined) ?? null
      return compare(text, valueText) && compare(date, valueDate) && inSet(text) && inRange(date)
    })
    items.sort((x, y) => String(x['id']).localeCompare(String(y['id'])))
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  set_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    // Typed values are bundled under `value: SetPropertyArgs` (was 4 flat
    // args). Navigate the bundle to read each typed value column.
    const valueArgs = a['value'] as Record<string, unknown> | undefined
    let valueText = (valueArgs?.['value_text'] as string | null) ?? null
    const valueNum = (valueArgs?.['value_num'] as number | null) ?? null
    const valueDate = (valueArgs?.['value_date'] as string | null) ?? null
    let valueRef = (valueArgs?.['value_ref'] as string | null) ?? null
    const valueBool = (valueArgs?.['value_bool'] as boolean | null) ?? null
    // #2656 — mirror the real backend's op-log value validation so contract
    // drift fails e2e/unit instead of storing an invalid value silently. The
    // block's space's definitions apply (#5841).
    const defSpace = definitionSpaceOf(blockId)
    assertValidSetPropertyValue(defSpace, key, valueText)
    // `validate_set_property`: one value, or none to clear a reserved column.
    const valueCount = [valueText, valueNum, valueDate, valueRef, valueBool].filter(
      (v) => v !== null,
    ).length
    if (valueCount > 1 || (valueCount === 0 && RESERVED_PROPERTY_COLUMN[key] === undefined)) {
      throw validationRejection(
        `SetProperty must have exactly 1 non-null value field, found ${valueCount}`,
      )
    }
    // `validate_set_property`, then `validate_property_value`: every
    // `value_date` is a non-blank calendar day.
    if (valueDate !== null) {
      if (valueDate.trim() === '') throw validationRejection('set_property.value_date.empty')
      assertValidDateFormat(valueDate)
    }
    // `fetch_live_block_in_tx`.
    const target = blocks.get(blockId)
    if (!target) throw notFoundRejection(`block '${blockId}' does not exist`)
    if (target['deleted_at'] != null) {
      throw validationRejection(`block '${blockId}' has been soft-deleted`)
    }
    // #5160 D11 — `read_typed_ref`: text under a `ref` definition is the block
    // it names in the block's space.
    if (
      valueText !== null &&
      valueRef === null &&
      propertyDefinition(defSpace, key)?.['value_type'] === 'ref'
    ) {
      const block = blocks.get(blockId)
      const spaceId = block ? ((block['space_id'] as string | null) ?? ownerSpaceOf(block)) : null
      valueRef = resolveRefValue(valueText, spaceId)
      valueText = null
    }
    // #3079 — reserved column-backed keys (todo_state/priority/due_date/
    // scheduled_date) are the single source of truth on the block ROW, not
    // block_properties. Route them to the same-named block column and DO NOT
    // add a block_properties row (see `setReservedColumnProperty`). Leaving
    // them in the properties map (the old behaviour) double-counted them: once
    // on the column, once as a spurious row the backend never writes.
    const reservedChannel = RESERVED_PROPERTY_COLUMN[key]
    if (reservedChannel !== undefined) {
      // #3091 — reserved-value validation runs inside setReservedColumnProperty.
      const write = () =>
        setReservedColumnProperty(blockId, key, reservedChannel, valueText, valueDate)
      // #5394 — `set_property_inner` routes `todo_state` through `set_todo_state_in_tx`.
      return key === 'todo_state' ? writeTodoState(blockId, valueText, write) : write()
    }
    if (key === 'space') return setSpaceProperty(target, valueRef)
    const op = writePropertyRow(blockId, key, {
      value_text: valueText,
      value_num: valueNum,
      value_date: valueDate,
      value_ref: valueRef,
      value_bool: valueBool === null ? null : valueBool ? 1 : 0,
    })
    const b = blocks.get(blockId)
    // #2468 — `WithOps<BlockRow>`.
    return b ? { ...b, op_refs: [{ device_id: op.device_id, seq: op.seq }] } : null
  },

  delete_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    if (SYSTEM_MANAGED_PROPERTY_KEYS.has(key)) {
      throw validationRejection(`cannot delete system-managed property '${key}'`)
    }
    // `delete_property_core`'s activeness gate, after the key check as there.
    const b = blocks.get(blockId)
    if (!b) throw notFoundRejection(`block '${blockId}' does not exist`)
    if (b['deleted_at'] != null) {
      throw validationRejection(`block '${blockId}' has been soft-deleted`)
    }
    // #3079 — reserved column-backed keys clear the block COLUMN (backend
    // routes the delete through `reserved_key_blocks_column` → clears
    // `blocks.<col>`), NOT a block_properties row (which never holds a
    // reserved key). The old handler only touched the properties map, so a
    // reserved-key delete was a silent no-op that left the column set.
    if (RESERVED_PROPERTY_COLUMN[key] !== undefined) {
      const fromValue = (b[key] as string | null | undefined) ?? null
      // #5898 — a key the block does not hold appends nothing.
      if (fromValue === null) return { block_id: blockId, key, op_refs: [] }
      b[key] = null
      const op = pushOp('delete_property', { block_id: blockId, key, from_value: null })
      // #5378 — `delete_property_core` clears the task stamps with the state.
      if (key === 'todo_state') writeTaskStampTransitions(blockId, fromValue, null)
      return {
        block_id: blockId,
        key,
        op_refs: [{ device_id: op.device_id, seq: op.seq }],
      }
    }
    // `space` clears the `blocks.space_id` column; its undo restores the space.
    if (key === 'space') {
      const fromSpace = (b['space_id'] as string | null | undefined) ?? null
      if (fromSpace === null) return { block_id: blockId, key, op_refs: [] }
      setPageGroupSpace(blocks, blockId, null)
      const op = pushOp('delete_property', {
        block_id: blockId,
        key,
        from_value: typedValueOf({ value_ref: fromSpace }),
      })
      return { block_id: blockId, key, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
    }
    // #2468 — echoes `(block_id, key)` plus `op_refs`
    // (`WithOps<DeletePropertyResponse>`). #5898 — like `delete_property_core`,
    // a key the block does not hold appends nothing.
    const opRefs = properties.get(blockId)?.has(key) ? [deletePropertyRow(blockId, key)] : []
    if (key === 'repeat') {
      for (const bound of REPEAT_RULE_BOUNDS) {
        if (properties.get(blockId)?.has(bound)) opRefs.push(deletePropertyRow(blockId, bound))
      }
    }
    return { block_id: blockId, key, op_refs: opRefs }
  },

  get_properties: (args) => {
    const a = args as Record<string, unknown>
    return [...(properties.get(a['blockId'] as string)?.values() ?? [])]
  },

  // Single-key PK lookup. Returns the row or null.
  get_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    return properties.get(blockId)?.get(key) ?? null
  },

  // #3872 — the map is keyed off the ROWS READ, not off the REQUEST:
  // `get_batch_properties_inner` builds it with `map.entry(row.block_id)`, so a
  // requested block that owns no properties is ABSENT from the response rather
  // than present bound to `[]`. Callers that treat a missing key as "unknown,
  // re-fetch" (as opposed to "known to have none") see the two cases
  // differently, so the mock must not manufacture the empty entry.
  get_batch_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = a['blockIds'] as string[]
    const result: Record<string, Record<string, unknown>[]> = {}
    for (const id of blockIds) {
      const rows = [...(properties.get(id)?.values() ?? [])]
      if (rows.length === 0) continue
      result[id] = rows
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  // #1424 — `GROUP BY key ORDER BY COUNT(*) DESC, key ASC` over every
  // `block_properties` row, deleted holders included (the backend does not
  // join `blocks`).
  list_property_keys: () => {
    const counts = new Map<string, number>()
    for (const blockProps of properties.values()) {
      for (const key of blockProps.keys()) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .toSorted((x, y) => y[1] - x[1] || compareUtf8Bytes(x[0], y[0]))
      .map(([key]) => key)
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
      .toSorted((x, y) => y[1] - x[1] || compareUtf8Bytes(x[0], y[0]))
      .map(([value]) => value)
  },

  // ---------------------------------------------------------------------------
  // Sync / Peer-ref commands
  // ---------------------------------------------------------------------------

  set_todo_state: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const b = blocks.get(blockId)
    if (!b) throw notFoundRejection(`block '${blockId}' not found`)
    const state = (a['state'] as string | null) ?? null
    writeTodoState(blockId, state, (fromState) => {
      b['todo_state'] = state
      pushOp('set_todo_state', { block_id: blockId, state, from_state: fromState })
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
      const fromState = (b['todo_state'] as string | null) ?? null
      b['todo_state'] = newState
      // `prior` as `set_property_in_tx_with_declaration` records it, which the
      // undo restores: the value the set overwrote, every slot null for none.
      pushOp('set_property', {
        block_id: id,
        key: 'todo_state',
        value_text: newState,
        prior: valueFieldsOf({ value_text: fromState }),
      })
      writeTaskStampTransitions(id, fromState, newState)
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
      const prior = (b[key] as string | null) ?? null
      // Keep the mock block row in sync so downstream reads observe the set,
      // mirroring the per-key single handlers (todo_state/priority/…).
      b[key] = value
      const op: Record<string, unknown> = { block_id: id, key }
      // `null` → clear: emit no `value_*` field (single-row clear parity).
      if (value !== null) op[column] = value
      pushOp('set_property', op)
      if (key === 'todo_state') writeTaskStampTransitions(id, prior, value)
      updated++
    }
    return updated
  },

  set_priority: (args) => {
    const a = args as Record<string, unknown>
    assertValidReservedPropertyValue(
      'priority',
      'value_text',
      (a['level'] as string | null) ?? null,
    )
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

  count_agenda_batch_by_source: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    // #3830 — `count_agenda_batch_by_source_inner` runs `validate_date_format`
    // over every date before it queries, so a malformed date REFUSES rather
    // than answering an empty map. Only the SHAPE is mirrored here: the
    // backend then hands the string to chrono, which also rejects a
    // calendar-invalid date (2026-02-30) this regex accepts.
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        throw validationRejection(`expected YYYY-MM-DD format with calendar-valid date, got '${d}'`)
      }
    }
    // Honour `scope: SpaceScope` (mirrors
    // `count_agenda_batch_by_source_inner`).
    const spaceId = readActiveSpaceScope('count_agenda_batch_by_source', a)
    const result: Record<string, Record<string, number>> = {}
    for (const dateStr of dates) {
      const sources: Record<string, number> = {}
      for (const b of blocks.values()) {
        if (b['deleted_at'] as string | null) continue
        if (ownerSpaceOf(b) !== spaceId) continue
        // #3830 — ONE source per (date, block): `agenda_cache`'s PK is
        // `(date, block_id)` and `column:due_date` outranks `column:scheduled_date`
        // in `DESIRED_AGENDA_SQL`. Only those two column sources are modelled
        // here. `DESIRED_AGENDA_SQL` also derives `property:<key>` (from any
        // `block_properties.value_date`) and `tag:<tag_id>`, and both outrank the
        // columns — so a block carrying a custom date property on the same day
        // as its `due_date` is `property:<key>` on the backend and
        // `column:due_date` here.
        const source =
          b['due_date'] === dateStr
            ? 'column:due_date'
            : b['scheduled_date'] === dateStr
              ? 'column:scheduled_date'
              : null
        if (source !== null) sources[source] = (sources[source] ?? 0) + 1
      }
      if (Object.keys(sources).length > 0) {
        result[dateStr] = sources
      }
    }
    return result
  },

  create_property_def: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    const key = a['key'] as string
    const valueType = a['valueType'] as string
    const options = (a['options'] as string | null) ?? null
    validatePropertyDefShape(key, valueType, options)
    // INSERT OR IGNORE (`create_property_def_inner`): the space's existing
    // declaration wins untouched, so re-asserting a key under a different
    // value_type answers with the FIRST one rather than overwriting it.
    const existing = propertyDefinition(spaceId, key)
    if (existing) return existing
    const def = {
      key,
      value_type: valueType,
      options,
      created_at: new Date().toISOString(),
    }
    spacePropertyDefs(spaceId).set(key, def)
    return { ...def, builtin: false }
  },

  list_property_defs: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    return {
      // Paginated; the mock returns every def in one page (the
      // mock fixtures stay small enough that pagination is irrelevant).
      // `key ASC` is the backend's ORDER BY (#3830), over the built-ins
      // (#5841) and the space's rows together; insertion order was the mock's
      // own, and the two differ as soon as defs are declared out of
      // alphabetical order.
      items: [
        ...BUILTIN_PROPERTY_DEFS.map((def) => def.key),
        ...(propertyDefs.get(spaceId)?.keys() ?? []),
      ]
        .toSorted(compareUtf8Bytes)
        .map((key) => propertyDefinition(spaceId, key)),
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
  },

  // Single-key lookup: the built-in, else the space's row, else null.
  get_property_def: (args) => {
    const a = args as Record<string, unknown>
    return propertyDefinition(a['spaceId'] as string, a['key'] as string) ?? null
  },

  update_property_def_options: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    const key = a['key'] as string
    const options = a['options'] as string
    refuseBuiltinDefinitionWrite(key)
    // The backend parses the array BEFORE it looks the key up, so a malformed
    // or empty array on an unknown key is a validation refusal, not NotFound.
    if (parsePropertyDefOptions(options).length === 0) {
      throw validationRejection('options must not be empty')
    }
    const def = propertyDefs.get(spaceId)?.get(key)
    if (!def) throw notFoundRejection(`property definition '${key}'`)
    const valueType = def['value_type'] as string
    if (valueType !== 'select') {
      throw validationRejection(`cannot update options on '${valueType}'-type definition '${key}'`)
    }
    const updated = { ...def, options }
    spacePropertyDefs(spaceId).set(key, updated)
    return { ...updated, builtin: false }
  },

  delete_property_def: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    const key = a['key'] as string
    refuseBuiltinDefinitionWrite(key)
    // A definition a block of the space still holds a value under is refused
    // rather than orphaning the rows, in the backend's words: the Settings
    // screen shows them. Trashed blocks count, as `blocks.space_id` keeps
    // them in the space.
    const inUse = [...properties.entries()].filter(([blockId, perBlock]) => {
      const block = blocks.get(blockId)
      if (!perBlock.has(key) || !block) return false
      return ((block['space_id'] as string | null) ?? ownerSpaceOf(block)) === spaceId
    }).length
    if (inUse > 0) {
      throw validationRejection(
        `Can't delete '${key}': ${inUse} block(s) still use it. Remove the property from them first.`,
      )
    }
    const defs = propertyDefs.get(spaceId)
    if (!defs?.has(key)) throw notFoundRejection(`property definition '${key}'`)
    defs.delete(key)
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

  // Mirrors `reminders::get_settings` / `set_settings` (#4554): device-local
  // preferences in `app_settings`, defaults off / 09:00, `HH:MM` validated.
  // Read through the `appSettings` rows rather than a module-local struct so
  // a fixture's `seed.app_settings` section reaches it (#3830).
  get_reminder_settings: () => ({
    enabled: appSettings.get(REMINDERS_ENABLED_KEY) === '1',
    time: appSettings.get(REMINDERS_TIME_KEY) ?? '09:00',
  }),

  set_reminder_settings: (args) => {
    const a = args as { settings?: { enabled?: unknown; time?: unknown } }
    const enabled = a.settings?.enabled === true
    const time = typeof a.settings?.time === 'string' ? a.settings.time : ''
    // `NaiveTime::parse_from_str(_, "%H:%M")`, which takes ONE OR TWO digits
    // per field: the backend accepts `7:30` as readily as `07:30`, so a
    // zero-padded-only shape check would refuse input the backend stores.
    // `99:99` is still out — the fields are range-checked, not just counted.
    const hhmm = /^(\d{1,2}):(\d{1,2})$/.exec(time)
    const hour = hhmm ? Number(hhmm[1]) : Number.NaN
    const minute = hhmm ? Number(hhmm[2]) : Number.NaN
    if (!hhmm || hour > 23 || minute > 59) {
      throw appErrorRejection({
        kind: 'validation',
        message: `reminder time must be HH:MM, got ${JSON.stringify(time)}`,
      })
    }
    appSettings.set(REMINDERS_ENABLED_KEY, enabled ? '1' : '0')
    appSettings.set(REMINDERS_TIME_KEY, time)
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
  | 'count_agenda_batch_by_source'
  | 'create_property_def'
  | 'list_property_defs'
  | 'get_property_def'
  | 'update_property_def_options'
  | 'delete_property_def'
  | 'list_projected_agenda'
  | 'notify_task'
  | 'get_reminder_settings'
  | 'set_reminder_settings'
>
