import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import type { OpRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { requireActiveScope } from '@/lib/space-scope'
import type { PageBlockState } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

export type DatePickerMode = 'date' | 'due' | 'schedule' | 'repeat-until'

type TFn = TFunction

export interface UseBlockDatePickerParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor'>
  /**
   * #4319 — `useBlockResolve().registerCreatedPage`. This used to be
   * `pagesListRef` itself, and `handleDateMode` appended to it by hand —
   * without the generation bump an in-flight picker fill needs to lose the
   * race, and without the "only append into an already-filled cache" guard
   * that keeps an empty cache meaning "not fetched yet". Neither invariant
   * is stated here any more: this hook cannot reach the cache except
   * through the one function that carries both.
   */
  registerCreatedPage: (row: { id: string; title: string }) => void
  t: TFn
}

export interface UseBlockDatePickerReturn {
  datePickerOpen: boolean
  datePickerMode: DatePickerMode
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerOpen: (open: boolean) => void
  setDatePickerMode: (mode: DatePickerMode) => void
  handleDatePick: (d: Date) => Promise<void>
}

// ---------------------------------------------------------------------------
// Dispatch infrastructure
// ---------------------------------------------------------------------------

/** Snapshot of mode-specific inputs, built fresh per pick. */
interface DatePickContext {
  blockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor'>
  /** See `UseBlockDatePickerParams['registerCreatedPage']`. */
  registerCreatedPage: (row: { id: string; title: string }) => void
  t: TFn
  /** ISO date string: YYYY-MM-DD. */
  dateStr: string
  /** Legacy DD/MM/YYYY string kept for backward-compat page lookup. */
  legacyStr: string
}

type DatePickHandler = (ctx: DatePickContext) => Promise<void> | void

/**
 * #2468 — `opRefs` threads a migrated command's `op_refs` into the undo store
 * (ref-addressed undo). `setDueDate` / `setScheduledDate` are NOT migrated
 * yet, so their handlers omit it (positional-fallback entry); the conditional
 * forward keeps their call shape identical to pre-#2468.
 */
function notifyUndo(rootParentId: string | null, opRefs?: OpRef[]): void {
  if (!rootParentId) return
  const { onNewAction } = useUndoStore.getState()
  if (opRefs) onNewAction(rootParentId, opRefs)
  else onNewAction(rootParentId)
}

function formatIsoDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${yyyy}-${mm}-${dd}`
}

function formatLegacyDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// ---------------------------------------------------------------------------
// Mode handlers — each owns its own optimistic store update + error notify.
// ---------------------------------------------------------------------------

async function handleDueMode(ctx: DatePickContext): Promise<void> {
  if (!ctx.blockId) return
  const blockId = ctx.blockId
  try {
    unwrap(await commands.setDueDate(blockId, ctx.dateStr))
    notifyUndo(ctx.rootParentId)
    ctx.pageStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, due_date: ctx.dateStr } : b)),
    }))
  } catch {
    notify.error(ctx.t('blockTree.setDueDateFailed'))
  }
}

async function handleRepeatUntilMode(ctx: DatePickContext): Promise<void> {
  if (!ctx.blockId) return
  try {
    const resp = unwrap(
      await commands.setProperty(ctx.blockId, 'repeat-until', {
        value_text: null,
        value_num: null,
        value_date: ctx.dateStr,
        value_ref: null,
        value_bool: null,
      }),
    )
    notifyUndo(ctx.rootParentId, resp.op_refs)
    notify.success(ctx.t('blockTree.repeatUntilMessage', { date: ctx.dateStr }))
  } catch {
    notify.error(ctx.t('blockTree.setRepeatEndDateFailed'))
  }
}

async function handleScheduleMode(ctx: DatePickContext): Promise<void> {
  if (!ctx.blockId) return
  const blockId = ctx.blockId
  try {
    unwrap(await commands.setScheduledDate(blockId, ctx.dateStr))
    notifyUndo(ctx.rootParentId)
    ctx.pageStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, scheduled_date: ctx.dateStr } : b)),
    }))
    announce(ctx.t('announce.scheduledDateSet', { date: ctx.dateStr }))
  } catch {
    notify.error(ctx.t('blockTree.setScheduledDateFailed'))
  }
}

/**
 * Find or create a dedicated "date page" and insert a link to it at the
 * current editor cursor position.
 *
 * #752 — owns its own error path like the other mode handlers: nothing up
 * the chain catches (`handleDatePick`'s promise is dropped by BlockTree's
 * `onSelect`), so a rejection here used to surface as an unhandled promise
 * rejection with the picker silently closed and no feedback.
 */
async function handleDateMode(ctx: DatePickContext): Promise<void> {
  try {
    // / H-3b — date pages must own a `space` property to surface
    // in PageBrowser. The legacy `createBlock({ blockType: 'page' })`
    // path leaks pages without `space`, so route through the atomic
    // `createPageInSpace` helper using the active space from the store.
    const currentSpaceId = useSpaceStore.getState().currentSpaceId
    if (currentSpaceId === null || currentSpaceId === undefined) {
      throw new Error('No active space; cannot create date page')
    }
    // limit-clamp-followup — `listAllPagesInSpace` returns every page in
    // the active space (no pagination, no silent clamp), so journal /
    // date pages past index 99 are no longer truncated.  The
    // `currentSpaceId` null-check above guarantees a real spaceId, so no
    // pre-bootstrap fallback is needed here.
    const pages = unwrap(
      await commands.listAllPagesInSpace(requireActiveScope(currentSpaceId), null),
    )
    const existing = pages.find((p) => p.content === ctx.dateStr || p.content === ctx.legacyStr)
    let datePageId = existing?.id
    if (!datePageId) {
      const newPageId = unwrap(await commands.createPageInSpace(null, ctx.dateStr, currentSpaceId))
      datePageId = newPageId
      useResolveStore.getState().set(newPageId, ctx.dateStr, false)
      // #4319 — the third page-creation site, now routed through the same
      // `recordCreatedRow` pair as `onCreatePage` / `onCreateTag` instead of
      // appending to `pagesListRef` by hand. See `registerCreatedPage`.
      ctx.registerCreatedPage({ id: newPageId, title: ctx.dateStr })
    }

    if (ctx.rovingEditor.editor && datePageId) {
      const editor = ctx.rovingEditor.editor
      const id = datePageId
      editor.commands.focus()
      requestAnimationFrame(() => {
        editor.chain().focus().insertBlockLink(id).run()
      })
    }
  } catch (err) {
    logger.error(
      'useBlockDatePicker',
      'Failed to insert date link',
      { blockId: ctx.blockId ?? '' },
      err,
    )
    notify.error(ctx.t('blockTree.insertDateLinkFailed'))
  }
}

const MODE_HANDLERS: Record<DatePickerMode, DatePickHandler> = {
  date: handleDateMode,
  due: handleDueMode,
  schedule: handleScheduleMode,
  'repeat-until': handleRepeatUntilMode,
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBlockDatePicker({
  focusedBlockId,
  rootParentId,
  pageStore,
  rovingEditor,
  registerCreatedPage,
  t,
}: UseBlockDatePickerParams): UseBlockDatePickerReturn {
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [datePickerMode, setDatePickerMode] = useState<DatePickerMode>('date')
  const datePickerCursorPos = useRef<number | undefined>(undefined)

  // Invariant — `rovingEditor` is stable across the lifetime
  // of the BlockTree mount (the hook only ever runs inside a BlockTree
  // where the editor handle is created once and kept). Mirroring it
  // into a ref so `handleDatePick` reads the latest object without
  // listing it as a dependency is safe under that invariant. If a
  // future caller mounts this hook outside BlockTree (or recreates
  // the editor mid-mount), this assumption breaks.
  const rovingEditorRef = useRef(rovingEditor)

  const tRef = useRef(t)

  useLayoutEffect(() => {
    rovingEditorRef.current = rovingEditor
    tRef.current = t
  })

  // `t` is read via `tRef` (invariant above) so it is intentionally not listed. `pageStore` (a Zustand StoreApi) and `registerCreatedPage` (a `useCallback` with an empty dep list, #4319) are stable across renders, so listing them is safe and adds no extra runs — `handleDatePick` is only consumed as an event handler (BlockTree onSelect), never as another hook's dependency.
  const handleDatePick = useCallback(
    async (d: Date) => {
      setDatePickerOpen(false)
      const ctx: DatePickContext = {
        blockId: focusedBlockId,
        rootParentId,
        pageStore,
        rovingEditor: rovingEditorRef.current,
        registerCreatedPage,
        t: tRef.current,
        dateStr: formatIsoDate(d),
        legacyStr: formatLegacyDate(d),
      }
      await MODE_HANDLERS[datePickerMode](ctx)
    },
    [datePickerMode, focusedBlockId, rootParentId, pageStore, registerCreatedPage],
  )

  return {
    datePickerOpen,
    datePickerMode,
    datePickerCursorPos,
    setDatePickerOpen,
    setDatePickerMode,
    handleDatePick,
  }
}
