/**
 * Keep a focused block in view: the block once the editor has laid it out (a
 * block reached by arrow keys or created by Enter below the fold), and its
 * caret whenever the window resizes under it.
 *
 * On Android the on-screen keyboard opening is such a resize: it shrinks the
 * layout viewport (`MainActivity.kt`, #6790), and Chromium leaves the focused
 * text where it was, under the keyboard (`e2e/phone-keyboard-pan.spec.ts`).
 * The editor's own scroll puts the caret above the toolbar pinned there.
 */

import { useEffect } from 'react'

import { getActiveEditor } from '@/editor/active-editor'

export function useScrollIntoViewOnFocus(
  ref: React.RefObject<HTMLElement | null>,
  focused: boolean,
): void {
  useEffect(() => {
    if (!focused) return
    const raf = requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }))
    const revealCaret = () => getActiveEditor()?.commands.scrollIntoView()
    window.addEventListener('resize', revealCaret)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', revealCaret)
    }
  }, [ref, focused])
}
