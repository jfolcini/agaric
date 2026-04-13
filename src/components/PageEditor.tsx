/**
 * PageEditor — page-level wrapper around BlockTree.
 *
 * Provides editable title, back navigation, and an "Add block" button.
 * Loads children of the given pageId via BlockTree's parentId prop.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { NavigateToPageFn } from '../lib/block-events'
import { isDateFormattedPage } from '../lib/date-utils'
import { useBlockStore } from '../stores/blocks'
import { useNavigationStore } from '../stores/navigation'
import {
  PageBlockStoreProvider,
  usePageBlockStore,
  usePageBlockStoreApi,
} from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'
import { AddBlockButton } from './AddBlockButton'
import { BlockTree } from './BlockTree'
import { DonePanel } from './DonePanel'
import { DuePanel } from './DuePanel'
import { LinkedReferences } from './LinkedReferences'
import { LinkPreviewTooltip } from './LinkPreviewTooltip'
import { PageHeader } from './PageHeader'
import { PageMetadataBar } from './PageMetadataBar'
import { UnlinkedReferences } from './UnlinkedReferences'

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
  const createBelow = usePageBlockStore((s) => s.createBelow)
  const setFocused = useBlockStore((s) => s.setFocused)
  const pageStore = usePageBlockStoreApi()

  // Scroll to and focus a specific block when navigating via a link
  const selectedBlockId = useNavigationStore((s) => s.selectedBlockId)
  const clearSelection = useNavigationStore((s) => s.clearSelection)

  useEffect(() => {
    if (!selectedBlockId || blocks.length === 0) return
    // Focus the target block if it exists in this page's block tree
    const target = blocks.find((b) => b.id === selectedBlockId)
    if (target) {
      setFocused(selectedBlockId)
      // Scroll into view after a tick to allow DOM to update
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-block-id="${selectedBlockId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      clearSelection()
    }
  }, [selectedBlockId, blocks, setFocused, clearSelection])

  // Clear undo state for the previous page when navigating away or unmounting
  useEffect(() => {
    return () => {
      useUndoStore.getState().clearPage(pageId)
    }
  }, [pageId])

  const handleAddBlock = useCallback(async () => {
    // Find the last top-level block (direct child of this page) rather than
    // the last entry in the flat tree, which could be a deeply nested child.
    // Using the flat-tree tail would create the new block under the wrong
    // parent (the nested block's parent instead of the page).
    const topLevel = blocks.filter((b) => b.parent_id === pageId)
    const lastBlock = topLevel[topLevel.length - 1]
    if (lastBlock) {
      const newId = await createBelow(lastBlock.id, '')
      if (newId) {
        setFocused(newId)
      }
    } else {
      // No blocks yet — create a first block under this page.
      // createBelow needs an afterBlockId, so for the empty case we call
      // createBlock from the Tauri API directly and reload.
      try {
        const { createBlock } = await import('../lib/tauri')
        const result = await createBlock({
          blockType: 'content',
          content: '',
          parentId: pageId,
        })
        // Reload blocks via the store to pick up the new block
        await pageStore.getState().load()
        setFocused(result.id)
      } catch {
        toast.error(t('error.createBlockFailed'))
      }
    }
  }, [blocks, createBelow, setFocused, pageId, t, pageStore])

  // ── Click on page background whitespace closes active editor (UX-M9) ──
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
  const [pageContainerEl, setPageContainerEl] = useState<HTMLDivElement | null>(null)
  const pageRef = useCallback((node: HTMLDivElement | null) => {
    setPageContainerEl(node)
  }, [])

  return (
    <div
      ref={pageRef}
      className="page-editor flex flex-col gap-3"
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
            <DuePanel date={title} onNavigateToPage={onNavigateToPage} />
          </div>
          <div id="journal-done-panel">
            <DonePanel date={title} onNavigateToPage={onNavigateToPage} />
          </div>
        </>
      )}

      {/* Linked references — always visible at page bottom */}
      <LinkedReferences pageId={pageId} onNavigateToPage={onNavigateToPage} />

      {/* Unlinked references — collapsed by default, below linked references */}
      <UnlinkedReferences pageId={pageId} pageTitle={title} onNavigateToPage={onNavigateToPage} />

      {/* Page metadata bar — word count, block count, created date */}
      <PageMetadataBar blocks={blocks} pageId={pageId} />

      {/* Link preview tooltip — covers all external links in the page */}
      <LinkPreviewTooltip container={pageContainerEl} />
    </div>
  )
}
