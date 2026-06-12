/**
 * Tauri mock — per-op-type revert helper.
 *
 * Extracted from the `revert_ops` handler so the handler body stays flat and
 * stays under Biome's `noExcessiveCognitiveComplexity` threshold. The branching
 * over `op_type` lives here as a single switch statement that delegates to a
 * small per-case helper so the public function itself stays well under the
 * complexity budget.
 *
 * Keep behaviour identical to the real backend's reverse logic — this mock is
 * only used in browser/E2E preview, but tests rely on the produced side
 * effects matching what the real `revert_ops` command would produce.
 */

import type { MockOpLogEntry } from './seed'

type BlockRow = Record<string, unknown>
type Blocks = Map<string, BlockRow>
type Properties = Map<string, Map<string, Record<string, unknown>>>
type BlockTags = Map<string, Set<string>>

/**
 * #958 — assign dense 1-based `position` to every live child of `parentId`,
 * in `position ASC, id ASC` order. Mirrors `renumberSiblings` in
 * `handlers.ts`: reverting a move must collapse the moved block AND the
 * sibling group it rejoins back to dense ranks, otherwise the restored raw
 * `old_position` collides with the sibling now occupying that slot and the
 * `position ASC, id ASC` load ordering breaks (order/depth fails to revert
 * in place — #958).
 */
function renumberSiblingsIn(blocks: Blocks, parentId: string | null): void {
  const siblings = [...blocks.values()].filter(
    (b) => ((b['parent_id'] as string | null) ?? null) === parentId && !b['deleted_at'],
  )
  siblings.sort((x, y) => {
    const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    if (px !== py) return px - py
    return (x['id'] as string).localeCompare(y['id'] as string)
  })
  siblings.forEach((b, i) => {
    b['position'] = i + 1
  })
}

/**
 * #958 — place `blockId` at the 0-based `slot` among `parentId`'s OTHER live
 * children, then collapse the whole group to dense 1-based positions. Mirrors
 * `insertAtSlotAndRenumber` in `handlers.ts`. Restoring a move's raw
 * `old_position` directly collides with the sibling now in that slot; giving
 * the moved block a fractional key that sorts JUST before the slot's current
 * occupant, then renumbering, lands it back at the intended rank.
 */
function insertAtSlotIn(
  blocks: Blocks,
  parentId: string | null,
  blockId: string,
  slot: number,
): void {
  const moved = blocks.get(blockId)
  if (!moved) return
  const others = [...blocks.values()].filter(
    (b) =>
      ((b['parent_id'] as string | null) ?? null) === parentId &&
      !b['deleted_at'] &&
      b['id'] !== blockId,
  )
  others.sort((x, y) => {
    const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    if (px !== py) return px - py
    return (x['id'] as string).localeCompare(y['id'] as string)
  })
  const clamped = Math.max(0, Math.min(slot, others.length))
  others.forEach((b, i) => {
    b['position'] = i + 1
  })
  moved['position'] = clamped + 0.5
  renumberSiblingsIn(blocks, parentId)
}

/**
 * Optional auxiliary state for reverting op types that touch `properties` or
 * `block_tags` instead of fields on the block row itself. Callers without
 * access to these maps can omit the parameter; the corresponding op types
 * will silently no-op (which matches the documented "unknown op types are
 * silent no-ops" contract for any caller that doesn't wire the maps in).
 */
export interface RevertState {
  properties?: Properties
  blockTags?: BlockTags
}

// ---------------------------------------------------------------------------
// Block-row reverts (mutate fields on the block row directly)
// ---------------------------------------------------------------------------

