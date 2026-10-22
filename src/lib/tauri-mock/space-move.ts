/**
 * Tauri mock — what a cross-space move drops (#5841 S0.6). Mirrors
 * `src-tauri/src/commands/blocks/space_move.rs`.
 *
 * A move keeps a property when both spaces define its key identically (same
 * `value_type` and `options`) or neither defines it; a built-in is never a
 * definition row, so it compares as undeclared on both sides and stays. The
 * blocks a move takes are each live root and its page group (`page_id` =
 * root), trashed rows included; a nested page keeps its own space.
 */

import type { PropertyLoss } from '@/lib/bindings'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import {
  appErrorRejection,
  ownerSpaceOf,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, properties, propertyDefs, pushOp } from '@/lib/tauri-mock/seed'

/** `MAX_REVERT_OPS` (`commands/history.rs`): the ops one undo reverts. */
const MAX_REVERT_OPS = 1000

/** One value a move drops, shaped as `list_property_loss_values` answers it. */
export type LossValue = Record<string, unknown> & { block_id: string; key: string }

function isLive(id: string): boolean {
  const b = blocks.get(id)
  return b != null && b['deleted_at'] == null
}

function sameDefinition(key: string, source: string | null, target: string): boolean {
  const from = source === null ? undefined : propertyDefs.get(source)?.get(key)
  const to = propertyDefs.get(target)?.get(key)
  return (
    (from?.['value_type'] ?? null) === (to?.['value_type'] ?? null) &&
    (from?.['options'] ?? null) === (to?.['options'] ?? null)
  )
}

/** Every value moving `ids` to `target` drops, ordered by `(block_id, key)`. */
export function spaceMoveLossValues(ids: string[], target: string): LossValue[] {
  const roots = new Set(ids.filter(isLive))
  const out: LossValue[] = []
  for (const b of blocks.values()) {
    const id = b['id'] as string
    if (!roots.has(id) && !roots.has(b['page_id'] as string)) continue
    const source = ownerSpaceOf(b)
    if (source === target) continue
    const pageId = (b['page_id'] as string | null) ?? null
    for (const row of properties.get(id)?.values() ?? []) {
      const key = row['key'] as string
      if (key === 'space' || sameDefinition(key, source, target)) continue
      out.push({
        block_id: id,
        page_id: pageId,
        page_title: pageId === null ? null : ((blocks.get(pageId)?.['content'] as string) ?? null),
        content: (b['content'] as string | null) ?? null,
        deleted: b['deleted_at'] != null,
        key,
        value_text: row['value_text'] ?? null,
        value_num: row['value_num'] ?? null,
        value_date: row['value_date'] ?? null,
        value_ref: row['value_ref'] ?? null,
        value_bool: row['value_bool'] ?? null,
      })
    }
  }
  return out.toSorted(
    (x, y) => compareUtf8Bytes(x.block_id, y.block_id) || compareUtf8Bytes(x.key, y.key),
  )
}

/** Per key, how many values moving `ids` to `target` drops, ordered by key. */
export function spaceMoveLosses(ids: string[], target: string): PropertyLoss[] {
  const counts = new Map<string, number>()
  for (const value of spaceMoveLossValues(ids, target)) {
    counts.set(value.key, (counts.get(value.key) ?? 0) + 1)
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .toSorted((x, y) => compareUtf8Bytes(x.key, y.key))
}

/**
 * Mock twin of `drop_acknowledged_losses_in_tx`: refuse a move over one undo
 * or whose losses differ from `rawAck`, else drop each lost value with the op
 * its undo restores it from. Runs before the move appends its `space` ops.
 */
export function dropAcknowledgedLosses(ids: string[], target: string, rawAck: unknown): void {
  const losses = spaceMoveLosses(ids, target)
  const values = losses.reduce((n, loss) => n + loss.count, 0)
  if (values === 0) return
  if (values + new Set(ids.filter(isLive)).size > MAX_REVERT_OPS) {
    throw validationRejection(
      `this move would remove ${values} property values, more than one undo can restore; ` +
        'move fewer pages',
    )
  }
  const ack = ((rawAck as PropertyLoss[] | null | undefined) ?? []).toSorted((x, y) =>
    compareUtf8Bytes(x.key, y.key),
  )
  const same =
    ack.length === losses.length &&
    ack.every((a, i) => a.key === losses[i]?.key && a.count === losses[i]?.count)
  if (!same) {
    throw appErrorRejection({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
      message:
        'moving would remove values of properties the target space does not define the same ' +
        `way: ${losses.map((loss) => `${loss.key} (${loss.count})`).join(', ')}`,
    })
  }
  for (const value of spaceMoveLossValues(ids, target)) {
    properties.get(value.block_id)?.delete(value.key)
    pushOp('delete_property', {
      block_id: value.block_id,
      key: value.key,
      from_value: {
        value_text: value['value_text'],
        value_num: value['value_num'],
        value_date: value['value_date'],
        value_ref: value['value_ref'],
        value_bool: value['value_bool'],
      },
    })
  }
}
