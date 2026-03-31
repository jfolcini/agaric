/**
 * EditableBlock — wrapper that switches between static div and TipTap editor.
 *
 * When focused: mounts the roving TipTap instance.
 * When not focused: renders StaticBlock (plain div).
 * On blur: serializes, compares, flushes if dirty, auto-splits on \n.
 */

import { EditorContent } from '@tiptap/react'
import type React from 'react'
import { useCallback } from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { useBlockStore } from '../stores/blocks'
import { FormattingToolbar } from './FormattingToolbar'
import { StaticBlock } from './StaticBlock'

interface EditableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  rovingEditor: RovingEditorHandle
  /** Called when the user clicks a block-link chip to navigate. */
  onNavigate?: (id: string) => void
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: (id: string) => string
  /** Resolve a tag ULID → display name. */
  resolveTagName?: (id: string) => string
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: (id: string) => 'active' | 'deleted'
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: (id: string) => 'active' | 'deleted'
}

export function EditableBlock({
  blockId,
  content,
  isFocused,
  rovingEditor,
  onNavigate,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
}: EditableBlockProps): React.ReactElement {
  const { setFocused, edit, splitBlock } = useBlockStore()

  const handleFocus = useCallback(
    (id: string) => {
      // Unmount from previous block if any
      if (rovingEditor.activeBlockId && rovingEditor.activeBlockId !== id) {
        const prevId = rovingEditor.activeBlockId // capture BEFORE unmount nullifies it
        const changed = rovingEditor.unmount()
        if (changed !== null) {
          // Auto-split if content contains newlines
          if (changed.includes('\n')) {
            splitBlock(prevId, changed)
          } else {
            edit(prevId, changed)
          }
        }
      }
      // Mount into the new block
      setFocused(id)
      rovingEditor.mount(id, content)
    },
    [rovingEditor, content, setFocused, edit, splitBlock],
  )

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (!rovingEditor.activeBlockId) return

      // Don't unmount if focus moved to a suggestion popup, formatting toolbar,
      // or date picker — these are transient UI elements that need the editor to stay mounted.
      const related = e.relatedTarget as HTMLElement | null
      if (related) {
        if (
          related.closest('.suggestion-popup') ||
          related.closest('.suggestion-list') ||
          related.closest('.formatting-toolbar') ||
          related.closest('[data-radix-popper-content-wrapper]') ||
          related.closest('.rdp')
        ) {
          return
        }
      }

      // Also check if a suggestion popup or date picker is currently open in the DOM
      if (document.querySelector('.suggestion-popup')) return
      if (document.querySelector('.date-picker-popup')) return

      const changed = rovingEditor.unmount()
      if (changed !== null) {
        if (changed.includes('\n')) {
          splitBlock(blockId, changed)
        } else {
          edit(blockId, changed)
        }
      }
      setFocused(null)
    },
    [rovingEditor, blockId, edit, splitBlock, setFocused],
  )

  if (!isFocused) {
    return (
      <StaticBlock
        blockId={blockId}
        content={content}
        onFocus={handleFocus}
        onNavigate={onNavigate}
        resolveBlockTitle={resolveBlockTitle}
        resolveTagName={resolveTagName}
        resolveBlockStatus={resolveBlockStatus}
        resolveTagStatus={resolveTagStatus}
      />
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper div catches blur from TipTap contenteditable
    <div
      className="block-editor rounded-md ring-1 ring-ring/30 bg-accent/[0.06] shadow-sm"
      data-block-id={blockId}
      onBlur={handleBlur}
    >
      {rovingEditor.editor && <FormattingToolbar editor={rovingEditor.editor} />}
      <EditorContent editor={rovingEditor.editor} />
    </div>
  )
}
