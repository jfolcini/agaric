/**
 * usePageBrowserKeyboard — document-level keyboard handling for the
 * Pages view.
 *
 * Two listeners, both skipping events that originate inside a typing
 * surface (INPUT / SELECT / TEXTAREA):
 *
 *  - List navigation: delegates to `useListKeyboardNavigation`'s handler
 *    (arrows / Home / End / PageUp / PageDown), calling `preventDefault`
 *    when the handler reports it consumed the key.
 *  - Batch selection (#81 / PEND-57, mirroring `useTrashListShortcuts`):
 *    Cmd/Ctrl+A selects every visible page, Escape clears the selection.
 *    Escape is gated on a non-empty selection so it doesn't swallow the
 *    key for other consumers (e.g. closing the create form) when nothing
 *    is selected.
 *
 * Extracted verbatim from `PageBrowser.tsx` (#1263). Pure move — same
 * effects, same deps, same listener semantics.
 */

import { useEffect } from 'react'

interface UsePageBrowserKeyboardParams {
  /** Returns `true` when the navigation handler consumed the key. */
  navHandleKeyDown: (e: KeyboardEvent) => boolean
  selectAllPages: () => void
  clearMultiSelection: () => void
  multiSelectedSize: number
}

export function usePageBrowserKeyboard({
  navHandleKeyDown,
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
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown])

  // #81 / PEND-57 — document-level batch-selection shortcuts, mirroring
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
