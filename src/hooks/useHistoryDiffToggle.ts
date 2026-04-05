import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import type { DiffSpan, HistoryEntry } from '../lib/tauri'
import { computeEditDiff } from '../lib/tauri'

export function useHistoryDiffToggle<K>(keyFn: (entry: HistoryEntry) => K): {
  expandedKeys: Set<K>
  diffCache: Map<K, DiffSpan[]>
  loadingDiffs: Set<K>
  handleToggleDiff: (entry: HistoryEntry) => Promise<void>
} {
  const [expandedKeys, setExpandedKeys] = useState<Set<K>>(new Set())
  const [diffCache, setDiffCache] = useState<Map<K, DiffSpan[]>>(new Map())
  const [loadingDiffs, setLoadingDiffs] = useState<Set<K>>(new Set())

  const handleToggleDiff = useCallback(
    async (entry: HistoryEntry) => {
      const key = keyFn(entry)
      if (expandedKeys.has(key)) {
        setExpandedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        return
      }
      setExpandedKeys((prev) => new Set(prev).add(key))
      if (diffCache.has(key)) return
      setLoadingDiffs((prev) => new Set(prev).add(key))
      try {
        const diff = await computeEditDiff({ deviceId: entry.device_id, seq: entry.seq })
        if (diff) {
          setDiffCache((prev) => new Map(prev).set(key, diff))
        }
      } catch {
        toast.error(i18n.t('history.loadDiffFailed'))
        setExpandedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      } finally {
        setLoadingDiffs((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [expandedKeys, diffCache, keyFn],
  )

  return { expandedKeys, diffCache, loadingDiffs, handleToggleDiff }
}
