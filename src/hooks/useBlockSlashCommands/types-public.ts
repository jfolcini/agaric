/**
 * Public surface types for `useBlockSlashCommands`. Kept in a sibling file so
 * the orchestrator at `../useBlockSlashCommands.ts` can import them without
 * pulling in the implementation-detail `SlashCommandContext` /
 * `SlashHandler` shapes from `./types`.
 */

import type { RefObject } from 'react'
import type { StoreApi } from 'zustand'

import type { PickerItem } from '../../editor/SuggestionList'
import type { RovingEditorHandle } from '../../editor/use-roving-editor'
import type { PageBlockState } from '../../stores/page-blocks'
import type { DatePickerMode, TFn } from './types'

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
}

export interface UseBlockSlashCommandsReturn {
  handleSlashCommand: (item: PickerItem) => Promise<void>
  handleTemplateSelect: (templatePageId: string) => Promise<void>
  handleCheckboxSyntax: (state: 'TODO' | 'DONE') => void
  templatePickerOpen: boolean
  templatePages: Array<{ id: string; content: string; preview: string | null }>
  setTemplatePickerOpen: (open: boolean) => void
}
