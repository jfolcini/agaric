import { useCallback, useRef, useState } from 'react'

import { notify } from '@/lib/notify'

import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
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

  // Mirror state into refs so handleToggleDiff can read latest values
  // without listing them as deps (which would churn the callback identity on
  // every toggle). Functional setState forms below remain the source of truth
  // for writes.
  const expandedKeysRef = useRef(expandedKeys)
  expandedKeysRef.current = expandedKeys
  const diffCacheRef = useRef(diffCache)
  diffCacheRef.current = diffCache
  // Mirror keyFn into a ref too: callers pass a freshly-allocated inline arrow
  // every render, so depending on keyFn identity would churn handleToggleDiff
  // each render and defeat downstream memoization. The ref always holds the
  // latest keyFn while keeping the callback identity stable.
  const keyFnRef = useRef(keyFn)
  keyFnRef.current = keyFn

  const handleToggleDiff = useCallback(async (entry: HistoryEntry) => {
    const key = keyFnRef.current(entry)
    if (expandedKeysRef.current.has(key)) {
      setExpandedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      return
    }
    setExpandedKeys((prev) => new Set(prev).add(key))
    if (diffCacheRef.current.has(key)) return
    setLoadingDiffs((prev) => new Set(prev).add(key))
    try {
      const diff = await computeEditDiff({ deviceId: entry.device_id, seq: entry.seq })
      if (diff) {
        setDiffCache((prev) => new Map(prev).set(key, diff))
      }
    } catch (err) {
      logger.warn('useHistoryDiffToggle', 'computeEditDiff failed', undefined, err)
      notify.error(i18n.t('history.loadDiffFailed'), { id: 'history-load-diff-failed' })
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
  }, [])

  return { expandedKeys, diffCache, loadingDiffs, handleToggleDiff }
}
