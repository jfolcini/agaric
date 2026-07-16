/**
 * Public surface types for `useBlockSlashCommands`. Kept in a sibling file so
 * the orchestrator at `../useBlockSlashCommands.ts` can import them without
 * pulling in the implementation-detail `SlashCommandContext` /
 * `SlashHandler` shapes from `./types`.
 */

import type { RefObject } from 'react'
import type { StoreApi } from 'zustand'

import type { PickerItem } from '@/editor/SuggestionList'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import type { DatePickerMode, TFn } from '@/hooks/useBlockSlashCommands/types'
import type { PageBlockState } from '@/stores/page-blocks'

export interface UseBlockSlashCommandsParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor' | 'mount'>
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  blocks: Array<{ id: string; parent_id: string | null; content: string | null }>
  load: () => Promise<void>
  t: TFn
  /** Open the visual query builder for the focused block (#215). */
  openQueryBuilder: () => void
  /** Open the browse-grid emoji picker for the focused block (#286). */
  openEmojiPicker: () => void
  /** Open the block property drawer for value entry (#2656). */
  openPropertyDrawer: (blockId: string) => void
}

export interface UseBlockSlashCommandsReturn {
  handleSlashCommand: (item: PickerItem) => Promise<void>
  handleTemplateSelect: (templatePageId: string) => Promise<void>
  handleCheckboxSyntax: (state: 'TODO' | 'DONE') => void
  templatePickerOpen: boolean
  templatePages: Array<{ id: string; content: string; preview: string | null }>
  setTemplatePickerOpen: (open: boolean) => void
}
