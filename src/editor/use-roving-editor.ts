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
import { BlockLinkPicker } from './extensions/block-link-picker'
import { SlashCommand } from './extensions/slash-command'
import { TagPicker } from './extensions/tag-picker'
import { TagRef } from './extensions/tag-ref'
import { parse, serialize } from './markdown-serializer'
import type { PickerItem } from './SuggestionList'
import type { DocNode } from './types'

export interface RovingEditorOptions {
  /** Resolve tag ULID → display name */
  resolveTagName?: (id: string) => string
  /** Resolve block/page ULID → display title */
  resolveBlockTitle?: (id: string) => string
  /** Placeholder text for empty blocks */
  placeholder?: string
  /** Return tags matching query (for # picker). */
  searchTags?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Return pages matching query (for [[ picker). */
  searchPages?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new page with the given title. Returns the new block's ULID. */
  onCreatePage?: (label: string) => Promise<string>
  /** Called when user clicks a [[block link]] chip to navigate. */
  onNavigate?: (id: string) => void
  /** Return slash commands matching query (for / picker). */
  searchSlashCommands?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Execute a selected slash command. */
  onSlashCommand?: (item: PickerItem) => void
  /** Check whether a linked block is active or deleted (broken link). */
  resolveBlockStatus?: (id: string) => 'active' | 'deleted'
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: (id: string) => 'active' | 'deleted'
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
 * @internal Exported for testing.
 */
export function replaceDocSilently(editor: Editor, json: Record<string, unknown>): void {
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
    searchTags = () => [],
    searchPages = () => [],
    onCreatePage,
    onNavigate,
    searchSlashCommands = () => [],
    onSlashCommand,
    resolveBlockStatus,
    resolveTagStatus,
  } = options

  const activeBlockIdRef = useRef<string | null>(null)
  const originalMarkdownRef = useRef<string>('')

  // Refs to hold latest callbacks — extensions capture these at creation
  // time but the refs always point to the current versions, preventing
  // stale closures inside NodeViews.
  const resolveTagNameRef = useRef(resolveTagName)
  resolveTagNameRef.current = resolveTagName
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  resolveBlockTitleRef.current = resolveBlockTitle
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const resolveBlockStatusRef = useRef(resolveBlockStatus)
  resolveBlockStatusRef.current = resolveBlockStatus
  const resolveTagStatusRef = useRef(resolveTagStatus)
  resolveTagStatusRef.current = resolveTagStatus
  const onCreatePageRef = useRef(onCreatePage)
  onCreatePageRef.current = onCreatePage
  const onSlashCommandRef = useRef(onSlashCommand)
  onSlashCommandRef.current = onSlashCommand

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
      TagRef.configure({
        resolveName: (id: string) => resolveTagNameRef.current(id),
        resolveStatus: (id: string) => resolveTagStatusRef.current?.(id) ?? 'active',
      }),
      BlockLink.configure({
        resolveTitle: (id: string) => resolveBlockTitleRef.current(id),
        onNavigate: (id: string) => onNavigateRef.current?.(id),
        resolveStatus: (id: string) => resolveBlockStatusRef.current?.(id) ?? 'active',
      }),
      TagPicker.configure({ items: searchTags }),
      BlockLinkPicker.configure({
        items: searchPages,
        onCreate: (label: string) => {
          const fn = onCreatePageRef.current
          if (!fn) return Promise.reject(new Error('onCreatePage not provided'))
          return fn(label)
        },
      }),
      SlashCommand.configure({
        items: searchSlashCommands,
        onCommand: (item: PickerItem) => onSlashCommandRef.current?.(item),
      }),
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
      // ADR-01: "Cleared on blur/flush. Ctrl+Z does not cross the flush boundary."
      // Reset undo history so previous block's edits don't leak into this one.
      // Pass { plugins } explicitly to preserve all plugin configurations
      // (including History keymaps) while resetting their internal state.
      const { state } = editor
      const newState = state.reconfigure({ plugins: state.plugins })
      editor.view.updateState(newState)
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
