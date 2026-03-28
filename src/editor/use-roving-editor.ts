/**
 * Roving TipTap editor — exactly ONE instance at all times (ADR-01).
 *
 * Mount on focus (parse → setContent). Unmount on blur (serialize →
 * compare → flush if dirty). Undo history is scoped per mount session
 * via addToHistory:false on content replacement transactions.
 */

import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import Italic from '@tiptap/extension-italic'
import Paragraph from '@tiptap/extension-paragraph'
import Placeholder from '@tiptap/extension-placeholder'
import Text from '@tiptap/extension-text'
import { type Editor, useEditor } from '@tiptap/react'
import { useCallback, useRef } from 'react'
import { BlockLink } from './extensions/block-link'
import { TagRef } from './extensions/tag-ref'
import { parse, serialize } from './markdown-serializer'
import type { DocNode } from './types'

export interface RovingEditorOptions {
  /** Resolve tag ULID → display name */
  resolveTagName?: (id: string) => string
  /** Resolve block/page ULID → display title */
  resolveBlockTitle?: (id: string) => string
  /** Placeholder text for empty blocks */
  placeholder?: string
}

export interface RovingEditorHandle {
  /** The TipTap editor instance (null before first mount). */
  editor: Editor | null
  /**
   * Mount the editor into a block. Parses markdown → PM doc → setContent.
   * Undo history is reset — Ctrl+Z never crosses the mount boundary.
   */
  mount: (blockId: string, markdown: string) => void
  /**
   * Unmount the editor. Serializes PM doc → markdown. Returns the new
   * markdown string if content changed, or null if unchanged.
   */
  unmount: () => string | null
  /** The block ID currently being edited, or null. */
  activeBlockId: string | null
}

/**
 * Replace the editor document without adding to undo history.
 * This ensures Ctrl+Z never crosses mount/unmount boundaries.
 */
function replaceDocSilently(editor: Editor, json: Record<string, unknown>): void {
  const pmDoc = editor.schema.nodeFromJSON(json)
  const { tr } = editor.state
  tr.replaceWith(0, editor.state.doc.content.size, pmDoc.content)
  tr.setMeta('addToHistory', false)
  editor.view.dispatch(tr)
}

export function useRovingEditor(options: RovingEditorOptions = {}): RovingEditorHandle {
  const {
    resolveTagName = (id: string) => `#${id.slice(0, 8)}...`,
    resolveBlockTitle = (id: string) => `[[${id.slice(0, 8)}...]]`,
    placeholder = 'Type something...',
  } = options

  const activeBlockIdRef = useRef<string | null>(null)
  const originalMarkdownRef = useRef<string>('')

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Code,
      HardBreak,
      History,
      Placeholder.configure({ placeholder }),
      TagRef.configure({ resolveName: resolveTagName }),
      BlockLink.configure({ resolveTitle: resolveBlockTitle }),
    ],
    editable: true,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })

  const mount = useCallback(
    (blockId: string, markdown: string) => {
      if (!editor) return
      activeBlockIdRef.current = blockId
      originalMarkdownRef.current = markdown

      const doc = parse(markdown)
      replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
      editor.commands.focus()
    },
    [editor],
  )

  const unmount = useCallback((): string | null => {
    if (!editor) return null

    const json = editor.getJSON() as DocNode
    const newMarkdown = serialize(json)
    const changed = newMarkdown !== originalMarkdownRef.current

    // Reset to empty doc without polluting undo history
    replaceDocSilently(editor, { type: 'doc', content: [{ type: 'paragraph' }] })
    activeBlockIdRef.current = null
    originalMarkdownRef.current = ''

    return changed ? newMarkdown : null
  }, [editor])

  return {
    editor,
    mount,
    unmount,
    get activeBlockId() {
      return activeBlockIdRef.current
    },
  }
}
