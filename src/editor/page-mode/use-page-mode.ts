/**
 * usePageMode — whether `PageEditor`, or the journal's `DayPageEditor`, shows a
 * page in page mode (#5691), and its Blocks | Page switch (on a phone, the page
 * header's or the day's *Page actions* item). Pages open as the device's *Edit pages as* setting
 * says (`PREFERENCES.editMode`); the switch changes the mode of the page on
 * screen only. A page over page mode's cap (`page-mode-fit.ts`)
 * stays in block mode, the switch saying why, as the page store's rows show
 * it. A switch keeps the caret and the place the page is scrolled to
 * (`page-mode-switch.ts`). No TipTap here: `PageEditor` imports this
 * statically, and the editor loads through `PageModeSlot`'s dynamic import.
 */

import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { getActiveEditor } from '@/editor/active-editor'
import { blockerIn, blockerMessage, type PageModeBlocker } from '@/editor/page-mode/page-mode-fit'
import {
  type BlockCaret,
  type PageModeOpening,
  restoreScrollPlace,
  type ScrollPlace,
  scrollPlace,
} from '@/editor/page-mode/page-mode-switch'
import type { PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { t } from '@/lib/i18n'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { notify } from '@/lib/notify'
import { TOGGLE_PAGE_MODE_EVENT } from '@/lib/overlay-events'
import { type EditMode, PREFERENCES, usePreference } from '@/lib/preferences'
import { useBlockStore } from '@/stores/blocks'
import { usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'

export interface PageModeState {
  /** Page mode is chosen for this page and nothing keeps the page out of it. */
  wanted: boolean
  /** The mode the switch shows. */
  mode: EditMode
  /** Why page mode is not offered for this page, once known. */
  blocked: string | null
  editorRef: React.RefObject<PageModeEditorHandle | null>
  /** Where page mode opens: on block mode's caret, and scrolled as block mode was. */
  opening: PageModeOpening | null
  onBlocked: (blocker: PageModeBlocker) => void
  changeMode: (mode: EditMode) => void
  /**
   * Run `then` once page mode's text is saved and the page store read again, page mode set to
   * open again where the page is now: at once outside it, never if the save failed.
   */
  afterFlush: (then: () => void) => void
}

type ForPage<T> = { pageId: string } & T

/** Block mode's caret in block `id`, which it is editing; none when its editor is elsewhere. */
function blockModeCaret(id: string): BlockCaret | null {
  const editor = getActiveEditor()
  const host = editor?.view.dom.closest('[data-block-id]')?.getAttribute('data-block-id')
  return editor == null || host !== id ? null : { blockId: id, pos: editor.state.selection.head }
}

/** Once block mode's editor takes the focus in `caret`'s block, put its caret there. */
function placeOnFocus(caret: BlockCaret): void {
  const onFocusIn = (event: FocusEvent): void => {
    document.removeEventListener('focusin', onFocusIn)
    const editor = getActiveEditor()
    if (editor?.view.dom === event.target && blockModeCaret(caret.blockId) !== null) {
      editor.commands.setTextSelection(caret.pos)
    }
  }
  document.addEventListener('focusin', onFocusIn)
}

export function usePageMode(pageId: string): PageModeState {
  const [setting] = usePreference(PREFERENCES.editMode)
  const [chosen, setChosen] = useState<ForPage<{ mode: EditMode }> | null>(null)
  const mode = chosen?.pageId === pageId ? chosen.mode : setting
  const blockCount = usePageBlockStore((s) => s.blocks.length)
  const total = usePageBlockStore((s) => s.truncatedTotal)
  const blocker = useMemo(() => blockerIn(total ?? blockCount), [blockCount, total])
  const [opening, setOpening] = useState<ForPage<PageModeOpening> | null>(null)
  // A page shown again opens as any page does, not where a switch on it once opened.
  if (opening !== null && opening.pageId !== pageId) setOpening(null)
  // Where block mode is to show the page scrolled to, and whether its tree has read the page yet.
  const placeInBlocks = useRef<{ place: ScrollPlace; read: boolean } | null>(null)
  const loading = usePageBlockStore((s) => s.loading)
  const editorRef = useRef<PageModeEditorHandle>(null)
  const switching = useRef(false)
  const pageStore = usePageBlockStoreApi()
  const setFocused = useBlockStore((s) => s.setFocused)

  /** Open page mode on block mode's caret and place, the block committing as it loses focus. */
  const takeCursor = useCallback(() => {
    const focused = useBlockStore.getState().focusedBlockId
    setOpening({
      pageId,
      cursor: focused === null ? null : (blockModeCaret(focused) ?? { blockId: focused, pos: 0 }),
      place: scrollPlace(),
    })
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
    if (returned && mode === 'page') takeCursor()
  }, [blocker, mode, takeCursor])

  /** Whether page mode's text is saved, once its save has run; true outside page mode. */
  const saved = useCallback(
    (): Promise<boolean> => editorRef.current?.flush() ?? Promise.resolve(true),
    [],
  )

  // A failed save keeps page mode open (its toast says so), not showing the page without the text.
  // Page mode opens again on the store, which its own saves do not refresh, and where the page is
  // now, not where it first opened.
  const afterFlush = useCallback(
    (then: () => void) => {
      if (editorRef.current === null) then()
      else
        void saved().then((ok) => {
          if (!ok) return
          void pageStore
            .getState()
            .load()
            .finally(() => {
              takeCursor()
              then()
            })
        })
    },
    [saved, pageStore, takeCursor],
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
        // Read now, not from this render: Edit as Markdown calls this after a load its save grew.
        const { blocks, truncatedTotal } = pageStore.getState()
        const now = blockerIn(truncatedTotal ?? blocks.length)
        if (now !== null) {
          notify.info(blockerMessage(now))
          return
        }
        takeCursor()
        setChosen({ pageId, mode: 'page' })
        return
      }
      if (switching.current) return
      switching.current = true
      const at = editorRef.current?.cursor() ?? null
      const place = scrollPlace()
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
            if (place !== null) placeInBlocks.current = { place, read: false }
            setChosen({ pageId, mode: 'blocks' })
            if (at === null) return
            placeOnFocus(at)
            setFocused(at.blockId)
          })
      })
    },
    [saved, pageId, pageStore, setFocused, takeCursor],
  )

  const wanted = mode === 'page' && blocker === null
  // Block mode's tree reads the page as it mounts, a skeleton showing meanwhile: the place goes
  // back once it shows the blocks it read.
  useLayoutEffect(() => {
    const pending = placeInBlocks.current
    if (wanted || pending === null) return
    if (loading) pending.read = true
    else if (pending.read) {
      placeInBlocks.current = null
      restoreScrollPlace(pending.place)
    }
  }, [wanted, loading])

  return {
    wanted,
    mode: blocker === null ? mode : 'blocks',
    blocked: blocker === null ? null : blockerMessage(blocker),
    editorRef,
    opening,
    onBlocked,
    changeMode,
    afterFlush,
  }
}

/**
 * The `togglePageMode` shortcut and the palette's command flip `mode`, a blocked Page included, so
 * `onChange` can say why. The page mounts it, not its switch, which a phone shows in a menu.
 */
export function useEditModeShortcut(
  mode: EditMode,
  onChange: ((mode: EditMode) => void) | undefined,
): void {
  useEffect(() => {
    if (onChange === undefined) return
    const toggle = (): void => onChange(mode === 'page' ? 'blocks' : 'page')
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!matchesShortcutBinding(e, 'togglePageMode')) return
      e.preventDefault()
      toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener(TOGGLE_PAGE_MODE_EVENT, toggle)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(TOGGLE_PAGE_MODE_EVENT, toggle)
    }
  }, [mode, onChange])
}
