import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { BlockRow } from '@/lib/bindings'

/** Set or clear the todo state on a block. Pass null to clear. */
export async function setTodoState(blockId: string, state: string | null): Promise<BlockRow> {
  return unwrap(await commands.setTodoState(blockId, state))
}

/**
 * Batch set/clear todo state across a list of blocks
 * inside a single backend IMMEDIATE transaction. Returns the number of
 * blocks whose `todo_state` actually changed.
 *
 * Replaces the per-row `setTodoState` IPC loop in
 * `useBlockMultiSelect.handleBatchSetTodo`. Multi-select "mark done"
 * used to fire one IPC per selected block (50 IPCs for a 50-row
 * gesture); the new path is one IPC, one writer-lock window, one
 * op_log append-scope.
 *
 * Missing / soft-deleted ids are silently skipped on the backend
 * (best-effort across the surviving subset). The single-row
 * `setTodoState` path stays in place for the per-block call sites
 * (BlockContextMenu, slash commands) — its recurrence + timestamp
 * transitions (`created_at` / `completed_at` auto-population, repeat
 * sibling creation) are intentionally NOT applied by the batch path
 * because propagating them per item under one IMMEDIATE lock would
 * defeat the latency win.
 */
export async function setTodoStateBatch(blockIds: string[], state: string | null): Promise<number> {
  return unwrap(await commands.setTodoStateBatch(blockIds, state))
}

/** Set or clear the priority level on a block. Pass null to clear. */
export async function setPriority(blockId: string, level: string | null): Promise<BlockRow> {
  return unwrap(await commands.setPriority(blockId, level))
}

/** Set or clear the due date on a block. Pass null to clear. */
export async function setDueDate(blockId: string, date: string | null): Promise<BlockRow> {
  return unwrap(await commands.setDueDate(blockId, date))
}

/** Set or clear the scheduled date on a block. Pass null to clear. */
export async function setScheduledDate(blockId: string, date: string | null): Promise<BlockRow> {
  return unwrap(await commands.setScheduledDate(blockId, date))
}
