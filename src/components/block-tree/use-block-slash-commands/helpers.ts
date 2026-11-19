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
import { unwrap } from '@/lib/app-error'
import type { OpRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useUndoStore } from '@/stores/undo'

/**
 * #2468 — `opRefs` threads a migrated command's `op_refs` (the exact op-log
 * refs it appended) into the undo store so Ctrl+Z is ref-addressed. Handlers
 * whose command is NOT migrated (`setPriority`) omit it — the undo store
 * records a positional-fallback entry; the conditional forward keeps their
 * call shape identical to pre-#2468.
 */
export function notifyUndo(rootParentId: string | null, opRefs?: OpRef[]): void {
  if (!rootParentId) return
  const { onNewAction } = useUndoStore.getState()
  if (opRefs) onNewAction(rootParentId, opRefs)
  else onNewAction(rootParentId)
}

export function readCurrentContent(ctx: SlashCommandContext): string {
  if (ctx.blockText) return ctx.blockText.read()
  if (ctx.rovingEditor.editor) {
    const json = ctx.rovingEditor.editor.getJSON() as DocNode
    return serialize(json, notifyUnknownNodeTypeToast)
  }
  const block = ctx.pageStore.getState().blocksById.get(ctx.blockId)
  return block?.content ?? ''
}

/**
 * Write `newContent` to the block; resolves whether it was written (a refusal is toasted here).
 * The editor and the store take the command's text before the write goes out: a leave or a
 * keystroke while it is on its way then builds on the command's text, where the text from before
 * the command would have been written after it and erased it. A refused write puts back what the
 * block showed, or keeps what was typed on top of the command's text, and saves it, so no typing
 * is lost.
 */
export async function applyContentEdit(
  ctx: SlashCommandContext,
  newContent: string,
  failKey: string,
): Promise<boolean> {
  if (ctx.blockText) {
    ctx.blockText.write(newContent)
    return true
  }
  const shown = readCurrentContent(ctx)
  const stored = ctx.pageStore.getState().blocksById.get(ctx.blockId)?.content
  // Out of the turn that picked the command: the editor's own transaction is still running in it.
  await Promise.resolve()
  setStoredContent(ctx, newContent)
  ctx.rovingEditor.mount(ctx.blockId, newContent)
  try {
    const resp = unwrap(await commands.editBlock(ctx.blockId, newContent, null))
    // Heading/callout/numbered-list/divider slash commands
    // must clear the redo stack just like every other content-edit
    // mutation in `pageStore.edit()`. Pre-fix this was missing, so a
    // user could `Cmd+Z` past a slash command and `Cmd+Shift+Z` would
    // resurrect the wrong content. Mirror the `pageStore.edit()`
    // contract (`edit` in `src/stores/page-blocks-reducers.ts`) by calling `notifyUndo` here.
    // #2468 — thread the edit's op ref(s) for ref-addressed undo.
    notifyUndo(ctx.rootParentId, resp.op_refs)
    return true
  } catch {
    notify.error(ctx.t(failKey))
    // Typing on top of the command's text while it was on its way is kept, the command with it.
    const editing = ctx.rovingEditor.activeBlockId === ctx.blockId
    const live = editing ? readCurrentContent(ctx) : newContent
    const kept = live === newContent ? shown : live
    if (stored !== undefined) setStoredContent(ctx, stored)
    if (editing && kept === shown) ctx.rovingEditor.mount(ctx.blockId, shown)
    if (kept !== (stored ?? '')) void ctx.pageStore.getState().edit(ctx.blockId, kept)
    return false
  }
}

function setStoredContent(ctx: SlashCommandContext, content: string | null): void {
  ctx.pageStore.setState((state) => ({
    blocks: state.blocks.map((b) => (b.id === ctx.blockId ? { ...b, content } : b)),
  }))
}

export function openDatePicker(ctx: SlashCommandContext, mode: DatePickerMode): void {
  ctx.datePickerCursorPos.current = ctx.rovingEditor.editor?.state.selection.$anchor.pos
  ctx.setDatePickerMode(mode)
  ctx.setDatePickerOpen(true)
}

export function warnIfBlocked(ctx: SlashCommandContext): void {
  // Single-key PK lookup against the `blocked_by`
  // row instead of fetching every property on the block.
  commands
    .getProperty(ctx.blockId, 'blocked_by')
    .then(unwrap)
    .then((row) => {
      const hasBlockedBy = row != null && row.value_ref != null
      if (hasBlockedBy)
        notify.warning(ctx.t('dependency.dependencyWarning'), { id: 'dependency-warning' })
    })
    .catch((err) => {
      logger.warn('useBlockSlashCommands', 'dependency check failed', undefined, err)
    })
}
