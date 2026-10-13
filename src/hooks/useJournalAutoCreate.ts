import { useCallback, useEffect, useEffectEvent, useRef } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { formatDate } from '@/lib/date-utils'
import { getShortcutKeys, isEditableTarget } from '@/lib/keyboard-config'

interface UseJournalAutoCreateOptions {
  loading: boolean
  mode: string
  currentDate: Date
  /**
   * Active space ULID, or `null` when no space is active. `getJournalPageByDate`
   * is required-active (b1), so both effects below skip the probe entirely when
   * this is `null` rather than dispatching a scope with no active space.
   */
  spaceId: string | null
  /** Pages this React tree just created (not yet visible to the backend index). */
  createdPages: Map<string, string>
  /** The journal's `dateStr → pageId` map for the range on screen. */
  pageMap: Map<string, string>
  /**
   * #5438 — `useCalendarPageDates().fetchedThisMount`: when the map is this
   * mount's own round trip, it already answers the `get_journal_page_by_date`
   * probe, so the mount path creates (or not) from it directly.
   */
  pageMapFetchedThisMount: boolean
  handleAddBlock: (dateStr: string) => void
}

export function useJournalAutoCreate({
  loading,
  mode,
  currentDate,
  spaceId,
  createdPages,
  pageMap,
  pageMapFetchedThisMount,
  handleAddBlock,
}: UseJournalAutoCreateOptions): (dateStr: string) => void {
  const autoCreatedRef = useRef<string | null>(null)

  // Auto-create *today*'s page on mount when the journal opens in daily mode.
  // Follow-up: the prior behaviour fired on every date change, which
  // silently created an empty journal page for any past or future day the
  // user merely navigated to. Restricting to today scopes the
  // create-on-arrival affordance to the case users actually want — landing
  // on the journal and finding today's page ready to type into — and leaves
  // backfilling old dates to the explicit `n`/`Enter` shortcut or the
  // `Add block` button.
  //
  // The page state is read, not depended on: re-running whenever the page map
  // changed re-created today's page the moment the user deleted it (#5358).
  // It is read again when the probe lands, because the user may have created
  // the page through "Add your first block" while the probe was out.
  const hasCreatedPage = useEffectEvent((dateStr: string) => createdPages.has(dateStr))
  const freshPageMap = useEffectEvent(() => (pageMapFetchedThisMount ? pageMap : null))
  const createPage = useEffectEvent(handleAddBlock)
  useEffect(() => {
    if (loading) return
    if (mode !== 'daily') return
    // b1 — no active space → skip the required-active probe (no auto-create).
    if (spaceId == null) return
    const dateStr = formatDate(currentDate)
    if (dateStr !== formatDate(new Date())) return
    if (autoCreatedRef.current === dateStr) return
    if (hasCreatedPage(dateStr)) return
    // #5438 — a map this mount fetched is the probe's answer; skip the round trip.
    const fresh = freshPageMap()
    if (fresh != null) {
      if (fresh.has(dateStr)) return
      autoCreatedRef.current = dateStr
      createPage(dateStr)
      return
    }
    let cancelled = false
    commands
      .getJournalPageByDate(dateStr, { kind: 'active', space_id: spaceId })
      .then(unwrap)
      .then((page) => {
        if (cancelled) return
        if (page != null) return
        if (autoCreatedRef.current === dateStr) return
        if (hasCreatedPage(dateStr)) return
        autoCreatedRef.current = dateStr
        createPage(dateStr)
      })
      .catch(() => {
        // Probe failure leaves the page un-auto-created for this render.
        // The user can still add a block manually, and the next date
        // change re-runs the effect.
      })
    return () => {
      cancelled = true
    }
  }, [loading, mode, currentDate, spaceId])

  // Keyboard shortcut for new block in daily mode.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'daily') return
      // b1 — no active space → the shortcut is a no-op (required-active probe).
      if (spaceId == null) return
      const dateStr = formatDate(currentDate)
      if (createdPages.has(dateStr)) return
      if (isEditableTarget(e.target)) return
      // Enter on a focused control is its activation; claiming it swallows the click (#5301).
      if (
        e.key === 'Enter' &&
        e.target instanceof Element &&
        e.target.closest('button, a, [role="radio"]')
      ) {
        return
      }
      const createKeys = getShortcutKeys('createJournalBlock')
        .split('/')
        .map((k) => k.trim().toLowerCase())
      if (!createKeys.includes(e.key.toLowerCase())) return
      e.preventDefault()
      // Per-keypress probe replaces the in-memory `pageMap.has`
      // gate. Skips creation when a page already exists for `dateStr`,
      // matching the previous short-circuit semantics.
      commands
        .getJournalPageByDate(dateStr, { kind: 'active', space_id: spaceId })
        .then(unwrap)
        .then((page) => {
          if (page != null) return
          // #755 — same in-flight guard as the mount path. Rapid double
          // presses fire two probes before either resolves; both see
          // "no page" and would each create one. First resolution claims
          // the date; the second bails.
          if (autoCreatedRef.current === dateStr) return
          autoCreatedRef.current = dateStr
          handleAddBlock(dateStr)
        })
        .catch(() => {
          // Probe failure leaves the shortcut as a no-op for this press.
        })
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mode, currentDate, spaceId, createdPages, handleAddBlock])

  // Once a claimed date's page is deleted, the claim would leave the create
  // shortcut dead on that empty day for the rest of the session.
  return useCallback((dateStr: string) => {
    if (autoCreatedRef.current === dateStr) autoCreatedRef.current = null
  }, [])
}