function revertBlockRowField(
  opType: string,
  payload: Record<string, unknown>,
  b: BlockRow,
): boolean {
  switch (opType) {
    case 'create_block':
      b['deleted_at'] = new Date().toISOString()
      return true
    case 'delete_block':
      b['deleted_at'] = null
      return true
    case 'edit_block':
      b['content'] = (payload['from_text'] as string | null) ?? null
      return true
    // NOTE: `move_block` is intentionally handled in `applyRevertForOp`
    // (it needs the whole `blocks` map to renumber both sibling groups) and
    // is therefore NOT a case here. See the #958 fix.
    case 'restore_block':
      b['deleted_at'] = new Date().toISOString()
      return true
    case 'set_todo_state':
      b['todo_state'] = (payload['from_state'] as string | null) ?? null
      return true
    case 'set_priority':
      b['priority'] = (payload['from_level'] as string | null) ?? null
      return true
    case 'set_due_date':
      b['due_date'] = (payload['from_date'] as string | null) ?? null
      return true
    case 'set_scheduled_date':
      b['scheduled_date'] = (payload['from_date'] as string | null) ?? null
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Property map reverts (mutate `properties` map)
// ---------------------------------------------------------------------------

function revertPropertyMap(
  opType: string,
  payload: Record<string, unknown>,
  blockId: string,
  properties: Properties,
): boolean {
  if (opType !== 'set_property' && opType !== 'delete_property') return false

  const key = payload['key'] as string
  const fromValue = payload['from_value'] as Record<string, unknown> | null | undefined

  if (opType === 'set_property') {
    if (fromValue == null) {
      // Prior state: property did not exist → remove the new entry.
      properties.get(blockId)?.delete(key)
    } else {
      // Prior state: property existed with the given typed value.
      if (!properties.has(blockId)) properties.set(blockId, new Map())
      properties.get(blockId)?.set(key, { key, ...fromValue })
    }
    return true
  }

  // delete_property: re-add the prior typed value (or no-op if absent).
  if (fromValue == null) return true
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set(key, { key, ...fromValue })
  return true
}

// ---------------------------------------------------------------------------
// Tag set reverts (mutate `blockTags` map)
// ---------------------------------------------------------------------------

function revertTagSet(
  opType: string,
  payload: Record<string, unknown>,
  blockId: string,
  blockTags: BlockTags,
): boolean {
  if (opType !== 'add_tag' && opType !== 'remove_tag') return false

  const tagId = payload['tag_id'] as string

  if (opType === 'add_tag') {
    blockTags.get(blockId)?.delete(tagId)
    return true
  }

  // remove_tag: re-add the tag.
  if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
  blockTags.get(blockId)?.add(tagId)
  return true
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Apply the inverse of `target` to the in-memory mock state, mutating the
 * matching row(s) in place. Unknown op types and missing target blocks are
 * silent no-ops.
 *
 * For block-row-level reverts (create / delete / edit / move / restore /
 * task-property setters) only `blocks` is required. For property and tag
 * reverts (set_property / delete_property / add_tag / remove_tag) the
 * caller must also pass `state.properties` and/or `state.blockTags`.
 */
export function applyRevertForOp(
  target: MockOpLogEntry,
  blocks: Blocks,
  state: RevertState = {},
): void {
  const payload = JSON.parse(target.payload) as Record<string, unknown>
  const blockId = payload['block_id'] as string

  // Block-row reverts: silent no-op if the block is missing from the map.
  const b = blocks.get(blockId)

  // #958 — move reverts need the whole `blocks` map to renumber sibling groups
  // (see `renumberSiblingsIn`). Restore the old parent + raw old position, then
  // collapse both the source and destination groups back to dense ranks so the
  // `position ASC, id ASC` load order reverts in place (no reopen needed).
  if (target.op_type === 'move_block') {
    if (b) {
      const curParentId = (b['parent_id'] as string | null) ?? null
      const oldParentId = (payload['old_parent_id'] as string | null) ?? null
      // `old_position` is a 1-based dense rank → 0-based slot is `- 1`.
      const oldSlot = ((payload['old_position'] as number) ?? 1) - 1
      b['parent_id'] = oldParentId
      insertAtSlotIn(blocks, oldParentId, blockId, oldSlot)
      if (curParentId !== oldParentId) renumberSiblingsIn(blocks, curParentId)
    }
    return
  }

  if (b && revertBlockRowField(target.op_type, payload, b)) return

  // Property and tag reverts: silent no-op if the relevant aux map wasn't
  // wired in by the caller.
  if (state.properties && revertPropertyMap(target.op_type, payload, blockId, state.properties)) {
    return
  }
  if (state.blockTags && revertTagSet(target.op_type, payload, blockId, state.blockTags)) {
    return
  }
}
