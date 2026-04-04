import { useEffect, useRef } from 'react'

import { deleteDraft, flushDraft, saveDraft } from '@/lib/tauri'

/**
 * Autosave hook for block draft content.
 *
 * Debounces `saveDraft` calls with a 2-second interval while the user is
 * typing. On blur / unmount the pending draft is flushed (written as an
 * `edit_block` op and removed from the drafts table).
 *
 * Call `discardDraft()` after a successful normal save to remove the draft
 * row without flushing it as an op.
 */
export function useDraftAutosave(blockId: string | null, content: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blockIdRef = useRef(blockId)
  blockIdRef.current = blockId

  useEffect(() => {
    if (!blockId || !content) return

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(() => {
      saveDraft(blockId, content).catch(() => {})
    }, 2000)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (blockIdRef.current) {
        flushDraft(blockIdRef.current).catch(() => {})
      }
    }
  }, [blockId, content])

  /** Call after a successful normal save to discard the draft without flushing. */
  const discardDraft = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (blockIdRef.current) {
      deleteDraft(blockIdRef.current).catch(() => {})
    }
  }

  return { discardDraft }
}
