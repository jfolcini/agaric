/**
 * PEND-60 Phase 2 — Resolve `AutocompleteItem[]` for the caret-anchored
 * autocomplete popover.
 *
 * Composes static value lists (state / priority / due / scheduled) with
 * dynamic sources (tag names via IPC, path-history MRU, property keys
 * cached for the session). The hook is the single source of truth for
 * "what should the popover show right now"; the orchestrator
 * (`SearchPanel`) only owns popover open-state and item-selection
 * wiring.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { useTranslation } from 'react-i18next'
import type { AutocompleteItem } from '@/components/search/AutocompletePopover'
import { useFailedOnce } from '@/hooks/useFailedOnce'
import { useGenerationGuard } from '@/hooks/useGenerationGuard'
import { isCancellation } from '@/lib/app-error'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getPathHistory } from '@/lib/path-history'
import {
  ensurePropertyKeysInvalidationListener,
  fetchPropertyKeysOnce,
  getCachedPropertyKeys,
  PROPERTY_KEYS_GLOBAL_KEY,
  subscribeToPropertyKeysCache,
} from '@/lib/property-keys-cache'
import type { AutocompleteAnchor } from '@/lib/search-query/autocomplete'
import { listTagsByPrefix, paginationLimit } from '@/lib/tauri'

const STATE_VALUES = ['TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED', 'none'] as const
const PRIORITY_VALUES = ['A', 'B', 'C', 'none'] as const
const DATE_BUCKET_VALUES = [
  'today',
  'yesterday',
  'overdue',
  'this-week',
  'this-month',
  'next-week',
  'older',
  'none',
] as const

const TAG_DEBOUNCE_MS = 150
const TAG_LIMIT = 20

export interface UseAutocompleteSourcesArgs {
  anchor: AutocompleteAnchor
  spaceId: string | null
}

export interface UseAutocompleteSourcesResult {
  items: AutocompleteItem[]
  loading: boolean
}

function projectStatic(values: readonly string[], query: string): AutocompleteItem[] {
  const lowered = query.toLowerCase()
  return values.filter((v) => v.toLowerCase().startsWith(lowered)).map((v) => ({ value: v }))
}

export function useAutocompleteSources(
  args: UseAutocompleteSourcesArgs,
): UseAutocompleteSourcesResult {
  const { anchor, spaceId } = args

  // Tag IPC state — kept separate from synchronous projections so the
  // popover can stay open with stale items while a new request flies.
  const [tagItems, setTagItems] = useState<AutocompleteItem[]>([])
  const [tagLoading, setTagLoading] = useState(false)

  // Property-key list comes from the shared MAINT-189 cache: space-keyed,
  // in-flight-dedup, invalidates on `block:properties-changed`. We
  // subscribe unconditionally (cheap — the snapshot is a stable array),
  // but only kick off the fetch when the user actually opens the
  // propKey anchor (see effect below). Other consumers may have already
  // primed the cache, in which case the popover gets results instantly.
  const spaceKey = spaceId ?? PROPERTY_KEYS_GLOBAL_KEY
  const getPropKeysSnapshot = useCallback(() => getCachedPropertyKeys(spaceKey), [spaceKey])
  const propKeys = useSyncExternalStore(subscribeToPropertyKeysCache, getPropKeysSnapshot)

  // PEND-73 Phase 4.M3 — shared race-discard hook. The guard bumps on
  // every tag-anchor activation AND on every keystroke while active;
  // stale resolutions check it before writing state. Leaving the
  // `tag` anchor entirely also bumps the guard so an in-flight
  // resolution can't strand stale items for a later return-to-tag.
  const tagGen = useGenerationGuard()
  // PEND-73 Phase 3.U1 — once-per-session failure surface.
  const surfaceFailureOnce = useFailedOnce()
  const { t } = useTranslation()
  const tagDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const active = anchor?.active ?? null
  const query = anchor?.query ?? ''

  // ── PropKey lazy fetch (one-shot per session+space) ───────────────
  useEffect(() => {
    if (active !== 'propKey') return
    ensurePropertyKeysInvalidationListener()
    void fetchPropertyKeysOnce(spaceKey)
  }, [active, spaceKey])

  // ── Tag IPC (debounced, stale-while-loading) ──────────────────────
  useEffect(() => {
    if (active !== 'tag') {
      // Bump the guard so any in-flight tag promise that resolves
      // later can't strand stale items for a future return-to-tag.
      tagGen.next()
      if (tagDebounceTimerRef.current) {
        clearTimeout(tagDebounceTimerRef.current)
        tagDebounceTimerRef.current = null
      }
      setTagLoading(false)
      return
    }

    if (tagDebounceTimerRef.current) clearTimeout(tagDebounceTimerRef.current)
    const requestId = tagGen.next()
    setTagLoading(true)
    tagDebounceTimerRef.current = setTimeout(() => {
      tagDebounceTimerRef.current = null
      listTagsByPrefix({ prefix: query, limit: paginationLimit(TAG_LIMIT) })
        .then((rows) => {
          if (!tagGen.isCurrent(requestId)) return
          setTagItems(rows.map((row) => ({ value: row.name })))
          setTagLoading(false)
        })
        .catch((err: unknown) => {
          if (!tagGen.isCurrent(requestId)) return
          // PEND-73 Phase 2 — see CommandPalette.tsx for the cancellation rationale.
          if (isCancellation(err)) return
          logger.warn('useAutocompleteSources', 'listTagsByPrefix failed', { prefix: query }, err)
          // PEND-73 Phase 3.U1 — once-per-session toast for real failures.
          surfaceFailureOnce('autocomplete:tags', () => notify.error(t('search.failed')))
          setTagLoading(false)
        })
    }, TAG_DEBOUNCE_MS)

    return () => {
      if (tagDebounceTimerRef.current) {
        clearTimeout(tagDebounceTimerRef.current)
        tagDebounceTimerRef.current = null
      }
    }
  }, [active, query, tagGen, surfaceFailureOnce, t])

  if (anchor == null) {
    return { items: [], loading: false }
  }

  switch (anchor.active) {
    case 'state':
      return { items: projectStatic(STATE_VALUES, anchor.query), loading: false }
    case 'priority':
      return { items: projectStatic(PRIORITY_VALUES, anchor.query), loading: false }
    case 'due':
    case 'scheduled':
      return { items: projectStatic(DATE_BUCKET_VALUES, anchor.query), loading: false }
    case 'pathInclude':
    case 'pathExclude': {
      const history = getPathHistory(spaceId)
      return { items: projectStatic(history, anchor.query), loading: false }
    }
    case 'tag':
      return { items: tagItems, loading: tagLoading }
    case 'propKey':
      // `usePropertyKeysCache` returns the stable empty array until the
      // first fetch resolves; `loading: false` because the cache is
      // shared with the rest of the app and we don't own its lifecycle.
      return { items: projectStatic(propKeys, anchor.query), loading: false }
    case 'propValue':
      // PEND-60 defers propValue (the value side of `prop:key=value`)
      // past Phase 2.
      return { items: [], loading: false }
    default:
      return { items: [], loading: false }
  }
}
