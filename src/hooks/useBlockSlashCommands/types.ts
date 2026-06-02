/**
 * Shared types for the slash-command sub-hooks. Each sub-hook returns a
 * partial dispatch table (`exact` + `prefix` slices); the parent dispatcher
 * merges them and walks the merged tables on every `handleSlashCommand` call.
 *
 * Handlers are pure `(ctx, item) => Promise<void> | void` functions — they
 * do *not* close over React state. Per-call "current" values (latest
 * `rootParentId`, `t`, `rovingEditor`, …) are read off the `ctx` argument
 * built by the dispatcher from refs. This is what lets each sub-hook return
 * a `useMemo`-stable dispatch table with an empty dep array — no
 * `oxlint-disable react-hooks/exhaustive-deps` needed.
 */

import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import type { StoreApi } from 'zustand'

import type { PickerItem } from '../../editor/SuggestionList'
import type { RovingEditorHandle } from '../../editor/use-roving-editor'
import type { PageBlockState } from '../../stores/page-blocks'

export type DatePickerMode = 'date' | 'due' | 'schedule' | 'repeat-until'

export type TFn = TFunction

/**
 * Immutable, dispatcher-only snapshot of the hook state used by a single
 * `handleSlashCommand` invocation. Built from the latest refs at call time so
 * downstream handlers always see the current `rootParentId`, `rovingEditor`,
 * `t`, etc. without rebuilding the memoised callback.
 */
export interface SlashCommandContext {
  blockId: string
  rootParentId: string | null
  rovingEditor: Pick<RovingEditorHandle, 'editor' | 'mount'>
  pageStore: StoreApi<PageBlockState>
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  t: TFn
  openTemplatePicker: () => Promise<void>
  /** Open the visual query builder (#215) pre-populated for the focused block. */
  openQueryBuilder: () => void
  /** Open the browse-grid emoji picker (#286); on select it inserts at the caret. */
  openEmojiPicker: () => void
}

export type SlashHandler = (ctx: SlashCommandContext, item: PickerItem) => Promise<void> | void

/**
 * A sub-hook's contribution to the merged dispatch table.
 *
 * `exact` is keyed by literal `PickerItem.id`. `prefix` is an ordered list
 * of `[prefix, handler]` pairs scanned by the dispatcher *after* exact
 * lookup misses; earlier entries win. Sub-hooks own the relative order of
 * their own prefixes — the dispatcher concatenates contributions in a
 * fixed order (see `useBlockSlashCommands.ts`).
 */
export interface SlashHandlerTables {
  exact: Record<string, SlashHandler>
  prefix: ReadonlyArray<readonly [string, SlashHandler]>
}
