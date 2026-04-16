import type { MutableRefObject } from 'react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { announce } from '../lib/announcer'
import {
  createBlock,
  listBlocks,
  setDueDate as setDueDateCmd,
  setProperty,
  setScheduledDate as setScheduledDateCmd,
} from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'

export type DatePickerMode = 'date' | 'due' | 'schedule' | 'repeat-until'

export interface UseBlockDatePickerParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor'>
  pagesListRef: MutableRefObject<Array<{ id: string; title: string }>>
  // biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
  t: (...args: any[]) => any
}

export interface UseBlockDatePickerReturn {
  datePickerOpen: boolean
  datePickerMode: DatePickerMode
  datePickerCursorPos: MutableRefObject<number | undefined>
  setDatePickerOpen: (open: boolean) => void
  setDatePickerMode: (mode: DatePickerMode) => void
  handleDatePick: (d: Date) => Promise<void>
}

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

  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  const tRef = useRef(t)
  tRef.current = t

  // biome-ignore lint/correctness/useExhaustiveDependencies: pagesListRef is a stable ref; pageStore is a stable StoreApi; t accessed via ref
  const handleDatePick = useCallback(
    async (d: Date) => {
      const t = tRef.current
      setDatePickerOpen(false)
      const dd = String(d.getDate()).padStart(2, '0')
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const yyyy = d.getFullYear()
      const dateStr = `${yyyy}-${mm}-${dd}`

      if (datePickerMode === 'due') {
        if (!focusedBlockId) return
        try {
          await setDueDateCmd(focusedBlockId, dateStr)
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, due_date: dateStr } : b,
            ),
          }))
        } catch {
          toast.error(t('blockTree.setDueDateFailed'))
        }
        return
      }

      if (datePickerMode === 'repeat-until') {
        if (!focusedBlockId) return
        try {
          await setProperty({
            blockId: focusedBlockId,
            key: 'repeat-until',
            valueDate: dateStr,
          })
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          toast.success(t('blockTree.repeatUntilMessage', { date: dateStr }))
        } catch {
          toast.error(t('blockTree.setRepeatEndDateFailed'))
        }
        return
      }

      if (datePickerMode === 'schedule') {
        if (!focusedBlockId) return
        try {
          await setScheduledDateCmd(focusedBlockId, dateStr)
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, scheduled_date: dateStr } : b,
            ),
          }))
          announce(t('announce.scheduledDateSet', { date: dateStr }))
        } catch {
          toast.error(t('blockTree.setScheduledDateFailed'))
        }
        return
      }

      const legacyStr = `${dd}/${mm}/${yyyy}`

      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      let datePageId = resp.items.find((b) => b.content === dateStr || b.content === legacyStr)?.id
      if (!datePageId) {
        const newPage = await createBlock({
          blockType: 'page',
          content: dateStr,
        })
        datePageId = newPage.id
        useResolveStore.getState().set(newPage.id, dateStr, false)
        pagesListRef.current = [...pagesListRef.current, { id: newPage.id, title: dateStr }]
      }

      if (rovingEditorRef.current.editor && datePageId) {
        const editor = rovingEditorRef.current.editor
        const id = datePageId
        editor.commands.focus()
        requestAnimationFrame(() => {
          editor.chain().focus().insertBlockLink(id).run()
        })
      }
    },
    [datePickerMode, focusedBlockId, rootParentId],
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
