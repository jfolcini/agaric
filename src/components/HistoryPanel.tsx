/**
 * HistoryPanel — shows the edit history of a block from the op log.
 *
 * Per-block panel: receives a blockId prop and displays paginated history entries.
 *
 * PEND-17 Part B redesign:
 *   - In-panel restore is dialog-free; toast-with-Undo is the safety net
 *     (the existing UX-275 sub-fix 4 snapshot+Undo flow still owns the
 *     "second chance" guarantee).
 *   - Keyboard browse: ↓/↑ move between rows, focused row auto-expands
 *     and the previously-focused row collapses, Enter triggers the
 *     focused row's restore, Escape collapses and clears focus.
 *   - The legacy ConfirmDialog has been removed; non-preview entry
 *     points (BlockContextMenu, gutter shortcut) keep their dialogs in
 *     place — they don't route through this component.
 */

import { Clock } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useHistoryDiffToggle } from '../hooks/useHistoryDiffToggle'
import type { HistoryEntry } from '../lib/tauri'
import { editBlock, getBlock, getBlockHistory } from '../lib/tauri'
// PEND-35 Tier 1.3 — `opTypeFilter` now drives the IPC directly (mirrors
// the global `HistoryView` path). The legacy post-pagination JS filter
// silently dropped rows from the cursor page, so a 50-row backend page
// of mixed op types could yield 0 visible rows.
import { EmptyState } from './EmptyState'
import { HistoryFilterBar } from './HistoryFilterBar'
import { BlockHistoryItem } from './HistoryListItem'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'

interface HistoryPanelProps {
  /** The block to show history for. */
  blockId: string | null
}

