/**
 * Mark slash commands (#211 P0-5) — `/bold` `/italic` `/code` `/strike`
 * `/highlight`. Each gives keyboard- and mouse-only users a `/`-menu path to
 * the inline marks that were previously reachable only via Markdown syntax or
 * the selection bubble menu.
 *
 * The menu only opens at a collapsed caret, so each command toggles its mark
 * there as a stored mark and the next typed text carries it. The toggle is
 * the canonical `createMarkToggles` action, so `/bold` and the bubble-menu
 * Bold button stay wired to the same TipTap command
 * (`src/components/FormattingToolbar/toolbar-config.ts`). The picker deletes
 * the `/query` before the handler runs (`slash-command.ts`); a doc change
 * after the toggle would clear the stored mark.
 *
 * `code-mark` is the inline-code *mark*; the code-*block* command lives in
 * `useSlashCommandStructural` under the `code` id.
 */

import { useMemo } from 'react'

import type {
  SlashCommandContext,
  SlashHandlerTables,
} from '@/components/block-tree/use-block-slash-commands/types'
import { createMarkToggles } from '@/components/FormattingToolbar/toolbar-config'

// `PickerItem.id` → `activeKey` of the matching `createMarkToggles` entry.
// `code-mark` → the `code` toggle; the id differs from the code-block
// command's `code` id so the two coexist in the menu.
const MARK_KEYS: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  'code-mark': 'code',
  strike: 'strike',
  highlight: 'highlight',
}

function handleMark(ctx: SlashCommandContext, activeKey: string): void {
  const editor = ctx.rovingEditor.editor
  if (!editor) return
  createMarkToggles(editor)
    .find((b) => b.activeKey === activeKey)
    ?.action()
}

export function useSlashCommandMarks(): SlashHandlerTables {
  return useMemo<SlashHandlerTables>(
    () => ({
      exact: Object.fromEntries(
        Object.entries(MARK_KEYS).map(([id, activeKey]) => [
          id,
          (ctx: SlashCommandContext) => handleMark(ctx, activeKey),
        ]),
      ),
      prefix: [],
    }),
    [],
  )
}
