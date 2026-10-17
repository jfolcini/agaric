/**
 * usePageMode — whether `PageEditor` shows a page in page mode (#5691), and
 * its Blocks | Page switch. Pages open as the device's *Edit pages as* setting
 * says (`PREFERENCES.editMode`); the switch changes the mode of the page on
 * screen only. Desktop only. A page holding what page mode cannot show yet
 * (`page-mode-fit.ts`) stays in block mode, the switch saying why: at once for
 * what the page store's rows show, else once page mode's own check finds it
 * (its block properties and attachments), which the switch runs when pointed
 * at. No TipTap here: `PageEditor` imports this statically, and the editor
 * loads through `PageModeSlot`'s dynamic import.
 */

import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'

import {
  blockerIn,
  blockerMessage,
  type PageModeBlocker,
  pageModeBlocker,
} from '@/editor/page-mode/page-mode-fit'
import type { PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { useIsTouch } from '@/hooks/useIsTouch'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
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
  /** Look for what keeps the page out of page mode before it is chosen. */
  checkFit: () => void
  /** Run `then` once page mode's unsaved text is saved; at once outside page mode. */
  afterFlush: (then: () => void) => void
}

type ForPage<T> = { pageId: string } & T

export function usePageMode(pageId: string): PageModeState {
  const available = !useIsTouch()
  const [setting] = usePreference(PREFERENCES.editMode)
  const [chosen, setChosen] = useState<ForPage<{ mode: EditMode }> | null>(null)
  const mode = chosen?.pageId === pageId ? chosen.mode : setting
  const blocks = usePageBlockStore((s) => s.blocks)
  const total = usePageBlockStore((s) => s.truncatedTotal)
  const inRows = useMemo(() => blockerIn(blocks, total ?? blocks.length), [blocks, total])
  const [found, setFound] = useState<ForPage<{ blocker: PageModeBlocker }> | null>(null)
  const blocker = inRows ?? (found?.pageId === pageId ? found.blocker : null)
  const [cursor, setCursor] = useState<ForPage<{ blockId: string }> | null>(null)
  const editorRef = useRef<PageModeEditorHandle>(null)
  const switching = useRef(false)
  const pageStore = usePageBlockStoreApi()
  const setFocused = useBlockStore((s) => s.setFocused)

  const afterFlush = useCallback((then: () => void) => {
    const editor = editorRef.current
    if (editor === null) then()
    else void editor.flush().then(then)
  }, [])

  const onBlocked = useCallback(
    (next: PageModeBlocker) => {
      const open = editorRef.current !== null
      // Said where page mode was open, or asked for on this page: the switch, the shortcut.
      if (open) notify.info(t('pageMode.switchedToBlocks', { reason: blockerMessage(next) }))
      else if (chosen?.pageId === pageId && chosen.mode === 'page')
        notify.info(blockerMessage(next))
      // Page mode's text first, then the store the block tree reads, fresh after it.
      afterFlush(() => {
        const settle = () => setFound({ pageId, blocker: next })
        if (open) void pageStore.getState().load().finally(settle)
        else settle()
      })
    },
    [afterFlush, chosen, pageId, pageStore],
  )

  const checkFit = useCallback(() => {
    if (inRows !== null) return
    const { blocks: rows, truncatedTotal } = pageStore.getState()
    // Whatever was found before is looked for again: a property may be gone.
    pageModeBlocker(rows, truncatedTotal ?? rows.length).then(
      (next) => setFound(next === null ? null : { pageId, blocker: next }),
      (err: unknown) => {
        logger.warn('usePageMode', 'Failed to check the page for page mode', { pageId }, err)
      },
    )
  }, [inRows, pageId, pageStore])

  const changeMode = useCallback(
    (next: EditMode) => {
      if (next === 'page') {
        if (inRows !== null) {
          notify.info(blockerMessage(inRows))
          return
        }
        // Opening looks again at what was found before, and says if it still holds.
        setFound(null)
        // As for source mode: the block being edited commits as it loses focus.
        const focused = useBlockStore.getState().focusedBlockId
        setCursor(focused === null ? null : { pageId, blockId: focused })
        setFocused(null)
        setChosen({ pageId, mode: 'page' })
        return
      }
      if (switching.current) return
      switching.current = true
      const at = editorRef.current?.cursorBlockId() ?? null
      // Page mode's text first, then the store the block tree reads, fresh after it.
      afterFlush(() => {
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
    [afterFlush, inRows, pageId, pageStore, setFocused],
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
    checkFit,
    afterFlush,
  }
}
