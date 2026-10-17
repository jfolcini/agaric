/**
 * usePageMode — whether `PageEditor` shows a page in page mode (#5691), and its
 * Blocks | Page switch. The choice is per device (`PREFERENCES.editMode`) and
 * desktop only; `PageModeEditor` refuses a page over its block cap, which then
 * stays in block mode with a notice. No TipTap here: `PageEditor` imports this
 * statically, and the editor loads through `PageModeSlot`'s dynamic import.
 */

import type React from 'react'
import { useCallback, useRef, useState } from 'react'

import type { PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { useIsTouch } from '@/hooks/useIsTouch'
import { type EditMode, PREFERENCES, usePreference } from '@/lib/preferences'
import { useBlockStore } from '@/stores/blocks'
import { usePageBlockStoreApi } from '@/stores/page-blocks'

export interface PageModeState {
  /** Page mode can be offered here: a desktop pointer. */
  available: boolean
  /** Page mode is chosen and the page was not found over the cap. */
  wanted: boolean
  /** The page's block count and the cap, once page mode found the page over it. */
  overCap: { count: number; cap: number } | null
  editorRef: React.RefObject<PageModeEditorHandle | null>
  onOverCap: (count: number, cap: number) => void
  changeMode: (mode: EditMode) => void
  /** Run `then` once page mode's unsaved text is saved; at once outside page mode. */
  afterFlush: (then: () => void) => void
}

export function usePageMode(pageId: string): PageModeState {
  const available = !useIsTouch()
  const [editMode, setEditMode] = usePreference(PREFERENCES.editMode)
  const [overCap, setOverCap] = useState<{ pageId: string; count: number; cap: number } | null>(
    null,
  )
  const pageOverCap = editMode === 'page' && overCap?.pageId === pageId ? overCap : null
  const editorRef = useRef<PageModeEditorHandle>(null)
  const switching = useRef(false)
  const pageStore = usePageBlockStoreApi()
  const setFocused = useBlockStore((s) => s.setFocused)

  const onOverCap = useCallback(
    (count: number, cap: number) => setOverCap({ pageId, count, cap }),
    [pageId],
  )

  const afterFlush = useCallback((then: () => void) => {
    const editor = editorRef.current
    if (editor === null) then()
    else void editor.flush().then(then)
  }, [])

  const changeMode = useCallback(
    (mode: EditMode) => {
      if (mode === 'page') {
        // As for source mode: the block being edited commits as it loses focus.
        setFocused(null)
        setOverCap(null)
        setEditMode('page')
        return
      }
      if (switching.current) return
      switching.current = true
      // Page mode's text first, then the store the block tree reads, fresh after it.
      afterFlush(() => {
        void pageStore
          .getState()
          .load()
          .finally(() => {
            switching.current = false
            setEditMode('blocks')
          })
      })
    },
    [afterFlush, pageStore, setEditMode, setFocused],
  )

  return {
    available,
    wanted: available && editMode === 'page' && pageOverCap === null,
    overCap: pageOverCap === null ? null : { count: pageOverCap.count, cap: pageOverCap.cap },
    editorRef,
    onOverCap,
    changeMode,
    afterFlush,
  }
}
