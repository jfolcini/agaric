/**
 * BlockTree — renders the block list with the roving editor (ADR-01).
 *
 * Each block is either a StaticBlock (div) or the active TipTap editor.
 * Enter creates a new block below. Backspace on empty deletes.
 */

import type React from 'react'
import { useCallback, useEffect } from 'react'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { useRovingEditor } from '../editor/use-roving-editor'
import { useBlockStore } from '../stores/blocks'
import { EditableBlock } from './EditableBlock'

export function BlockTree(): React.ReactElement {
  const { blocks, focusedBlockId, loading, load, setFocused, remove, edit, splitBlock } =
    useBlockStore()
  const rovingEditor = useRovingEditor()

  useEffect(() => {
    load()
  }, [load])

  // Keyboard callbacks
  const handleFlush = useCallback((): string | null => {
    if (!rovingEditor.activeBlockId) return null
    const changed = rovingEditor.unmount()
    if (changed !== null && rovingEditor.activeBlockId) {
      if (changed.includes('\n')) {
        splitBlock(rovingEditor.activeBlockId, changed)
      } else {
        edit(rovingEditor.activeBlockId, changed)
      }
    }
    return changed
  }, [rovingEditor, edit, splitBlock])

  const handleFocusPrev = useCallback(() => {
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = blocks[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    }
  }, [blocks, focusedBlockId, setFocused, rovingEditor])

  const handleFocusNext = useCallback(() => {
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < blocks.length - 1) {
      const nextBlock = blocks[idx + 1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    }
  }, [blocks, focusedBlockId, setFocused, rovingEditor])

  const handleDeleteBlock = useCallback(() => {
    if (!focusedBlockId) return
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    rovingEditor.unmount()
    remove(focusedBlockId)
    // Focus previous block, or next, or nothing
    if (idx > 0) {
      const prevBlock = blocks[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    } else if (blocks.length > 1) {
      const nextBlock = blocks[1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    } else {
      setFocused(null)
    }
  }, [focusedBlockId, blocks, rovingEditor, remove, setFocused])

  const handleIndent = useCallback(() => {
    // p15-t17: indent/dedent deferred to its own task
  }, [])

  const handleDedent = useCallback(() => {
    // p15-t17: indent/dedent deferred to its own task
  }, [])

  useBlockKeyboard(rovingEditor.editor, {
    onFocusPrev: handleFocusPrev,
    onFocusNext: handleFocusNext,
    onDeleteBlock: handleDeleteBlock,
    onIndent: handleIndent,
    onDedent: handleDedent,
    onFlush: handleFlush,
  })

  if (loading) {
    return <div className="block-tree-loading">Loading blocks...</div>
  }

  return (
    <div className="block-tree">
      {blocks.map((block) => (
        <EditableBlock
          key={block.id}
          blockId={block.id}
          content={block.content ?? ''}
          isFocused={focusedBlockId === block.id}
          rovingEditor={rovingEditor}
        />
      ))}
      {blocks.length === 0 && (
        <div className="block-tree-empty">
          <p>No blocks yet. Start typing to create one.</p>
        </div>
      )}
    </div>
  )
}
