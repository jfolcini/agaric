import { useEffect, useRef } from 'react'
import { formatDate } from '../lib/date-utils'

interface UseJournalAutoCreateOptions {
  loading: boolean
  mode: string
  currentDate: Date
  pageMap: Map<string, string>
  createdPages: Map<string, string>
  handleAddBlock: (dateStr: string) => void
}

export function useJournalAutoCreate({
  loading,
  mode,
  currentDate,
  pageMap,
  createdPages,
  handleAddBlock,
}: UseJournalAutoCreateOptions): void {
  const autoCreatedRef = useRef<string | null>(null)

  // Auto-create the displayed day's page on mount / date change in daily mode
  useEffect(() => {
    if (loading) return
    if (mode !== 'daily') return
    const dateStr = formatDate(currentDate)
    if (autoCreatedRef.current === dateStr) return
    if (createdPages.has(dateStr) || pageMap.has(dateStr)) return
    autoCreatedRef.current = dateStr
    handleAddBlock(dateStr)
  }, [loading, mode, currentDate, pageMap, createdPages, handleAddBlock])

  // Keyboard shortcut for new block in daily mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'daily') return
      const dateStr = formatDate(currentDate)
      if (createdPages.has(dateStr) || pageMap.has(dateStr)) return
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
        return
      if (e.key === 'Enter' || e.key === 'n') {
        e.preventDefault()
        handleAddBlock(dateStr)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mode, currentDate, createdPages, pageMap, handleAddBlock])
}
