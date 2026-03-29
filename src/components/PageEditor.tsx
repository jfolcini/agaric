/**
 * PageEditor — page-level wrapper around BlockTree.
 *
 * Provides editable title, back navigation, and an "Add block" button.
 * Loads children of the given pageId via BlockTree's parentId prop.
 */

import { ArrowLeft, Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { editBlock } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { BlockTree } from './BlockTree'

export interface PageEditorProps {
  pageId: string
  title: string
  onBack?: () => void
  onNavigateToPage?: (pageId: string, title: string) => void
}

export function PageEditor({
  pageId,
  title,
  onBack,
  onNavigateToPage: _onNavigateToPage,
}: PageEditorProps): React.ReactElement {
  const [editableTitle, setEditableTitle] = useState(title)
  const titleRef = useRef<HTMLDivElement>(null)
  const { blocks, createBelow, setFocused } = useBlockStore()

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
        blockType: 'text',
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
    <div className="page-editor flex flex-col gap-4">
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
          className="flex-1 text-xl font-semibold outline-none focus:ring-2 focus:ring-ring/50 rounded px-1"
          onInput={handleTitleInput}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
        >
          {title}
        </div>
      </div>

      {/* Block tree — loads children of pageId */}
      <BlockTree parentId={pageId} />

      {/* Add block button */}
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
    </div>
  )
}
