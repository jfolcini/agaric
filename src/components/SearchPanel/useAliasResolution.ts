/**
 * useAliasResolution — supplements FTS results with `[[alias]]` matches.
 *
 * PEND-30 D-3 — extracted from `SearchPanel.tsx` (lines 193-228 of the
 * original 672-line file). Behaviour-preserving lift: the effect body,
 * the cancellation-flag pattern, the `currentSpaceId` scoping
 * (PEND-35 Tier 1.2), and the dedup-vs-results guard are all
 * unchanged.
 *
 * Returns `{ aliasMatch, aliasQuery }` for the caller to render. When
 * the query matches one of the FTS results we return `null` for
 * `aliasMatch` so the panel does not render a duplicate row.
 */

import { useEffect, useState } from 'react'
import { logger } from '../../lib/logger'
import type { BlockRow } from '../../lib/tauri'
import { getBlock, resolvePageByAlias } from '../../lib/tauri'

export interface AliasResolution {
  /**
   * The block matched by alias resolution, or `null` when there is no
   * match (or when the matched block is already present in `results`).
   */
  aliasMatch: BlockRow | null
  /**
   * The trimmed query string for which `aliasMatch` was resolved.
   * Empty when `aliasMatch === null`.
   */
  aliasQuery: string
}

/**
 * @param query        The trimmed-or-untrimmed query — the hook trims
 *                     internally, matching the original behaviour.
 * @param results      The current FTS result set; alias matches that
 *                     duplicate a result are suppressed.
 * @param currentSpaceId  Active space id; foreign-space alias targets
 *                        are filtered out by the backend.
 */
export function useAliasResolution(
  query: string,
  results: ReadonlyArray<BlockRow>,
  currentSpaceId: string | null,
): AliasResolution {
  const [aliasMatch, setAliasMatch] = useState<BlockRow | null>(null)
  const [aliasQuery, setAliasQuery] = useState<string>('')

  const trimmed = query.trim()
  const isEmpty = trimmed.length === 0

  // FE-12 — resolution depends only on the query + space, NOT on the
  // `results` array. Keying the effect on `results` re-fired the alias
  // IPC (and a getBlock) on every pagination / refetch identity change.
  // The "already in the result list" suppression is a cheap render-time
  // derive below, so it no longer needs to be a resolution dependency.
  useEffect(() => {
    if (isEmpty) {
      setAliasMatch(null)
      setAliasQuery('')
      return
    }
    let cancelled = false
    // PEND-35 Tier 1.2 — pass `spaceId: currentSpaceId` so an alias
    // pointing at a foreign-space page does not surface here. Mirrors
    // the FEAT-3p4 active-space scoping the prefix picker already uses.
    resolvePageByAlias({ alias: trimmed, spaceId: currentSpaceId })
      .then(async (result) => {
        if (cancelled) return
        if (!result) {
          setAliasMatch(null)
          setAliasQuery('')
          return
        }
        const [pageId] = result
        try {
          const block = await getBlock(pageId)
          if (!cancelled) {
            setAliasMatch(block)
            setAliasQuery(trimmed)
          }
        } catch {
          if (!cancelled) {
            setAliasMatch(null)
            setAliasQuery('')
          }
        }
      })
      .catch((err) => {
        // Don't log the raw query text (log hygiene — matches the breadcrumb logs).
        logger.warn('SearchPanel', 'alias resolution failed', undefined, err)
        if (!cancelled) {
          setAliasMatch(null)
          setAliasQuery('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [trimmed, isEmpty, currentSpaceId])

  // Suppress the rendered alias card synchronously when the query is
  // empty. The effect above will eventually reset state, but it runs
  // post-paint (`useEffect`); without this guard there is a 1-frame
  // flash of the stale alias card between "user clears input" and "the
  // effect runs".
  if (isEmpty) {
    return { aliasMatch: null, aliasQuery: '' }
  }

  // FE-12 — hide the card when the resolved page already appears in the
  // result list. Done at render (not in the resolution effect) so a
  // changing `results` array no longer re-triggers the IPC.
  if (aliasMatch && results.some((r) => r.id === aliasMatch.id)) {
    return { aliasMatch: null, aliasQuery: '' }
  }

  return { aliasMatch, aliasQuery }
}

/**
 * NOTE on imperative reset: the original `SearchPanel.handleInputChange`
 * called `setAliasMatch(null)` / `setAliasQuery('')` synchronously when
 * the user emptied the input. After the D-3 lift those imperative call
 * sites are gone — the effect handles the clear-on-empty path AND the
 * derived-output guard above (`if (isEmpty) return …null`) preserves
 * synchronous suppression so there is no 1-frame stale-alias flash
 * between input-clear and effect-run.
 */
