import { useEffect, useRef } from 'react'
import { formatDate } from '../lib/date-utils'
import { getShortcutKeys } from '../lib/keyboard-config'
import { getJournalPageByDate } from '../lib/tauri'

interface UseJournalAutoCreateOptions {
  loading: boolean
  mode: string
  currentDate: Date
  /** Active space ULID — used to look up an existing page for `currentDate`. */
  spaceId: string
  /** Pages this React tree just created (not yet visible to the backend index). */
  createdPages: Map<string, string>
  handleAddBlock: (dateStr: string) => void
}

export function useJournalAutoCreate({
  loading,
  mode,
  currentDate,
  spaceId,
  createdPages,
  handleAddBlock,
}: UseJournalAutoCreateOptions): void {
  const autoCreatedRef = useRef<string | null>(null)

  // Auto-create the displayed day's page on mount / date change in daily mode.
  // BUG-48: the page-existence probe is now an indexed DB lookup
  // (`get_journal_page_by_date`) instead of a scan of a paginated
  // listBlocks response, so this no longer drops dates that fall past
  // the page-fetch limit.
  useEffect(() => {
    if (loading) return
    if (mode !== 'daily') return
    const dateStr = formatDate(currentDate)
    if (autoCreatedRef.current === dateStr) return
    if (createdPages.has(dateStr)) return
    let cancelled = false
    getJournalPageByDate({ date: dateStr, spaceId })
      .then((page) => {
        if (cancelled) return
        if (page != null) return
        if (autoCreatedRef.current === dateStr) return
        autoCreatedRef.current = dateStr
        handleAddBlock(dateStr)
      })
      .catch(() => {
        // Probe failure leaves the page un-auto-created for this render.
        // The user can still add a block manually, and the next date
        // change re-runs the effect.
      })
    return () => {
      cancelled = true
    }
  }, [loading, mode, currentDate, spaceId, createdPages, handleAddBlock])

  // Keyboard shortcut for new block in daily mode.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'daily') return
      const dateStr = formatDate(currentDate)
      if (createdPages.has(dateStr)) return
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
        return
      const createKeys = getShortcutKeys('createJournalBlock')
        .split('/')
        .map((k) => k.trim().toLowerCase())
      if (!createKeys.includes(e.key.toLowerCase())) return
      e.preventDefault()
      // BUG-48: per-keypress probe replaces the in-memory `pageMap.has`
      // gate. Skips creation when a page already exists for `dateStr`,
      // matching the pre-BUG-48 short-circuit semantics.
      getJournalPageByDate({ date: dateStr, spaceId })
        .then((page) => {
          if (page != null) return
          handleAddBlock(dateStr)
        })
        .catch(() => {
          // Probe failure leaves the shortcut as a no-op for this press.
        })
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mode, currentDate, spaceId, createdPages, handleAddBlock])
}
