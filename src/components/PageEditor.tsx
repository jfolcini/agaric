/**
 * PageEditor — page-level wrapper around BlockTree.
 *
 * Provides editable title, back navigation, and an "Add block" button.
 * Loads children of the given pageId via BlockTree's parentId prop.
 */

import { ArrowLeft, ChevronDown, ChevronUp, History, Link, Plus, Tag } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { editBlock } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { useNavigationStore } from '../stores/navigation'
import { BacklinksPanel } from './BacklinksPanel'
import { BlockTree } from './BlockTree'
import { HistoryPanel } from './HistoryPanel'
import { TagPanel } from './TagPanel'

export interface PageEditorProps {
  pageId: string
  title: string
  onBack?: () => void
  onNavigateToPage?: (pageId: string, title: string, blockId?: string) => void
}

type DetailTab = 'backlinks' | 'history' | 'tags'

export function PageEditor({
  pageId,
  title,
  onBack,
  onNavigateToPage,
}: PageEditorProps): React.ReactElement {
  const [editableTitle, setEditableTitle] = useState(title)
  const titleRef = useRef<HTMLDivElement>(null)
  const { blocks, createBelow, setFocused } = useBlockStore()

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

  // Sync editableTitle when the title prop changes (e.g. parent re-renders)
  useEffect(() => {
    setEditableTitle(title)
  }, [title])

  const handleTitleBlur = useCallback(async () => {
    const newTitle = editableTitle.trim()
    if (newTitle && newTitle !== title) {
      await editBlock(pageId, newTitle)
    }
  }, [editableTitle, title, pageId])

  const handleTitleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    setEditableTitle(e.currentTarget.textContent ?? '')
  }, [])

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      titleRef.current?.blur()
    }
  }, [])

  const handleAddBlock = useCallback(async () => {
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock) {
      const newId = await createBelow(lastBlock.id, '')
      if (newId) {
        setFocused(newId)
      }
    } else {
      // No blocks yet — create a first block under this page.
      // createBelow needs an afterBlockId, so for the empty case we call
      // createBlock from the Tauri API directly and reload.
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
    }
  }, [blocks, createBelow, setFocused, pageId])

  return (
    <div className="page-editor flex flex-col gap-3">
      {/* Header: back button + editable title */}
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Go back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: contentEditable div is intentional for inline title editing */}
        <div
          ref={titleRef}
          role="textbox"
          tabIndex={0}
          aria-label="Page title"
          contentEditable
          suppressContentEditableWarning
          className="flex-1 text-xl font-semibold outline-none focus:ring-2 focus:ring-ring/50 rounded-md px-1 hover:bg-accent/5 focus-within:bg-accent/5 transition-colors"
          onInput={handleTitleInput}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
        >
          {title}
        </div>
      </div>

      {/* Block tree — loads children of pageId */}
      <BlockTree parentId={pageId} onNavigateToPage={onNavigateToPage} />

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
            <Button
              variant={activeTab === 'backlinks' ? 'default' : 'ghost'}
              size="sm"
              className="detail-tab-backlinks gap-1"
              onClick={() => {
                setActiveTab('backlinks')
                setPanelCollapsed(false)
              }}
            >
              <Link className="h-3.5 w-3.5" />
              Backlinks
            </Button>
            <Button
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
              variant={activeTab === 'tags' ? 'default' : 'ghost'}
              size="sm"
              className="detail-tab-tags gap-1"
              onClick={() => {
                setActiveTab('tags')
                setPanelCollapsed(false)
              }}
            >
              <Tag className="h-3.5 w-3.5" />
              Tags
            </Button>

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
            <div className="detail-panel-content max-h-60 overflow-y-auto p-3">
              {activeTab === 'backlinks' && <BacklinksPanel blockId={effectiveBlockId} />}
              {activeTab === 'history' && <HistoryPanel blockId={effectiveBlockId} />}
              {activeTab === 'tags' && <TagPanel blockId={effectiveBlockId} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
