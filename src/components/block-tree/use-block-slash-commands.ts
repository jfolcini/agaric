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
 * D-4 — the per-category handlers themselves are split across four
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
 * The command catalog + search helpers live in `../lib/slash-commands` —
 * import them from there directly rather than through this module.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { canRecordVoiceNote } from '@/components/attachments/voice-recording'
import type {
  SlashCommandContext,
  SlashHandlerTables,
} from '@/components/block-tree/use-block-slash-commands/types'
import type {
  UseBlockSlashCommandsParams,
  UseBlockSlashCommandsReturn,
} from '@/components/block-tree/use-block-slash-commands/types-public'
import { useSlashCommandDate } from '@/components/block-tree/use-block-slash-commands/useSlashCommandDate'
import { useSlashCommandMarks } from '@/components/block-tree/use-block-slash-commands/useSlashCommandMarks'
import { useSlashCommandProperty } from '@/components/block-tree/use-block-slash-commands/useSlashCommandProperty'
import { useSlashCommandStructural } from '@/components/block-tree/use-block-slash-commands/useSlashCommandStructural'
import { useSlashCommandTemplate } from '@/components/block-tree/use-block-slash-commands/useSlashCommandTemplate'
import type { PickerItem } from '@/editor/SuggestionList'
import { useCheckboxSyntax } from '@/hooks/useCheckboxSyntax'
import { useListStyleSyntax } from '@/hooks/useListStyleSyntax'
import { searchSlashCommands } from '@/lib/slash-commands'
import { addRecentCommand, getRecentCommands, RECENT_SLASH_PREFIX } from '@/stores/recent-commands'

export type {
  UseBlockSlashCommandsParams,
  UseBlockSlashCommandsReturn,
} from '@/components/block-tree/use-block-slash-commands/types-public'

/**
 * Merge the sub-hook tables. Order is fixed:
 *   1. exact: template, date, property, structural, marks — keys are disjoint
 *      so the merge order is for readability only.
 *   2. prefix: property first (`assignee-`, `location-`, `effort-`,
 *      `repeat-limit-`, `repeat-`), then structural (`turn-`, `callout-`).
 *      No prefix collisions across categories.
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

/**
 * Run the picked command on `ctx.blockId`, and record it in the slash menu's
 * MRU (#1105, its own namespace) so an empty `/` can show a "Recent" band.
 * Recorded before dispatch; the band join (in `searchSlashCommands`) skips ids
 * absent from the base catalog, so recording expanded sub-option ids (e.g.
 * `priority-high`) is harmless. Block mode and page mode (#5743) both run
 * commands through here.
 */
export async function runSlashCommand(
  tables: SlashHandlerTables,
  ctx: SlashCommandContext,
  item: PickerItem,
): Promise<void> {
  addRecentCommand(item.id, RECENT_SLASH_PREFIX)
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

/** The slash menu for `query`: the catalog, with recent commands on an empty query, less `/voice` where nothing can record. */
export function searchSlashMenu(query: string): PickerItem[] {
  return searchSlashCommands(query, getRecentCommands(RECENT_SLASH_PREFIX)).filter(
    (command) => command.id !== 'voice' || canRecordVoiceNote(),
  )
}

/** Every command's handler but `/template`'s, whose picker state is its caller's. */
export function useSlashHandlers(): SlashHandlerTables {
  const date = useSlashCommandDate()
  const property = useSlashCommandProperty()
  const structural = useSlashCommandStructural()
  const marks = useSlashCommandMarks()
  return useMemo(
    () => mergeSlashHandlerTables(date, property, structural, marks),
    [date, property, structural, marks],
  )
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
  openPropertyDrawer,
  openVoiceNoteRecorder,
}: UseBlockSlashCommandsParams): UseBlockSlashCommandsReturn {
  const template = useSlashCommandTemplate({ focusedBlockId, rootParentId, blocks, load, t })
  const handlers = useSlashHandlers()

  const handleCheckboxSyntax = useCheckboxSyntax({
    focusedBlockId,
    rootParentId,
    pageStore,
    t,
  })
  const handleListStyleSyntax = useListStyleSyntax({ focusedBlockId, t })
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const openTablePicker = () => setTablePickerOpen(true)

  const tables = useMemo(
    () => mergeSlashHandlerTables(template.tables, handlers),
    [template.tables, handlers],
  )

  // Bundle every per-call dispatcher input into a single ref. This is what
  // lets `handleSlashCommand` keep a stable identity (only `focusedBlockId`
  // gates it) without needing an `oxlint-disable react-hooks/exhaustive-deps` —
  // Refs are not subject to the rule. The stability test in
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
    openTablePicker,
    openPropertyDrawer,
    openVoiceNoteRecorder,
    tables,
  })
  useLayoutEffect(() => {
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
      openTablePicker,
      openPropertyDrawer,
      openVoiceNoteRecorder,
      tables,
    }
  })

  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      if (!focusedBlockId) return
      const { tables: t_, ...rest } = inputsRef.current
      const ctx: SlashCommandContext = { blockId: focusedBlockId, ...rest }
      await runSlashCommand(t_, ctx, item)
    },
    [focusedBlockId],
  )

  return {
    handleSlashCommand,
    handleTemplateSelect: template.handleTemplateSelect,
    handleCheckboxSyntax,
    handleListStyleSyntax,
    templatePickerOpen: template.templatePickerOpen,
    templatePages: template.templatePages,
    setTemplatePickerOpen: template.setTemplatePickerOpen,
    tablePickerOpen,
    setTablePickerOpen,
  }
}
