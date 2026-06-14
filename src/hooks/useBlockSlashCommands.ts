/**
 * Slash-command orchestrator.
 *
 * Owns the central `handleSlashCommand` state machine — dispatches each
 * picked slash item to the right Tauri command, editor mutation, or sub-hook
 * (template picker, date picker). State-heavy concerns have been split out:
 *   - command catalog + search helpers → `src/lib/slash-commands.ts`
 *   - template-picker state + insertion → `useTemplateSelection` (via the
 *     `useSlashCommandTemplate` sub-hook)
 *   - checkbox-syntax TODO/DONE handler → `useCheckboxSyntax`
 *
 * PEND-30 D-4 — the per-category handlers themselves are split across four
 * sub-hooks under `./useBlockSlashCommands/`:
 *   - `useSlashCommandTemplate` — `/template` (+ picker state passthrough)
 *   - `useSlashCommandDate`     — `/date`, `/due`, `/schedule`, `/repeat-until`
 *   - `useSlashCommandProperty` — TODO state, priority, assignee, location,
 *                                 effort, repeat, repeat-limit, attach
 *   - `useSlashCommandStructural` — headings, callouts, code/quote, lists,
 *                                   dividers, tables, link/tag/query inserts
 *
 * Each sub-hook returns a `SlashHandlerTables` slice (`exact` + ordered
 * `prefix` entries). This file's `useBlockSlashCommands` calls the four
 * sub-hooks, merges their slices once via `useMemo`, and exposes a single
 * `handleSlashCommand` callback that walks the merged tables.
 *
 * For backward compatibility with existing import sites (and tests) the
 * command arrays and search helpers are re-exported from this module.
 */

import { useCallback, useMemo, useRef } from 'react'

import type { PickerItem } from '../editor/SuggestionList'
import { addRecentCommand, RECENT_SLASH_PREFIX } from '../lib/recent-commands'
import type { SlashCommandContext, SlashHandlerTables } from './useBlockSlashCommands/types'
import type {
  UseBlockSlashCommandsParams,
  UseBlockSlashCommandsReturn,
} from './useBlockSlashCommands/types-public'
import { useSlashCommandDate } from './useBlockSlashCommands/useSlashCommandDate'
import { useSlashCommandMarks } from './useBlockSlashCommands/useSlashCommandMarks'
import { useSlashCommandProperty } from './useBlockSlashCommands/useSlashCommandProperty'
import { useSlashCommandStructural } from './useBlockSlashCommands/useSlashCommandStructural'
import { useSlashCommandTemplate } from './useBlockSlashCommands/useSlashCommandTemplate'
import { useCheckboxSyntax } from './useCheckboxSyntax'

// Re-export command catalog + search helpers from the data module so existing
// consumers (BlockTree.tsx, the test suite) keep working.
export {
  ASSIGNEE_COMMANDS,
  CALLOUT_COMMANDS,
  EFFORT_COMMANDS,
  HEADING_COMMANDS,
  LOCATION_COMMANDS,
  PRIORITY_COMMANDS,
  REPEAT_COMMANDS,
  SLASH_COMMANDS,
  searchPropertyKeys,
  searchSlashCommands,
} from '../lib/slash-commands'

export type {
  UseBlockSlashCommandsParams,
  UseBlockSlashCommandsReturn,
} from './useBlockSlashCommands/types-public'

/**
 * Merge the sub-hook tables. Order is fixed:
 *   1. exact: template, date, property, structural, marks — keys are disjoint
 *      so the merge order is for readability only.
 *   2. prefix: property first (`assignee-`, `location-`, `effort-`,
 *      `repeat-limit-`, `repeat-`), then structural (`table:`, `callout-`).
 *      No prefix collisions across categories — `table:` (with colon) does
 *      not match the generic `table` exact key.
 *
 * Exported so the dispatcher regression test can verify the merged shape.
 */
export function mergeSlashHandlerTables(
  ...tables: ReadonlyArray<SlashHandlerTables>
): SlashHandlerTables {
  const exact: Record<string, SlashHandlerTables['exact'][string]> = {}
  const prefix: Array<readonly [string, SlashHandlerTables['exact'][string]]> = []
  for (const t of tables) {
    for (const [key, handler] of Object.entries(t.exact)) {
      if (key in exact) {
        throw new Error(`useBlockSlashCommands: duplicate exact handler for "${key}"`)
      }
      exact[key] = handler
    }
    prefix.push(...t.prefix)
  }
  return { exact, prefix }
}

async function dispatchSlashCommand(
  tables: SlashHandlerTables,
  ctx: SlashCommandContext,
  item: PickerItem,
): Promise<void> {
  const exact = tables.exact[item.id]
  if (exact) {
    await exact(ctx, item)
    return
  }
  for (const [pfx, handler] of tables.prefix) {
    if (item.id.startsWith(pfx)) {
      await handler(ctx, item)
      return
    }
  }
}

export function useBlockSlashCommands({
  focusedBlockId,
  rootParentId,
  pageStore,
  rovingEditor,
  datePickerCursorPos,
  setDatePickerMode,
  setDatePickerOpen,
  blocks,
  load,
  t,
  openQueryBuilder,
  openEmojiPicker,
}: UseBlockSlashCommandsParams): UseBlockSlashCommandsReturn {
  const template = useSlashCommandTemplate({ focusedBlockId, rootParentId, blocks, load, t })
  const date = useSlashCommandDate()
  const property = useSlashCommandProperty()
  const structural = useSlashCommandStructural()
  const marks = useSlashCommandMarks()

  const handleCheckboxSyntax = useCheckboxSyntax({
    focusedBlockId,
    rootParentId,
    pageStore,
    t,
  })

  const tables = useMemo(
    () => mergeSlashHandlerTables(template.tables, date, property, structural, marks),
    [template.tables, date, property, structural, marks],
  )

  // Bundle every per-call dispatcher input into a single ref. This is what
  // lets `handleSlashCommand` keep a stable identity (only `focusedBlockId`
  // gates it) without needing an `oxlint-disable react-hooks/exhaustive-deps` —
  // refs are not subject to the rule. The MAINT-10 stability test in
  // `__tests__/useBlockSlashCommands.test.ts` pins the contract.
  const inputsRef = useRef({
    rootParentId,
    rovingEditor,
    pageStore,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    t,
    openTemplatePicker: template.openTemplatePicker,
    openQueryBuilder,
    openEmojiPicker,
    tables,
  })
  inputsRef.current = {
    rootParentId,
    rovingEditor,
    pageStore,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    t,
    openTemplatePicker: template.openTemplatePicker,
    openQueryBuilder,
    openEmojiPicker,
    tables,
  }

  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      if (!focusedBlockId) return
      // #1105 — record the run into the slash-menu MRU (own namespace, no
      // collision with palette command ids) so empty `/` can surface a
      // "Recent" band. Recorded before dispatch; the band join (in
      // `searchSlashCommands`) skips ids absent from the base catalog, so
      // recording expanded sub-option ids (e.g. `table:3:3`) is harmless.
      addRecentCommand(item.id, RECENT_SLASH_PREFIX)
      const { tables: t_, ...rest } = inputsRef.current
      const ctx: SlashCommandContext = { blockId: focusedBlockId, ...rest }
      await dispatchSlashCommand(t_, ctx, item)
    },
    [focusedBlockId],
  )

  return {
    handleSlashCommand,
    handleTemplateSelect: template.handleTemplateSelect,
    handleCheckboxSyntax,
    templatePickerOpen: template.templatePickerOpen,
    templatePages: template.templatePages,
    setTemplatePickerOpen: template.setTemplatePickerOpen,
  }
}
