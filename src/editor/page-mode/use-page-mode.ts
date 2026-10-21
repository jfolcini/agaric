/**
 * usePageMode — whether `PageEditor` shows a page in page mode (#5691), and
 * its Blocks | Page switch. Pages open as the device's *Edit pages as* setting
 * says (`PREFERENCES.editMode`); the switch changes the mode of the page on
 * screen only. Desktop only. A page over page mode's cap (`page-mode-fit.ts`)
 * stays in block mode, the switch saying why, as the page store's rows show
 * it. No TipTap here: `PageEditor` imports this statically, and the editor
 * loads through `PageModeSlot`'s dynamic import.
 */

import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getActiveEditor } from '@/editor/active-editor'
import { blockerIn, blockerMessage, type PageModeBlocker } from '@/editor/page-mode/page-mode-fit'
import type { PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { useIsTouch } from '@/hooks/useIsTouch'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { type EditMode, PREFERENCES, usePreference } from '@/lib/preferences'
import { useBlockStore } from '@/stores/blocks'
import { usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'

export interface PageModeState {
  /** Page mode can be offered here: a desktop pointer. */
  available: boolean
  /** Page mode is chosen for this page and nothing keeps the page out of it. */
  wanted: boolean
  /** The mode the switch shows. */
  mode: EditMode
  /** Why page mode is not offered for this page, once known. */
  blocked: string | null
  editorRef: React.RefObject<PageModeEditorHandle | null>
  /** The block page mode opens with the cursor in: the one block mode was editing. */
  cursorBlockId: string | null
  onBlocked: (blocker: PageModeBlocker) => void
  changeMode: (mode: EditMode) => void
  /** Run `then` once page mode's text is saved: at once outside it, never if the save failed. */
  afterFlush: (then: () => void) => void
}

type ForPage<T> = { pageId: string } & T

export function usePageMode(pageId: string): PageModeState {
  const available = !useIsTouch()
  const [setting] = usePreference(PREFERENCES.editMode)
  const [chosen, setChosen] = useState<ForPage<{ mode: EditMode }> | null>(null)
  const mode = chosen?.pageId === pageId ? chosen.mode : setting
  const blockCount = usePageBlockStore((s) => s.blocks.length)
  const total = usePageBlockStore((s) => s.truncatedTotal)
  const blocker = useMemo(() => blockerIn(total ?? blockCount), [blockCount, total])
  const [cursor, setCursor] = useState<ForPage<{ blockId: string }> | null>(null)
  const editorRef = useRef<PageModeEditorHandle>(null)
  const switching = useRef(false)
  const pageStore = usePageBlockStoreApi()
  const setFocused = useBlockStore((s) => s.setFocused)

  /** Open page mode on the block block mode was editing, which commits as it loses focus. */
  const takeCursor = useCallback(() => {
    const focused = useBlockStore.getState().focusedBlockId
    setCursor(focused === null ? null : { pageId, blockId: focused })
    // The shortcut leaves the block focused: its blur commits it to the store page mode opens on.
    getActiveEditor()?.view.dom.blur()
    setFocused(null)
  }, [pageId, setFocused])

  // Page mode back by itself, the page fitting again (blocks deleted in block mode): that opening
  // takes the cursor too, or it opens on the block the switch last named, perhaps gone.
  const wasBlocked = useRef(blocker !== null)
  useEffect(() => {
    const returned = wasBlocked.current && blocker === null
    wasBlocked.current = blocker !== null
    if (returned && available && mode === 'page') takeCursor()
  }, [available, blocker, mode, takeCursor])

  /** Whether page mode's text is saved, once its save has run; true outside page mode. */
  const saved = useCallback(
    (): Promise<boolean> => editorRef.current?.flush() ?? Promise.resolve(true),
    [],
  )

  // A failed save keeps page mode open (its toast says so), not showing the page without the text.
  const afterFlush = useCallback(
    (then: () => void) => {
      if (editorRef.current === null) then()
      else
        void saved().then((ok) => {
          if (ok) then()
        })
    },
    [saved],
  )

  const onBlocked = useCallback(
    (next: PageModeBlocker) => {
      // Said where page mode was open, or asked for on this page: the switch, the shortcut.
      if (editorRef.current !== null) {
        notify.info(t('pageMode.switchedToBlocks', { reason: blockerMessage(next) }))
        // Page mode's text first, then the store the block tree reads, fresh after it.
        void saved().then(() => pageStore.getState().load())
      } else if (chosen?.pageId === pageId && chosen.mode === 'page') {
        notify.info(blockerMessage(next))
      }
    },
    [saved, chosen, pageId, pageStore],
  )

  const changeMode = useCallback(
    (next: EditMode) => {
      if (next === 'page') {
        if (blocker !== null) {
          notify.info(blockerMessage(blocker))
          return
        }
        takeCursor()
        setChosen({ pageId, mode: 'page' })
        return
      }
      if (switching.current) return
      switching.current = true
      const at = editorRef.current?.cursorBlockId() ?? null
      // Page mode's text first, then the store the block tree reads, fresh after it.
      void saved().then((ok) => {
        if (!ok) {
          switching.current = false
          return
        }
        void pageStore
          .getState()
          .load()
          .finally(() => {
            switching.current = false
            setChosen({ pageId, mode: 'blocks' })
            if (at !== null) setFocused(at)
          })
      })
    },
    [saved, blocker, pageId, pageStore, setFocused, takeCursor],
  )

  return {
    available,
    wanted: available && mode === 'page' && blocker === null,
    mode: available && blocker === null ? mode : 'blocks',
    blocked: blocker === null ? null : blockerMessage(blocker),
    editorRef,
    cursorBlockId: cursor?.pageId === pageId ? cursor.blockId : null,
    onBlocked,
    changeMode,
    afterFlush,
  }
}
