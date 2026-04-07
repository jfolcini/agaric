/**
 * EditableBlock — wrapper that switches between static div and TipTap editor.
 *
 * When focused: mounts the roving TipTap instance.
 * When not focused: renders StaticBlock (plain div).
 * On blur: serializes, compares, flushes if dirty, auto-splits on \n.
 */

import { EditorContent } from '@tiptap/react'
import React, { useCallback, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { useBlockStore } from '../stores/blocks'
import { usePageBlockStore } from '../stores/page-blocks'
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
  '.property-key-editor',
]

interface EditableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  rovingEditor: RovingEditorHandle
  /** Called when the user clicks a block-link chip to navigate. */
  onNavigate?: ((id: string) => void) | undefined
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Resolve a tag ULID → display name. */
  resolveTagName?: ((id: string) => string) | undefined
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
  /** Ctrl+Click / Shift+Click selection callback. */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
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
  isSelected,
  onSelect,
}: EditableBlockProps): React.ReactElement {
  const setFocused = useBlockStore((s) => s.setFocused)
  const edit = usePageBlockStore((s) => s.edit)
  const splitBlock = usePageBlockStore((s) => s.splitBlock)
  const currentPriority = usePageBlockStore(
    (s) => s.blocks.find((b) => b.id === blockId)?.priority ?? null,
  )
  const wrapperRef = useRef<HTMLElement>(null)

  // Stable refs for values the auto-mount effect needs to READ but should
  // not RE-RUN when they change.  `rovingEditor` is a mutable handle whose
  // object identity changes on every render; `content` is only needed as the
  // initial value passed to `mount()` — a content change while the editor is
  // already mounted should not trigger a re-mount.
  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor
  const contentRef = useRef(content)
  contentRef.current = content
  const editRef = useRef(edit)
  editRef.current = edit
  const splitBlockRef = useRef(splitBlock)
  splitBlockRef.current = splitBlock

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
  // PageEditor's "Add block" button or Enter-to-create) without going
  // through handleFocus.  Flushes the previous block's changes first to
  // prevent data loss — same unmount-save logic as handleFocus (H-11).
  useEffect(() => {
    const re = rovingEditorRef.current
    if (isFocused && re.activeBlockId !== blockId) {
      // Unmount from previous block if any (mirrors handleFocus logic)
      if (re.activeBlockId) {
        const prevId = re.activeBlockId
        const changed = re.unmount()
        if (changed !== null) {
          if (changed.includes('\n')) {
            splitBlockRef.current(prevId, changed)
          } else {
            editRef.current(prevId, changed)
          }
        }
      }
      re.mount(blockId, contentRef.current)
    }
  }, [isFocused, blockId])

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

      // If the editor has already moved to a different block (e.g.
      // handleFocus called mount on another block), this blur is stale —
      // ignore it to prevent saving the wrong block's content to this one.
      if (rovingEditor.activeBlockId !== blockId) return

      // For new blocks (created empty), persist any typed content before
      // checking transient UI. This prevents data loss when a popup is in
      // the DOM but the user clicked outside.
      if (rovingEditor.originalMarkdown === '' && rovingEditor.getMarkdown) {
        const content = rovingEditor.getMarkdown()
        if (content && content !== '') {
          edit(blockId, content)
          // Don't return — continue to normal blur logic (unmount, setFocused, etc.)
        }
      }

      // Don't unmount if focus moved to a suggestion popup, formatting toolbar,
      // or date picker — these are transient UI elements that need the editor to stay mounted.
      const related = e.relatedTarget as HTMLElement | null
      if (related) {
        if (EDITOR_PORTAL_SELECTORS.some((sel) => related.closest(sel))) {
          return
        }
      }

      // Also check if a suggestion popup, date picker, or popover is currently
      // visible in the DOM. Radix leaves wrapper elements mounted when closed
      // (with visibility:hidden or opacity:0), so we use checkVisibility() which
      // detects display:none, visibility:hidden, and opacity:0. Falls back to
      // offsetParent for older browsers.
      if (
        EDITOR_PORTAL_SELECTORS.some((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) return false
          if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          }
          // Fallback: offsetParent is null for display:none and hidden ancestors
          return el.offsetParent !== null
        })
      )
        return

      const changed = rovingEditor.unmount()
      if (changed !== null) {
        if (changed.includes('\n')) {
          flushSync(() => {
            splitBlock(blockId, changed)
          })
        } else {
          flushSync(() => {
            edit(blockId, changed)
          })
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
        isSelected={isSelected}
        onSelect={onSelect}
      />
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper div catches blur from TipTap contenteditable
    <section
      ref={wrapperRef}
      id={`editor-${blockId}`}
      className="block-editor rounded-md ring-1 ring-ring/30 bg-accent/[0.06] shadow-sm"
      data-testid="block-editor"
      data-block-id={blockId}
      onBlur={handleBlur}
    >
      {rovingEditor.editor && (
        <FormattingToolbar
          editor={rovingEditor.editor}
          blockId={blockId}
          currentPriority={currentPriority}
        />
      )}
      <EditorContent editor={rovingEditor.editor} />
    </section>
  )
}

export const EditableBlock = React.memo(EditableBlockInner)
EditableBlock.displayName = 'EditableBlock'
