import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'

import { notify } from '@/lib/notify'

import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { announce } from '../lib/announcer'
import {
  createPageInSpace,
  listAllPagesInSpace,
  setDueDate as setDueDateCmd,
  setProperty,
  setScheduledDate as setScheduledDateCmd,
} from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { useUndoStore } from '../stores/undo'

export type DatePickerMode = 'date' | 'due' | 'schedule' | 'repeat-until'

type TFn = TFunction

export interface UseBlockDatePickerParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor'>
  pagesListRef: RefObject<Array<{ id: string; title: string }>>
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
  pagesListRef: RefObject<Array<{ id: string; title: string }>>
  t: TFn
  /** ISO date string: YYYY-MM-DD. */
  dateStr: string
  /** Legacy DD/MM/YYYY string kept for backward-compat page lookup. */
  legacyStr: string
}

type DatePickHandler = (ctx: DatePickContext) => Promise<void> | void

function notifyUndo(rootParentId: string | null): void {
  if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
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
    await setDueDateCmd(blockId, ctx.dateStr)
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
    await setProperty({
      blockId: ctx.blockId,
      key: 'repeat-until',
      valueDate: ctx.dateStr,
    })
    notifyUndo(ctx.rootParentId)
    notify.success(ctx.t('blockTree.repeatUntilMessage', { date: ctx.dateStr }))
  } catch {
    notify.error(ctx.t('blockTree.setRepeatEndDateFailed'))
  }
}

async function handleScheduleMode(ctx: DatePickContext): Promise<void> {
  if (!ctx.blockId) return
  const blockId = ctx.blockId
  try {
    await setScheduledDateCmd(blockId, ctx.dateStr)
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
 */
async function handleDateMode(ctx: DatePickContext): Promise<void> {
  // BUG-1 / H-3b — date pages must own a `space` property to surface
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
  const pages = await listAllPagesInSpace(currentSpaceId)
  const existing = pages.find((p) => p.content === ctx.dateStr || p.content === ctx.legacyStr)
  let datePageId = existing?.id
  if (!datePageId) {
    const newPageId = await createPageInSpace({
      content: ctx.dateStr,
      spaceId: currentSpaceId,
    })
    datePageId = newPageId
    useResolveStore.getState().set(newPageId, ctx.dateStr, false)
    ctx.pagesListRef.current = [...ctx.pagesListRef.current, { id: newPageId, title: ctx.dateStr }]
  }

  if (ctx.rovingEditor.editor && datePageId) {
    const editor = ctx.rovingEditor.editor
    const id = datePageId
    editor.commands.focus()
    requestAnimationFrame(() => {
      editor.chain().focus().insertBlockLink(id).run()
    })
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
  pagesListRef,
  t,
}: UseBlockDatePickerParams): UseBlockDatePickerReturn {
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [datePickerMode, setDatePickerMode] = useState<DatePickerMode>('date')
  const datePickerCursorPos = useRef<number | undefined>(undefined)

  // FE-M-7: invariant — `rovingEditor` is stable across the lifetime
  // of the BlockTree mount (the hook only ever runs inside a BlockTree
  // where the editor handle is created once and kept). Mirroring it
  // into a ref so `handleDatePick` reads the latest object without
  // listing it as a dependency is safe under that invariant. If a
  // future caller mounts this hook outside BlockTree (or recreates
  // the editor mid-mount), this assumption breaks.
  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  const tRef = useRef(t)
  tRef.current = t

  // `t` is read via `tRef` (FE-M-7 invariant above) so it is intentionally not listed. `pageStore` (a Zustand StoreApi) and `pagesListRef` (a ref object) are stable across renders, so listing them is safe and adds no extra runs — `handleDatePick` is only consumed as an event handler (BlockTree onSelect), never as another hook's dependency.
  const handleDatePick = useCallback(
    async (d: Date) => {
      setDatePickerOpen(false)
      const ctx: DatePickContext = {
        blockId: focusedBlockId,
        rootParentId,
        pageStore,
        rovingEditor: rovingEditorRef.current,
        pagesListRef,
        t: tRef.current,
        dateStr: formatIsoDate(d),
        legacyStr: formatLegacyDate(d),
      }
      await MODE_HANDLERS[datePickerMode](ctx)
    },
    [datePickerMode, focusedBlockId, rootParentId, pageStore, pagesListRef],
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
