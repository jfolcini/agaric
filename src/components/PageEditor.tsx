/**
 * PageEditor — page-level wrapper around BlockTree.
 *
 * Provides editable title, back navigation, and an "Add block" button.
 * Loads children of the given pageId via BlockTree's parentId prop.
 */

import { ChevronDown, ChevronUp, History, Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useBlockStore } from '../stores/blocks'
import { useNavigationStore } from '../stores/navigation'
import { useUndoStore } from '../stores/undo'
import { BlockTree } from './BlockTree'
import { HistoryPanel } from './HistoryPanel'
import { LinkedReferences } from './LinkedReferences'
import { PageHeader } from './PageHeader'
import { PropertiesPanel } from './PropertiesPanel'

/** Inline Settings2 icon — avoids adding to the lucide-react import which breaks existing test mocks. */
function Settings2Icon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="Properties"
    >
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </svg>
  )
}

export interface PageEditorProps {
  pageId: string
  title: string
  onBack?: () => void
  onNavigateToPage?: (pageId: string, title: string, blockId?: string) => void
}

type DetailTab = 'history' | 'properties'

export function PageEditor({
  pageId,
  title,
  onBack,
  onNavigateToPage,
}: PageEditorProps): React.ReactElement {
  const blocks = useBlockStore((s) => s.blocks)
  const createBelow = useBlockStore((s) => s.createBelow)
  const setFocused = useBlockStore((s) => s.setFocused)

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

  // Detail panel state
  const focusedBlockId = useBlockStore((s) => s.focusedBlockId)
  const [activeTab, setActiveTab] = useState<DetailTab | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const lastBlockIdRef = useRef<string | null>(null)

  // Track the last non-null focusedBlockId so the panel persists when focus clears
  useEffect(() => {
    if (focusedBlockId != null) {
      lastBlockIdRef.current = focusedBlockId
    }
  }, [focusedBlockId])

  const effectiveBlockId = focusedBlockId ?? lastBlockIdRef.current

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
          position: 0,
        })
        // Reload blocks via the store to pick up the new block
        const { load } = useBlockStore.getState()
        await load(pageId)
        setFocused(result.id)
      } catch {
        toast.error('Failed to create block')
      }
    }
  }, [blocks, createBelow, setFocused, pageId])

  return (
    <div className="page-editor flex flex-col gap-3">
      {/* Header: back button + editable title + tag badges */}
      <PageHeader pageId={pageId} title={title} onBack={onBack} />

      {/* Block tree — loads children of pageId */}
      <BlockTree parentId={pageId} onNavigateToPage={onNavigateToPage} />

      {/* Linked references — always visible at page bottom */}
      <LinkedReferences pageId={pageId} onNavigateToPage={onNavigateToPage} />

      {/* Add block button — always directly beneath the last block */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={handleAddBlock}
        >
          <Plus className="h-4 w-4" />
          Add block
        </Button>
      </div>

      {/* Detail panel — tab bar shown when a block has been focused, content shown when tab selected */}
      {effectiveBlockId != null && (
        <div className="detail-panel rounded-lg border" data-testid="detail-panel">
          {/* Tab bar + collapse toggle */}
          <div className="detail-panel-header flex items-center gap-1 border-b px-3 py-1.5">
            <div role="tablist" aria-label="Block details" className="flex items-center gap-1">
              <Button
                role="tab"
                id="detail-tab-history"
                aria-selected={activeTab === 'history'}
                aria-controls="detail-tabpanel"
                variant={activeTab === 'history' ? 'default' : 'ghost'}
                size="sm"
                className="detail-tab-history gap-1"
                onClick={() => {
                  setActiveTab('history')
                  setPanelCollapsed(false)
                }}
              >
                <History className="h-3.5 w-3.5" />
                History
              </Button>
              <Button
                role="tab"
                id="detail-tab-properties"
                aria-selected={activeTab === 'properties'}
                aria-controls="detail-tabpanel"
                variant={activeTab === 'properties' ? 'default' : 'ghost'}
                size="sm"
                className="detail-tab-properties gap-1"
                onClick={() => {
                  setActiveTab('properties')
                  setPanelCollapsed(false)
                }}
              >
                <Settings2Icon className="h-3.5 w-3.5" />
                Properties
              </Button>
            </div>

            <div className="flex-1" />

            {activeTab != null && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={panelCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
                onClick={() => setPanelCollapsed((c) => !c)}
              >
                {panelCollapsed ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>

          {/* Panel content */}
          {activeTab != null && !panelCollapsed && (
            <div
              role="tabpanel"
              id="detail-tabpanel"
              aria-labelledby={`detail-tab-${activeTab}`}
              className="detail-panel-content max-h-96 overflow-y-auto p-3"
            >
              {activeTab === 'history' && <HistoryPanel blockId={effectiveBlockId} />}
              {activeTab === 'properties' && <PropertiesPanel blockId={effectiveBlockId} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
