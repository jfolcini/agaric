/**
 * Template-related slash commands: just `/template`, which opens the
 * template picker. All picker state + the post-pick insertion handler
 * already live in `useTemplateSelection`; this sub-hook is the thin wrapper
 * that exposes the picker hooks alongside a single-entry dispatch table for
 * the dispatcher to merge.
 *
 * The dispatch table itself is `useMemo`-stable: the `template` handler
 * reads `ctx.openTemplatePicker` at call time, so changes to the underlying
 * `openTemplatePicker` (which rebuilds whenever `t` changes) don't
 * invalidate the table.
 */

import { useMemo } from 'react'

import {
  type UseTemplateSelectionParams,
  type UseTemplateSelectionReturn,
  useTemplateSelection,
} from '../useTemplateSelection'
import type { SlashHandlerTables } from './types'

export interface UseSlashCommandTemplateReturn extends UseTemplateSelectionReturn {
  tables: SlashHandlerTables
}

export function useSlashCommandTemplate(
  params: UseTemplateSelectionParams,
): UseSlashCommandTemplateReturn {
  const selection = useTemplateSelection(params)

  const tables = useMemo<SlashHandlerTables>(
    () => ({
      exact: {
        template: (ctx) => ctx.openTemplatePicker(),
      },
      prefix: [],
    }),
    [],
  )

  return {
    ...selection,
    tables,
  }
}
