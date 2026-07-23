/**
 * Helpers shared by the slash-command sub-hooks. Each helper is a pure
 * function over `SlashCommandContext` — it never closes over React state,
 * which is what lets the sub-hooks return memoised dispatch tables with
 * empty dep arrays.
 */

import type {
  DatePickerMode,
  SlashCommandContext,
} from '@/components/block-tree/use-block-slash-commands/types'
import { notifyUnknownNodeTypeToast } from '@/editor/markdown-serialize-toast'
import { serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { editBlock, getProperty, type OpRef } from '@/lib/tauri'
import { useUndoStore } from '@/stores/undo'

/**
 * #2468 — `opRefs` threads a migrated command's `op_refs` (the exact op-log
 * refs it appended) into the undo store so Ctrl+Z is ref-addressed. Handlers
 * whose command is NOT migrated (`setTodoState` / `setPriority`) omit it —
 * the undo store records a positional-fallback entry; the conditional forward
 * keeps their call shape identical to pre-#2468.
 */
export function notifyUndo(rootParentId: string | null, opRefs?: OpRef[]): void {
  if (!rootParentId) return
  const { onNewAction } = useUndoStore.getState()
  if (opRefs) onNewAction(rootParentId, opRefs)
  else onNewAction(rootParentId)
}

export function readCurrentContent(ctx: SlashCommandContext): string {
  if (ctx.rovingEditor.editor) {
    const json = ctx.rovingEditor.editor.getJSON() as DocNode
    return serialize(json, notifyUnknownNodeTypeToast)
  }
  const block = ctx.pageStore.getState().blocksById.get(ctx.blockId)
  return block?.content ?? ''
}

export async function applyContentEdit(
  ctx: SlashCommandContext,
  newContent: string,
  failKey: string,
): Promise<void> {
  try {
    const resp = await editBlock(ctx.blockId, newContent)
    // Heading/callout/numbered-list/divider slash commands
    // must clear the redo stack just like every other content-edit
    // mutation in `pageStore.edit()`. Pre-fix this was missing, so a
    // user could `Cmd+Z` past a slash command and `Cmd+Shift+Z` would
    // resurrect the wrong content. Mirror the `pageStore.edit()`
    // contract (`page-blocks.ts:392`) by calling `notifyUndo` here.
    // #2468 — thread the edit's op ref(s) for ref-addressed undo.
    notifyUndo(ctx.rootParentId, resp.op_refs)
    ctx.pageStore.setState((state) => ({
      blocks: state.blocks.map((b) => (b.id === ctx.blockId ? { ...b, content: newContent } : b)),
    }))
    ctx.rovingEditor.mount(ctx.blockId, newContent)
  } catch {
    notify.error(ctx.t(failKey))
  }
}

export function openDatePicker(ctx: SlashCommandContext, mode: DatePickerMode): void {
  ctx.datePickerCursorPos.current = ctx.rovingEditor.editor?.state.selection.$anchor.pos
  ctx.setDatePickerMode(mode)
  ctx.setDatePickerOpen(true)
}

export function warnIfBlocked(ctx: SlashCommandContext): void {
  // Single-key PK lookup against the `blocked_by`
  // row instead of fetching every property on the block.
  getProperty(ctx.blockId, 'blocked_by')
    .then((row) => {
      const hasBlockedBy = row != null && row.value_ref != null
      if (hasBlockedBy)
        notify.warning(ctx.t('dependency.dependencyWarning'), { id: 'dependency-warning' })
    })
    .catch((err) => {
      logger.warn('useBlockSlashCommands', 'dependency check failed', undefined, err)
    })
}
