/**
 * Tauri mock — per-op-type revert helper.
 *
 * Extracted from the `revert_ops` handler so the handler body stays flat and
 * stays under Biome's `noExcessiveCognitiveComplexity` threshold. The branching
 * over `op_type` lives here as a single switch statement with one case per
 * reversible op type.
 *
 * Keep behaviour identical to the real backend's reverse logic — this mock is
 * only used in browser/E2E preview, but tests rely on the produced side
 * effects matching what the real `revert_ops` command would produce.
 */

import type { MockOpLogEntry } from './seed'

/**
 * Apply the inverse of `target` to `blocks`, mutating the matching block row in
 * place. Unknown op types and missing target blocks are silent no-ops.
 */
export function applyRevertForOp(
  target: MockOpLogEntry,
  blocks: Map<string, Record<string, unknown>>,
): void {
  const payload = JSON.parse(target.payload) as Record<string, unknown>
  const blockId = payload['block_id'] as string
  const b = blocks.get(blockId)
  if (!b) return

  switch (target.op_type) {
    case 'create_block':
      b['deleted_at'] = new Date().toISOString()
      return
    case 'delete_block':
      b['deleted_at'] = null
      return
    case 'edit_block':
      b['content'] = (payload['from_text'] as string | null) ?? null
      return
    case 'move_block':
      b['parent_id'] = payload['old_parent_id'] as string | null
      b['position'] = payload['old_position'] as number
      return
    case 'restore_block':
      b['deleted_at'] = new Date().toISOString()
      return
    default:
      return
  }
}
