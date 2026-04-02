/**
 * EditableBlock — wrapper that switches between static div and TipTap editor.
 *
 * When focused: mounts the roving TipTap instance.
 * When not focused: renders StaticBlock (plain div).
 * On blur: serializes, compares, flushes if dirty, auto-splits on \n.
 */

import { EditorContent } from '@tiptap/react'
import React, { useCallback, useEffect, useRef } from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { useBlockStore } from '../stores/blocks'
import { FormattingToolbar } from './FormattingToolbar'
import { StaticBlock } from './StaticBlock'

/**
 * CSS selectors for transient UI elements (popups, toolbars, pickers) that
 * should NOT cause the editor to unmount when they receive focus.
 * Add new entries here when introducing new popup-style UI.
 */
export const EDITOR_PORTAL_SELECTORS = [
  '.suggestion-popup',
  '.suggestion-list',
  '.formatting-toolbar',
  '[data-radix-popper-content-wrapper]',
  '.rdp',
  '.date-picker-popup',
]

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

function EditableBlockInner({
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
  const wrapperRef = useRef<HTMLElement>(null)

  // Scroll the editor wrapper into view when the block becomes focused.
  // Uses requestAnimationFrame to avoid layout thrashing after mount.
  useEffect(() => {
    if (isFocused) {
      requestAnimationFrame(() => {
        wrapperRef.current?.scrollIntoView({ block: 'nearest' })
      })
    }
  }, [isFocused])

  // Auto-mount the roving editor when focus is set externally (e.g. via
  // PageEditor's "Add block" button) without going through handleFocus.
  // Without this, activeBlockId remains null and blur/Enter cannot save.
  useEffect(() => {
    if (isFocused && rovingEditor.activeBlockId !== blockId) {
      rovingEditor.mount(blockId, content)
    }
  }, [isFocused, blockId, content, rovingEditor])

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
        if (EDITOR_PORTAL_SELECTORS.some((sel) => related.closest(sel))) {
          return
        }
      }

      // Also check if a suggestion popup, date picker, or popover is currently open in the DOM
      if (EDITOR_PORTAL_SELECTORS.some((sel) => document.querySelector(sel))) return

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
    <section
      ref={wrapperRef}
      id={`editor-${blockId}`}
      className="block-editor rounded-md ring-1 ring-ring/30 bg-accent/[0.06] shadow-sm"
      data-block-id={blockId}
      onBlur={handleBlur}
    >
      {rovingEditor.editor && <FormattingToolbar editor={rovingEditor.editor} blockId={blockId} />}
      <EditorContent editor={rovingEditor.editor} />
    </section>
  )
}

export const EditableBlock = React.memo(EditableBlockInner)
EditableBlock.displayName = 'EditableBlock'
