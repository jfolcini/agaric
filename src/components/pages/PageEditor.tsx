/**
 * PageEditor — page-level wrapper around BlockTree.
 *
 * Provides editable title, back navigation, and a `t('action.addBlock')` button.
 * Loads children of the given pageId via BlockTree's parentId prop.
 */

import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DonePanel } from '@/components/agenda/DonePanel'
import { DuePanel } from '@/components/agenda/DuePanel'
import { LinkedReferences } from '@/components/backlinks/LinkedReferences'
import { UnlinkedReferences } from '@/components/backlinks/UnlinkedReferences'
import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { AddBlockButton } from '@/components/editor/AddBlockButton'
import { BlockTree } from '@/components/editor/BlockTree'
import { LinkPreviewTooltip } from '@/components/LinkPreviewTooltip'
import { PageHeader } from '@/components/pages/PageHeader'
import { PageMetadataBar } from '@/components/pages/PageMetadataBar'
import { PagesTreeSection } from '@/components/pages/PagesTreeSection'
import type { NavigateToPageFn } from '@/lib/block-events'
import { isDateFormattedPage } from '@/lib/date-utils'
import { notify } from '@/lib/notify'
import { scrollElementIntoView } from '@/lib/scroll-into-view'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import {
  PageBlockStoreProvider,
  usePageBlockStore,
  usePageBlockStoreApi,
} from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

