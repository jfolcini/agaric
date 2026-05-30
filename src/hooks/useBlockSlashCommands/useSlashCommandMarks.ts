/**
 * Mark slash commands (#211 P0-5) — `/bold` `/italic` `/code` `/strike`
 * `/highlight`. Each gives keyboard- and mouse-only users a `/`-menu path to
 * the inline marks that were previously reachable only via Markdown syntax or
 * the selection bubble menu.
 *
 * Behaviour per command:
 *   - With a non-empty selection → toggle the mark on the selection, reusing
 *     the canonical `createMarkToggles` action so the TipTap command stays a
 *     single source of truth (`src/lib/toolbar-config.ts`).
 *   - With no selection → insert the Markdown delimiter pair and park the
 *     caret between the delimiters, so the next keystrokes land inside.
 *
 * `code-mark` is the inline-code *mark*; the code-*block* command lives in
 * `useSlashCommandStructural` under the `code` id.
 */

import { useMemo } from 'react'

import { createMarkToggles } from '@/lib/toolbar-config'

import type { SlashCommandContext, SlashHandlerTables } from './types'

interface MarkSpec {
  /** `activeKey` of the matching `createMarkToggles` entry (the TipTap toggle). */
  activeKey: string
  /** Markdown delimiter inserted (doubled) when there is no selection. */
  delimiter: string
}

// Keyed by `PickerItem.id`. `code-mark` → the `code` toggle; the id differs
// from the code-block command's `code` id so the two coexist in the menu.
const MARK_SPECS: Record<string, MarkSpec> = {
  bold: { activeKey: 'bold', delimiter: '**' },
  italic: { activeKey: 'italic', delimiter: '*' },
  'code-mark': { activeKey: 'code', delimiter: '`' },
  strike: { activeKey: 'strike', delimiter: '~~' },
  highlight: { activeKey: 'highlight', delimiter: '==' },
}

function handleMark(ctx: SlashCommandContext, spec: MarkSpec): void {
  const editor = ctx.rovingEditor.editor
  if (!editor) return

  const { from, to } = editor.state.selection
  if (from !== to) {
    // Reuse the shared toggle so `/bold` and the bubble-menu Bold button stay
    // wired to the same TipTap command.
    const toggle = createMarkToggles(editor).find((b) => b.activeKey === spec.activeKey)
    toggle?.action()
    return
  }

  // No selection: insert the delimiter pair and park the caret between them.
  const { delimiter } = spec
  editor
    .chain()
    .focus()
    .insertContent(delimiter + delimiter)
    .run()
  editor.commands.setTextSelection(editor.state.selection.from - delimiter.length)
}

export function useSlashCommandMarks(): SlashHandlerTables {
  return useMemo<SlashHandlerTables>(
    () => ({
      exact: Object.fromEntries(
        Object.entries(MARK_SPECS).map(([id, spec]) => [
          id,
          (ctx: SlashCommandContext) => handleMark(ctx, spec),
        ]),
      ),
      prefix: [],
    }),
    [],
  )
}