export function HistoryPanel({ blockId }: HistoryPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  // PEND-17 Part B — only one row is expanded at a time. `null` ⇒
  // collapsed/idle. Tracked by `seq` (stable per device) instead of
  // index so cursor pagination doesn't shuffle expansion to the wrong
  // row when new entries are loaded.
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)
  const { expandedKeys, diffCache, loadingDiffs, handleToggleDiff } = useHistoryDiffToggle<number>(
    (entry) => entry.seq,
  )
  const listRef = useRef<HTMLUListElement | null>(null)
  // MAINT-219: ref attached to the currently-expanded row's primary
  // `Restore` button. Owning the ref at the panel level (rather than
  // querySelector-ing the DOM) keeps focus management aligned with React
  // state — the markup can move without silently breaking the lookup.
  // The ref is only forwarded to the row whose `seq === expandedSeq`, so
  // at most one button claims it at any time.
  const restoreButtonRef = useRef<HTMLButtonElement | null>(null)
  // MAINT-219: latched true by `handlePanelKeyDown` whenever an arrow
  // key changes `expandedSeq`; consumed by the focus-on-expand effect
  // below and reset. Using a ref (not state) so toggling it doesn't
  // trigger a re-render. The latch covers the unmount-blur race where
  // collapsing the previously-expanded row drops `document.activeElement`
  // back to `<body>` before the new row's button mounts — without it,
  // the effect's "is focus still in the list?" guard would short-circuit
  // and leave focus stranded on body, so the NEXT arrow keypress goes
  // nowhere (no row receives it) and the user is silently stuck.
  const pendingKeyboardFocusRef = useRef(false)

  const loadHistory = useCallback(
    async (cursor?: string) => {
      if (!blockId) return
      setLoading(true)
      try {
        const resp = await getBlockHistory({
          blockId,
          ...(opTypeFilter != null && { opTypeFilter }),
          ...(cursor != null && { cursor }),
          limit: PAGINATION_LIMIT,
        })
        if (cursor) {
          setEntries((prev) => [...prev, ...resp.items])
        } else {
          setEntries(resp.items)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
      } catch (err) {
        logger.error('HistoryPanel', 'Failed to load block history', { blockId }, err)
        notify.error(t('history.loadFailed'))
      }
      setLoading(false)
    },
    // PEND-35 Tier 1.3 — `opTypeFilter` is now part of the cache key so
    // changing the filter forces a refetch with pre-filtered SQL.
    [blockId, opTypeFilter, t],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when blockId or opTypeFilter changes
  useEffect(() => {
    setEntries([])
    setNextCursor(null)
    setHasMore(false)
    setExpandedSeq(null)
    loadHistory()
  }, [blockId, opTypeFilter, loadHistory])

  const loadMore = useCallback(() => {
    if (nextCursor) loadHistory(nextCursor)
  }, [nextCursor, loadHistory])

  // PEND-35 Tier 1.3 — backend now applies `op_type_filter` in SQL, so
  // entries arrive pre-filtered. Keep the alias to minimise diff churn
  // in the consumers below.
  const filteredEntries = entries

  // UX-275 sub-fix 4: restore is reversible — capture the current block
  // content BEFORE applying the historical version so the success toast can
  // offer a one-click "Undo" that re-applies the captured snapshot.
  const handleUndoRestore = useCallback(
    async (targetBlockId: string, previousContent: string) => {
      try {
        await editBlock(targetBlockId, previousContent)
        notify.success(t('history.restoreUndone'))
      } catch (err) {
        logger.error('HistoryPanel', 'Failed to undo restore', { blockId: targetBlockId }, err)
        notify.error(t('history.restoreUndoFailed'))
      }
    },
    [t],
  )

  const handleRestore = useCallback(
    async (entry: HistoryEntry) => {
      if (!blockId) return
      try {
        const parsed = JSON.parse(entry.payload) as { to_text?: string }
        if (parsed.to_text == null) return

        // Snapshot the current block content for the toast's Undo action.
        // We tolerate a missing snapshot (e.g. fresh block, transient IPC
        // glitch) — the restore still proceeds, just without an Undo offer.
        let previousContent: string | null = null
        try {
          const current = await getBlock(blockId)
          previousContent = current.content ?? ''
        } catch (snapshotErr) {
          logger.warn(
            'HistoryPanel',
            'Could not snapshot block before restore — Undo will be unavailable',
            { blockId, opId: entry.seq },
            snapshotErr,
          )
        }

        await editBlock(blockId, parsed.to_text)

        if (previousContent != null) {
          const captured = previousContent
          notify.success(t('history.revertedSuccessfully'), {
            action: {
              label: t('action.undo'),
              onClick: () => {
                handleUndoRestore(blockId, captured)
              },
            },
          })
        } else {
          notify.success(t('history.revertedSuccessfully'))
        }
      } catch (err) {
        logger.error(
          'HistoryPanel',
          'Failed to restore from history',
          { blockId, opId: entry.seq },
          err,
        )
        notify.error(t('history.revertPanelFailed'))
      }
    },
    [blockId, t, handleUndoRestore],
  )

  // PEND-17 Part B keyboard browse — ↓/↑ navigate restorable rows
  // (focused row auto-expands), Enter restores the focused row, Esc
  // collapses. Skips non-restorable rows so the keyboard cursor never
  // gets "stuck" on a non-actionable entry.
  const restorableEntries = useMemo(() => {
    return filteredEntries.filter((e) => {
      if (e.op_type !== 'edit_block') return false
      try {
        const p = JSON.parse(e.payload) as Record<string, unknown>
        return typeof p['to_text'] === 'string'
      } catch {
        return false
      }
    })
  }, [filteredEntries])

  const handlePanelKeyDown = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: refactor deferred to follow-up
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (restorableEntries.length === 0) return
      const currentIdx = restorableEntries.findIndex((entry) => entry.seq === expandedSeq)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = currentIdx < 0 ? 0 : Math.min(restorableEntries.length - 1, currentIdx + 1)
        const target = restorableEntries[next]
        if (target) {
          // MAINT-219: latch keyboard-nav intent BEFORE the state
          // update so the post-render focus effect knows this
          // expansion came from arrow keys (not a mouse click).
          pendingKeyboardFocusRef.current = true
          setExpandedSeq(target.seq)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = currentIdx <= 0 ? 0 : currentIdx - 1
        const target = restorableEntries[prev]
        if (target) {
          pendingKeyboardFocusRef.current = true
          setExpandedSeq(target.seq)
        }
        return
      }
      if (e.key === 'Enter' && currentIdx >= 0) {
        e.preventDefault()
        const target = restorableEntries[currentIdx]
        if (target) handleRestore(target)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setExpandedSeq(null)
      }
    },
    [restorableEntries, expandedSeq, handleRestore],
  )

  // Scroll the expanded row into view when it changes via keyboard.
  // Intentional reset on `expandedSeq` change.
  useEffect(() => {
    if (expandedSeq == null || !listRef.current) return
    if (!listRef.current.contains(document.activeElement)) return
    const el = listRef.current.querySelector(
      `[data-block-history-item][data-seq="${expandedSeq}"]`,
    ) as HTMLElement | null
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [expandedSeq])

  // MAINT-219 — keep DOM focus in sync with `expandedSeq`. Without this,
  // `↓`/`↑` move expansion state but focus stays on the originally-
  // focused row, so a subsequent `Enter` double-fires: the focused row's
  // `handleRowKeyDown` toggles ITS expansion AND `handlePanelKeyDown`
  // restores the (different) expanded row. Moving focus to the expanded
  // row's `Restore` button makes the row-level keydown handler operate
  // on the same entry the panel-level handler does, and matches the
  // standard tree/list focus-follows-state idiom.
  //
  // Two activation paths:
  //  1. `pendingKeyboardFocusRef` was latched by `handlePanelKeyDown` —
  //     unconditional focus shift (consumes the latch). Covers the
  //     unmount-blur race where the previously-expanded button is gone
  //     by the time this effect runs and `document.activeElement` has
  //     fallen back to `<body>`.
  //  2. Focus is already inside the list (e.g. user pressed `↓` while
  //     the `<ul>` itself had focus and there was no previous expanded
  //     button to unmount). Same outcome, but the latch path isn't
  //     strictly necessary here.
  //
  // Skipped when `expandedSeq` is null (the row collapsed; leave focus
  // wherever the user put it) or when neither activation path applies
  // (the expansion came from a mouse click outside the list — don't
  // yank focus into the panel).
  useEffect(() => {
    if (expandedSeq == null) return
    if (!listRef.current) return
    const fromKeyboard = pendingKeyboardFocusRef.current
    pendingKeyboardFocusRef.current = false
    const focusInList = listRef.current.contains(document.activeElement)
    if (!fromKeyboard && !focusInList) return
    const btn = restoreButtonRef.current
    if (btn) btn.focus()
  }, [expandedSeq])

  const handleExpandToggle = useCallback(
    (entry: HistoryEntry, opening: boolean) => {
      // Single-expansion model: opening row N collapses any other,
      // and clicking the active row again collapses it. Also lazily
      // hydrate the "Just this change" diff when expanding so the
      // bottom toggle has data ready when the user switches modes.
      if (opening) {
        setExpandedSeq(entry.seq)
        if (entry.op_type === 'edit_block' && !expandedKeys.has(entry.seq)) {
          void handleToggleDiff(entry)
        }
      } else {
        setExpandedSeq((cur) => (cur === entry.seq ? null : cur))
      }
    },
    [expandedKeys, handleToggleDiff],
  )

  if (!blockId) {
    return <EmptyState message={t('history.selectBlockEmpty')} compact />
  }

  return (
    <div className="history-panel space-y-4">
      <HistoryFilterBar opTypeFilter={opTypeFilter} onFilterChange={setOpTypeFilter} />

      <ListViewState
        loading={loading}
        items={filteredEntries}
        skeleton={<LoadingSkeleton count={2} height="h-14" className="history-panel-loading" />}
        empty={<EmptyState icon={Clock} message={t('history.noHistoryEmpty')} />}
      >
        {(items) => (
          <ul
            ref={listRef}
            className="history-list space-y-0 list-none p-0 m-0 focus:outline-none"
            // PEND-17 Part B — list-level keydown handler; tabIndex=-1
            // keeps the list itself outside the tab order while still
            // accepting key events delegated up from focused rows.
            tabIndex={-1}
            onKeyDown={handlePanelKeyDown}
            data-testid="history-panel-list"
          >
            {items.map((entry, i) => {
              const isExpanded = expandedSeq === entry.seq
              return (
                <BlockHistoryItem
                  key={entry.seq}
                  blockId={blockId}
                  entry={entry}
                  index={i}
                  isExpanded={isExpanded}
                  isLoadingDiff={loadingDiffs.has(entry.seq)}
                  diffSpans={diffCache.get(entry.seq)}
                  onExpandToggle={handleExpandToggle}
                  onRestore={handleRestore}
                  // MAINT-219: only the expanded row gets the ref so the
                  // focus-on-change effect targets a single, current
                  // button. The ref is reassigned across renders when
                  // the expansion moves — React detaches the old node
                  // and attaches the new one in the same commit.
                  // Conditional spread (vs `restoreButtonRef={isExpanded ? ref
                  // : undefined}`) keeps the optional prop omitted on
                  // collapsed rows, satisfying `exactOptionalPropertyTypes`.
                  {...(isExpanded ? { restoreButtonRef } : {})}
                />
              )
            })}
          </ul>
        )}
      </ListViewState>

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="history-load-more"
      />
    </div>
  )
}
