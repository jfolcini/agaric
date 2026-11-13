/**
 * usePageBrowserKeyboard — document-level keyboard handling for the
 * Pages view.
 *
 * Two listeners, both skipping events that originate inside a typing
 * surface (INPUT / SELECT / TEXTAREA):
 *
 *  - List navigation: delegates to `useListKeyboardNavigation`'s handler
 *    (arrows / Home / End / PageUp / PageDown, and Enter / Space to open the
 *    cursor's page), calling `preventDefault` when the handler reports it
 *    consumed the key.
 * Batch selection (#81 / mirroring `useTrashListShortcuts`):
 *    Cmd/Ctrl+A selects every visible page, Escape clears the selection.
 *    Escape is gated on a non-empty selection so it doesn't swallow the
 *    key for other consumers (e.g. closing the create form) when nothing
 *    is selected.
 */

import { type RefObject, useEffect } from 'react'

interface UsePageBrowserKeyboardParams {
  /** Returns `true` when the navigation handler consumed the key. */
  navHandleKeyDown: (e: KeyboardEvent) => boolean
  /** The list container: Enter and Space open the cursor's page only from it or from <body>. */
  listRef: RefObject<HTMLElement | null>
  selectAllPages: () => void
  clearMultiSelection: () => void
  multiSelectedSize: number
}

export function usePageBrowserKeyboard({
  navHandleKeyDown,
  listRef,
  selectAllPages,
  clearMultiSelection,
  multiSelectedSize,
}: UsePageBrowserKeyboardParams): void {
  // Document-level keydown: skip if user is typing in input/select/textarea
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return
      // Enter and Space press the focused control: a row's title, star or
      // checkbox, a header button, a dialog's Cancel. Only a press on the list
      // itself, or with nothing focused, opens the cursor's page.
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        target !== listRef.current &&
        target !== document.body
      )
        return
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown, listRef])

  // #81 / document-level batch-selection shortcuts, mirroring
  // the `useTrashListShortcuts` precedent: Cmd/Ctrl+A selects every
  // visible page, Escape clears the selection. Gated on a non-empty
  // selection for Escape so it doesn't swallow the key for other consumers
  // (e.g. closing the create form) when nothing is selected.
  useEffect(() => {
    function handleSelectionKeys(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        selectAllPages()
        return
      }
      if (e.key === 'Escape' && multiSelectedSize > 0) {
        e.preventDefault()
        clearMultiSelection()
      }
    }
    document.addEventListener('keydown', handleSelectionKeys)
    return () => document.removeEventListener('keydown', handleSelectionKeys)
  }, [selectAllPages, clearMultiSelection, multiSelectedSize])
}