export interface PageEditorProps {
  pageId: string
  title: string
  onBack?: (() => void) | undefined
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function PageEditor({
  pageId,
  title,
  onBack,
  onNavigateToPage,
}: PageEditorProps): React.ReactElement {
  return (
    <PageBlockStoreProvider pageId={pageId}>
      <PageEditorInner
        pageId={pageId}
        title={title}
        onBack={onBack}
        onNavigateToPage={onNavigateToPage}
      />
    </PageBlockStoreProvider>
  )
}

function PageEditorInner({
  pageId,
  title,
  onBack,
  onNavigateToPage,
}: PageEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const blocks = usePageBlockStore((s) => s.blocks)
  const blocksById = usePageBlockStore((s) => s.blocksById)
  const createBelow = usePageBlockStore((s) => s.createBelow)
  const setFocused = useBlockStore((s) => s.setFocused)
  const pageStore = usePageBlockStoreApi()

  // Scroll to and focus a specific block when navigating via a link
  const selectedBlockId = useNavigationStore((s) => s.selectedBlockId)
  const clearSelection = useNavigationStore((s) => s.clearSelection)

  // #4011 — the block currently being revealed by BlockTree's async reveal
  // effect (expand collapsed ancestors / raise the mount cap), so the
  // `onRevealSettled` callback below can tell a SETTLED report for the
  // CURRENT navigation from a stale one for a target `selectedBlockId` has
  // already moved past. `null` means no reveal is in flight.
  const pendingRevealBlockIdRef = useRef<string | null>(null)

  // #4012 review note 2 — the re-arm token handed to BlockTree. Bumped every
  // time the slow path below registers a pending reveal, because BlockTree's
  // reveal effect keys on `focusedBlockId` and `setFocused(selectedBlockId)`
  // is a NO-OP when that block is already focused (navigating back to the
  // block you just came from, a second click on the same backlink, a reveal
  // re-registered after an unrelated re-render). Nothing in that effect's
  // deps would change, so it would never re-run, never report, and the
  // navigation would hang forever: no scroll, no notice, selection never
  // cleared. The old bounded poll at least always terminated; replacing a
  // wrong bound with an unbounded wait would have been a worse trade.
  const [revealNonce, setRevealNonce] = useState(0)

  // BlockTree reports the two DECIDABLE end states of a reveal it just ran
  // for `blockId`: `found: true` once the row is actually mounted, `found:
  // false` once BlockTree has determined it cannot reveal the target at all
  // (outside the active zoom pane — see BlockTree.tsx's "#3276" reveal
  // effect). Ignores a callback for any id other than the one currently
  // pending — a stale report for a target `selectedBlockId` has since moved
  // past (or that already resolved) must not scroll to, or error about, the
  // wrong block.
  const handleRevealSettled = useCallback(
    (blockId: string, found: boolean): void => {
      if (pendingRevealBlockIdRef.current !== blockId) return
      if (found) {
        const el = document.querySelector(`[data-block-id="${blockId}"]`)
        // #4012 review note 1 — BlockTree reports on its own state (the row
        // is in `mountedVisible`), which is one step ahead of the DOM in the
        // cases where they can disagree at all. A missing element here is
        // therefore NOT-YET-SETTLED, not "not found": consuming the pending
        // reveal would clear the one-shot navigation intent with no scroll
        // and no notice — the exact silent no-op #3276 exists to prevent, and
        // the one thing the old poll never did (it kept going until the
        // element existed). Leave the reveal pending instead: the layout
        // effect below re-runs on the next commit and takes its fast path the
        // moment the row appears, and BlockTree re-reports on every further
        // change of its own reveal state.
        if (!el) return
        pendingRevealBlockIdRef.current = null
        scrollElementIntoView(el, { behavior: 'smooth', block: 'center' })
        clearSelection()
        return
      }
      // The reveal is not merely slow — BlockTree has confirmed it cannot
      // show this block at all — so tell the user instead of silently
      // dropping the navigation intent.
      pendingRevealBlockIdRef.current = null
      notify.error(t('error.blockNotFound'))
      clearSelection()
    },
    [clearSelection, t],
  )

  // useLayoutEffect fires synchronously after DOM commit but before paint,
  // eliminating the visible scroll jump that occurred with useEffect + rAF (B-76).
  //
  // #3276 — the target row can be hidden under a collapsed ancestor or sit
  // past BlockTree's mount cap, so it may not exist in the DOM on the first
  // commit even though `target` (the store row) is truthy. BlockTree reveals
  // such a target asynchronously (expanding collapsed ancestors / raising the
  // mount cap), so `clearSelection()` used to fire unconditionally here and
  // burn the one-shot navigation intent before the reveal could land — no
  // scroll, no highlight, no message, indistinguishable from a broken link.
  //
  // #4011 — the slow path used to poll `requestAnimationFrame` and give up
  // after a bounded, invented FRAME COUNT (`STALL_LIMIT`, before that
  // `MAX_REVEAL_ATTEMPTS = 40`) once the mounted rows stopped visibly
  // changing — an assumption about how many frames a reveal SHOULD take,
  // dressed up as a stall detector, still capable of false-negative
  // `error.blockNotFound` for a target that would have mounted given one
  // more frame than the bound allowed. There is no such bound anymore: the
  // slow path only registers `selectedBlockId` as the pending reveal and
  // waits for BlockTree's `onRevealSettled` callback above, which reports
  // the real end state — found or not — the moment BlockTree itself
  // determines it, however many renders that takes.
  useLayoutEffect(() => {
    if (!selectedBlockId || blocks.length === 0) return
    const target = blocksById.get(selectedBlockId)
    if (!target) return
    setFocused(selectedBlockId)

    // Fast path (unchanged from before #3276): the row is already mounted,
    // so scroll/clear synchronously before paint — no round-trip, no B-76
    // flash, and nothing for `onRevealSettled` to do.
    const immediateEl = document.querySelector(`[data-block-id="${selectedBlockId}"]`)
    if (immediateEl) {
      scrollElementIntoView(immediateEl, { behavior: 'smooth', block: 'center' })
      clearSelection()
      return
    }

    // Slow path — the row isn't mounted yet (collapsed ancestor / past the
    // mount cap). Hand off to BlockTree's reveal effect; `handleRevealSettled`
    // finishes the job once it reports back. The nonce bump is what
    // GUARANTEES a report: `setFocused` above may have changed nothing (the
    // target is already the focused block), and BlockTree's reveal effect
    // only re-runs — and only then reports — when one of its deps changes.
    pendingRevealBlockIdRef.current = selectedBlockId
    setRevealNonce((n) => n + 1)

    return () => {
      // `selectedBlockId` changed (or the component unmounted) before the
      // reveal settled — a report for the OLD id must no longer act.
      if (pendingRevealBlockIdRef.current === selectedBlockId) {
        pendingRevealBlockIdRef.current = null
      }
    }
  }, [selectedBlockId, blocks, blocksById, setFocused, clearSelection])

  // Clear undo state for the previous page when navigating away or unmounting
  useEffect(
    () => () => {
      useUndoStore.getState().clearPage(pageId)
    },
    [pageId],
  )

  const handleAddBlock = useCallback(async () => {
    // Find the last top-level block (direct child of this page) rather than
    // the last entry in the flat tree, which could be a deeply nested child.
    // Using the flat-tree tail would create the new block under the wrong
    // parent (the nested block's parent instead of the page).
    const topLevel = blocks.filter((b) => b.parent_id === pageId)
    const lastBlock = topLevel.at(-1)
    if (lastBlock) {
      const newId = await createBelow(lastBlock.id, '')
      if (newId) {
        setFocused(newId)
      }
    } else {
      // No blocks yet — create a first block under this page.
      // createBelow needs an afterBlockId, so for the empty case we call
      // createBlock from the Tauri API directly.
      try {
        const { createBlock } = await import('@/lib/tauri')
        const result = await createBlock({
          blockType: 'content',
          content: '',
          parentId: pageId,
        })
        // Splice the returned row into the local store
        // instead of re-fetching the full page. The backend response
        // already carries the canonical BlockRow, so the second
        // `list_blocks` IPC was pure waste.
        pageStore.getState().appendBlock(result)
        setFocused(result.id)
      } catch {
        notify.error(t('error.createBlockFailed'))
      }
    }
  }, [blocks, createBelow, setFocused, pageId, t, pageStore])

  // ── Click on page background whitespace closes active editor ──
  const handleBackgroundMouseDown = useCallback((e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return
    const { focusedBlockId } = useBlockStore.getState()
    if (!focusedBlockId) return
    // If the editor is focused, blur it (triggers normal save-and-close via EditableBlock.handleBlur)
    const editor = document.querySelector('.ProseMirror')
    if (editor?.contains(document.activeElement)) {
      ;(document.activeElement as HTMLElement)?.blur()
    } else {
      // Editor is mounted but already unfocused — force close
      useBlockStore.getState().setFocused(null)
    }
  }, [])

  // ── Link preview tooltip — covers all blocks (static + editor) ──
  // The same container element doubles as the host for the
  // in-page-find matcher. Registered via the find store so the toolbar
  // (mounted at App level) knows which subtree to walk; unregistering
  // on unmount auto-closes the toolbar when the user navigates away.
  const setFindContainer = useInPageFindStore((s) => s.setContainer)
  const [pageContainerEl, setPageContainerEl] = useState<HTMLDivElement | null>(null)
  const pageRef = useCallback(
    (node: HTMLDivElement | null) => {
      setPageContainerEl(node)
      setFindContainer(node)
    },
    [setFindContainer],
  )
  useEffect(
    () => () => {
      // Unmount path — when this page is replaced, drop the container
      // registration so a leftover toolbar can't paint stale highlights.
      setFindContainer(null)
    },
    [setFindContainer],
  )

  return (
    <div
      ref={pageRef}
      className="page-editor flex flex-col gap-3 min-w-0"
      onPointerDown={handleBackgroundMouseDown}
    >
      {/* Header: back button + editable title + tag badges */}
      <PageHeader pageId={pageId} title={title} onBack={onBack} />

      {/* Block tree — loads children of pageId */}
      <BlockTree
        parentId={pageId}
        onNavigateToPage={onNavigateToPage}
        onRevealSettled={handleRevealSettled}
        revealNonce={revealNonce}
      />

      {/* Add block button — always directly beneath the last block */}
      <div>
        <AddBlockButton onClick={handleAddBlock} />
      </div>

      {/* Due/Done panels — shown on date-formatted pages (mirrors DaySection daily view) */}
      {isDateFormattedPage(title) && (
        <>
          <div id="journal-due-panel">
            <DuePanel date={title} onNavigateToPage={onNavigateToPage} excludePageId={pageId} />
          </div>
          <div id="journal-done-panel">
            <DonePanel date={title} onNavigateToPage={onNavigateToPage} excludePageId={pageId} />
          </div>
        </>
      )}

      {/* Pages tree — child pages of this page (Bug 2).
          Sits ABOVE LinkedReferences so the navigation affordance for
          descendant pages lives next to the editor body, not buried under
          the references stack. The section hides itself entirely when
          there are zero descendants; its own FeatureErrorBoundary keeps a
          page-tree crash from cascading into the references panels. */}
      <FeatureErrorBoundary name="PagesTreeSection">
        <PagesTreeSection
          pageId={pageId}
          pageTitle={title}
          onNavigateToPage={onNavigateToPage ?? (() => {})}
        />
      </FeatureErrorBoundary>

      {/* Linked references — always visible at page bottom.
          Wrapped in its own FeatureErrorBoundary so a malformed-ref crash
          in the backlink parser doesn't blank the host page (UX Tier 3). */}
      <FeatureErrorBoundary name="LinkedReferences">
        <LinkedReferences pageId={pageId} onNavigateToPage={onNavigateToPage} />
      </FeatureErrorBoundary>

      {/* Unlinked references — collapsed by default, below linked references.
          Isolated from LinkedReferences so a crash in one doesn't take out
          the other. */}
      <FeatureErrorBoundary name="UnlinkedReferences">
        <UnlinkedReferences pageId={pageId} pageTitle={title} onNavigateToPage={onNavigateToPage} />
      </FeatureErrorBoundary>

      {/* Page metadata bar — word count, block count, created date */}
      <PageMetadataBar blocks={blocks} pageId={pageId} />

      {/* Link preview tooltip — covers all external links in the page */}
      <LinkPreviewTooltip container={pageContainerEl} />
    </div>
  )
}
