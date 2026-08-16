/**
 * PageEditor — page-level wrapper around BlockTree.
 *
 * Provides editable title, back navigation, and a `t('action.addBlock')` button.
 * Loads children of the given pageId via BlockTree's parentId prop.
 */

import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
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
  // Poll across a bounded number of animation frames for the reveal to
  // commit; only clear the intent once the element is actually found, and
  // surface a visible notice (rather than silently giving up) if it never
  // does.
  useLayoutEffect(() => {
    if (!selectedBlockId || blocks.length === 0) return
    const target = blocksById.get(selectedBlockId)
    if (!target) return
    setFocused(selectedBlockId)

    // Fast path (unchanged from before #3276): the row is already mounted,
    // so scroll/clear synchronously before paint — no rAF round-trip, no
    // B-76 flash.
    const immediateEl = document.querySelector(`[data-block-id="${selectedBlockId}"]`)
    if (immediateEl) {
      scrollElementIntoView(immediateEl, { behavior: 'smooth', block: 'center' })
      clearSelection()
      return
    }

    // Slow path — the row isn't mounted yet (collapsed ancestor / past the
    // mount cap). BlockTree reveals it asynchronously; poll across animation
    // frames instead of giving up on this one commit.
    let cancelled = false

    // #3881 — bounding this poll by a fixed FRAME COUNT (the previous
    // `MAX_REVEAL_ATTEMPTS = 40`, an invented number with no derivation, no
    // comment, and no link to a measured or existing budget) false-negatives
    // on a slow machine or a large page: BlockTree's reveal effect
    // (BlockTree.tsx, "#3276: reveal a navigation target…") jumps the mount
    // cap straight to the target's index via `revealIndex`, which can mean
    // mounting hundreds of rows in one commit — legitimately slower than 40
    // frames (~667ms @ 60fps) on a loaded machine or a page near
    // PAGE_SUBTREE_MAX_BLOCKS. A block that exists and WOULD have mounted
    // then gets `error.blockNotFound` instead — a false negative shown as
    // user-facing error text, which is worse than the silent no-op #3276
    // fixed.
    //
    // Bound STALL instead of TIME. BlockTree's own comment documents that
    // its reveal effect "converges over a couple of renders" — each
    // cascading `expandAncestors`/`revealIndex` state update mounts at
    // least one more `[data-block-id]` row. So keep polling as long as the
    // number of mounted block rows in the document keeps growing (real work
    // is happening); only give up once it stops growing for STALL_LIMIT
    // consecutive frames — i.e. the mechanism has genuinely stalled (e.g.
    // the target sits outside the active zoom pane, a known
    // not-yet-addressed case per BlockTree.tsx), not merely running slow.
    // STALL_LIMIT is a small multiple of BlockTree's documented "couple of
    // renders" convergence window, not a retuned timing guess — and because
    // it only measures ABSENCE of progress (not elapsed time), a reveal
    // that is still progressing cannot trip it, however long it takes.
    //
    // Counts `[data-block-id]` rows document-wide (the same scope as the
    // lookup below) rather than scoping to this page's own container, so
    // unrelated DOM churn elsewhere can in principle also reset the stall
    // counter — that only delays giving up, it can never cause a false
    // `notify.error()`, so it's an acceptable tradeoff for not depending on
    // BlockTree's internals from here.
    const STALL_LIMIT = 6
    let lastMountedCount = document.querySelectorAll('[data-block-id]').length
    let stallFrames = 0

    const tryReveal = (): void => {
      if (cancelled) return
      const el = document.querySelector(`[data-block-id="${selectedBlockId}"]`)
      if (el) {
        scrollElementIntoView(el, { behavior: 'smooth', block: 'center' })
        clearSelection()
        return
      }
      const mountedCount = document.querySelectorAll('[data-block-id]').length
      if (mountedCount > lastMountedCount) {
        lastMountedCount = mountedCount
        stallFrames = 0
      } else {
        stallFrames += 1
      }
      if (stallFrames >= STALL_LIMIT) {
        // The reveal has genuinely stalled (or the block can't be shown,
        // e.g. it's outside the active zoom pane) — tell the user instead of
        // silently dropping the navigation intent.
        notify.error(t('error.blockNotFound'))
        clearSelection()
        return
      }
      requestAnimationFrame(tryReveal)
    }
    requestAnimationFrame(tryReveal)

    return () => {
      cancelled = true
    }
  }, [selectedBlockId, blocks, blocksById, setFocused, clearSelection, t])

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
      <BlockTree parentId={pageId} onNavigateToPage={onNavigateToPage} />

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
