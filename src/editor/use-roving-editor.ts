/**
 * Roving TipTap editor — exactly ONE instance at all times.
 *
 * Mount on focus (parse → setContent). Unmount on blur (serialize →
 * compare → flush if dirty). Undo history is scoped per mount session
 * via addToHistory:false on content replacement transactions.
 */

import Blockquote from '@tiptap/extension-blockquote'
import Bold from '@tiptap/extension-bold'
import BulletList from '@tiptap/extension-bullet-list'
import Code from '@tiptap/extension-code'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import History from '@tiptap/extension-history'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Italic from '@tiptap/extension-italic'
import ListItem from '@tiptap/extension-list-item'
import OrderedList from '@tiptap/extension-ordered-list'
import Paragraph from '@tiptap/extension-paragraph'
import Placeholder from '@tiptap/extension-placeholder'
import Strike from '@tiptap/extension-strike'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'
import { type Editor, Extension, useEditor } from '@tiptap/react'
import { common, createLowlight } from 'lowlight'
import { useCallback, useRef } from 'react'
import { configKeyToTipTap, getShortcutKeys } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { AtTagPicker, atTagPickerPluginKey } from './extensions/at-tag-picker'
import { BlockLink } from './extensions/block-link'
import { BlockLinkPicker, blockLinkPickerPluginKey } from './extensions/block-link-picker'
import { BlockRef } from './extensions/block-ref'
import { BlockRefPicker, blockRefPickerPluginKey } from './extensions/block-ref-picker'
import { CheckboxInputRule } from './extensions/checkbox-input-rule'
import { ExternalLink } from './extensions/external-link'
import { PropertyPicker, propertyPickerPluginKey } from './extensions/property-picker'
import { SlashCommand, slashCommandPluginKey } from './extensions/slash-command'
import { TagRef } from './extensions/tag-ref'
import { parse, serialize } from './markdown-serializer'
import type { PickerItem } from './SuggestionList'
import { cleanupOrphanedPopups } from './suggestion-renderer'
import type { DocNode } from './types'

const suggestionPluginKeys = [
  atTagPickerPluginKey,
  blockLinkPickerPluginKey,
  blockRefPickerPluginKey,
  propertyPickerPluginKey,
  slashCommandPluginKey,
]

// -- Extracted pure functions (testable without TipTap / jsdom) ---------------

export interface ContentDelta {
  newMarkdown: string
  changed: boolean
  originalMarkdown: string
}

/**
 * Serialize a ProseMirror JSON doc and compare against the original markdown.
 * Pure function — no editor instance required.
 */
export function computeContentDelta(originalMarkdown: string, currentJson: DocNode): ContentDelta {
  const newMarkdown = serialize(currentJson)
  return { newMarkdown, changed: newMarkdown !== originalMarkdown, originalMarkdown }
}

/**
 * Return true when the markdown would produce multiple top-level blocks
 * (i.e. contains newlines outside of code fences), meaning the block
 * should be split on blur.
 */
export function shouldSplitOnBlur(markdown: string): boolean {
  if (!markdown.includes('\n')) return false
  const doc = parse(markdown)
  const blocks = doc.content ?? []
  return blocks.length > 1
}

const lowlight = createLowlight(common)

/** Inline Code with configurable shortcut to toggle inline code. @internal Exported for testing. */
export const CodeWithShortcut = Code.extend({
  addKeyboardShortcuts() {
    return {
      [configKeyToTipTap(getShortcutKeys('inlineCode'))]: () => this.editor.commands.toggleCode(),
    }
  },
})

/** Strike with configurable shortcut to toggle strikethrough. @internal Exported for testing. */
export const StrikeWithShortcut = Strike.extend({
  addKeyboardShortcuts() {
    return {
      [configKeyToTipTap(getShortcutKeys('strikethrough'))]: () =>
        this.editor.commands.toggleStrike(),
    }
  },
})

/** Highlight with configurable shortcut to toggle highlight. @internal Exported for testing. */
export const HighlightWithShortcut = Highlight.extend({
  addKeyboardShortcuts() {
    return {
      [configKeyToTipTap(getShortcutKeys('highlight'))]: () =>
        this.editor.commands.toggleHighlight(),
    }
  },
})

/** CodeBlockLowlight with configurable shortcut to toggle code blocks. @internal Exported for testing. */
export const CodeBlockWithShortcut = CodeBlockLowlight.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      [configKeyToTipTap(getShortcutKeys('codeBlock'))]: () => {
        this.editor.chain().focus().toggleCodeBlock().run()
        return true
      },
    }
  },
})

/** Dispatch a priority custom event on document. Exported for testing. */
export function dispatchPriorityEvent(level: 1 | 2 | 3): void {
  document.dispatchEvent(new CustomEvent(`set-priority-${level}`))
}

/** Custom extension dispatching priority shortcut events. @internal Exported for testing. */
export const PriorityShortcuts = Extension.create({
  name: 'priorityShortcuts',
  addKeyboardShortcuts() {
    return {
      [configKeyToTipTap(getShortcutKeys('priority1'))]: () => {
        dispatchPriorityEvent(1)
        return true
      },
      [configKeyToTipTap(getShortcutKeys('priority2'))]: () => {
        dispatchPriorityEvent(2)
        return true
      },
      [configKeyToTipTap(getShortcutKeys('priority3'))]: () => {
        dispatchPriorityEvent(3)
        return true
      },
    }
  },
})

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
  /** Create a new tag with the given name. Returns the new tag's ULID. */
  onCreateTag?: (name: string) => Promise<string>
  /** Called when user clicks a [[block link]] chip to navigate. */
  onNavigate?: (id: string) => void
  /** Called when user clicks an #[ULID] tag chip to navigate. */
  onTagClick?: (id: string) => void
  /** Return slash commands matching query (for / picker). */
  searchSlashCommands?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Execute a selected slash command. */
  onSlashCommand?: (item: PickerItem) => void
  /** Called when checkbox syntax (- [ ] or - [x]) is detected during typing. */
  onCheckbox?: ((state: 'TODO' | 'DONE') => void) | null
  /** Return property keys matching query (for :: picker). */
  searchPropertyKeys?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Called when a property is selected from the :: picker. */
  onPropertySelect?: (item: PickerItem) => void
  /** Check whether a linked block is active or deleted (broken link). */
  resolveBlockStatus?: (id: string) => 'active' | 'deleted'
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: (id: string) => 'active' | 'deleted'
  /** Return blocks matching query (for (( picker). */
  searchBlockRefs?: (query: string) => PickerItem[] | Promise<PickerItem[]>
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
  /**
   * Read the current editor content as markdown WITHOUT unmounting.
   * Returns null if the editor is not mounted.
   */
  getMarkdown: () => string | null
  /** The markdown string that was passed to `mount()`. */
  originalMarkdown: string
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
    placeholder = 'Type / for commands, @ for tags, [[ for links...',
    searchTags = () => [],
    searchPages = () => [],
    onCreatePage,
    onCreateTag,
    onNavigate,
    onTagClick,
    searchSlashCommands = () => [],
    onSlashCommand,
    onCheckbox,
    searchPropertyKeys = () => [],
    onPropertySelect,
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
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick
  const resolveBlockStatusRef = useRef(resolveBlockStatus)
  resolveBlockStatusRef.current = resolveBlockStatus
  const resolveTagStatusRef = useRef(resolveTagStatus)
  resolveTagStatusRef.current = resolveTagStatus
  const onCreatePageRef = useRef(onCreatePage)
  onCreatePageRef.current = onCreatePage
  const onCreateTagRef = useRef(onCreateTag)
  onCreateTagRef.current = onCreateTag
  const onSlashCommandRef = useRef(onSlashCommand)
  onSlashCommandRef.current = onSlashCommand
  const onPropertySelectRef = useRef(onPropertySelect)
  onPropertySelectRef.current = onPropertySelect
  const onCheckboxRef = useRef(onCheckbox)
  onCheckboxRef.current = onCheckbox
  const searchBlockRefsRef = useRef(options.searchBlockRefs ?? (async () => [] as PickerItem[]))
  searchBlockRefsRef.current = options.searchBlockRefs ?? (async () => [] as PickerItem[])

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      CodeWithShortcut,
      StrikeWithShortcut,
      HighlightWithShortcut,
      Blockquote,
      OrderedList,
      BulletList,
      ListItem,
      HorizontalRule,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockWithShortcut.configure({ lowlight }),
      Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      HardBreak,
      History,
      ExternalLink,
      PriorityShortcuts,
      Placeholder.configure({ placeholder }),
      TagRef.configure({
        resolveName: (id: string) => resolveTagNameRef.current(id),
        resolveStatus: (id: string) => resolveTagStatusRef.current?.(id) ?? 'active',
        onClick: (id: string) => onTagClickRef.current?.(id),
      }),
      BlockLink.configure({
        resolveTitle: (id: string) => resolveBlockTitleRef.current(id),
        onNavigate: (id: string) => onNavigateRef.current?.(id),
        resolveStatus: (id: string) => resolveBlockStatusRef.current?.(id) ?? 'active',
      }),
      BlockRef.configure({
        resolveContent: (id: string) => resolveBlockTitleRef.current(id),
        onNavigate: (id: string) => onNavigateRef.current?.(id),
        resolveStatus: (id: string) => resolveBlockStatusRef.current?.(id) ?? 'active',
      }),
      AtTagPicker.configure({
        items: searchTags,
        onCreate: (name: string) => {
          const fn = onCreateTagRef.current
          if (!fn) return Promise.reject(new Error('onCreateTag not provided'))
          return fn(name)
        },
      }),
      BlockLinkPicker.configure({
        items: searchPages,
        onCreate: (label: string) => {
          const fn = onCreatePageRef.current
          if (!fn) return Promise.reject(new Error('onCreatePage not provided'))
          return fn(label)
        },
      }),
      BlockRefPicker.configure({
        items: (query: string) => searchBlockRefsRef.current(query),
      }),
      SlashCommand.configure({
        items: searchSlashCommands,
        onCommand: (item: PickerItem) => onSlashCommandRef.current?.(item),
      }),
      PropertyPicker.configure({
        items: searchPropertyKeys,
        onSelect: (item: PickerItem) => onPropertySelectRef.current?.(item),
      }),
      CheckboxInputRule.configure({
        onCheckbox: (state: 'TODO' | 'DONE') => onCheckboxRef.current?.(state),
      }),
    ],
    editable: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Block editor',
      },
    },
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })

  const mount = useCallback(
    (blockId: string, markdown: string) => {
      if (!editor) return
      activeBlockIdRef.current = blockId
      originalMarkdownRef.current = markdown

      // B-77 fix layer 2: Exit all suggestion plugins BEFORE replacing the
      // document so setMeta({ exit: true }) fires while decorations still
      // exist and the plugin can cleanly call onExit(). Previously this
      // block ran after replaceDocSilently, which destroyed the decorations
      // first and could leave the plugin in a corrupted active state.
      {
        const { tr: suggTr } = editor.state
        for (const key of suggestionPluginKeys) {
          suggTr.setMeta(key, { exit: true })
        }
        suggTr.setMeta('addToHistory', false)
        editor.view.dispatch(suggTr)
      }

      // B-77 fix layer 3: Remove any orphaned popup DOM elements that
      // survived a broken onExit() lifecycle (e.g. outside-click handler
      // before B-77 fix, or any future edge case).
      cleanupOrphanedPopups()

      const doc = parse(markdown)
      replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
      // Clear undo history so previous block's edits don't leak into this one.
      // We reset the History plugin's internal state directly via setMeta,
      // which avoids state.reconfigure() — reconfigure creates a new plugins
      // array reference that causes ProseMirror's updatePluginViews to destroy
      // and recreate ALL plugin views (including Suggestion views), breaking
      // suggestion popups (slash commands, tag picker, etc.) and adding
      // unnecessary overhead on every block switch.
      // Plugin.key is @internal in ProseMirror's types but always present at runtime
      const histPlugin = editor.state.plugins.find((p) =>
        (p as unknown as { key: string }).key.startsWith('history$'),
      )
      if (histPlugin?.spec.state?.init) {
        const freshHistory = histPlugin.spec.state.init({}, editor.state)
        const { tr } = editor.state
        tr.setMeta(histPlugin, { historyState: freshHistory })
        tr.setMeta('addToHistory', false)
        editor.view.dispatch(tr)
      }
      editor.commands.focus()
    },
    [editor],
  )

  const unmount = useCallback((): string | null => {
    if (!editor) return null
    const unmountBlockId = activeBlockIdRef.current

    // B-77 fix layer 4: Exit all suggestion plugins before wiping the
    // document.  Without this, blur → unmount → replaceDocSilently
    // destroys decorations while the plugin may still be active.
    {
      const { tr: suggTr } = editor.state
      for (const key of suggestionPluginKeys) {
        suggTr.setMeta(key, { exit: true })
      }
      suggTr.setMeta('addToHistory', false)
      editor.view.dispatch(suggTr)
    }
    cleanupOrphanedPopups()

    let delta: ContentDelta | null = null
    try {
      const json = editor.getJSON() as DocNode
      delta = computeContentDelta(originalMarkdownRef.current, json)
    } catch (err) {
      // Serialization failed — try plain text fallback to avoid data loss.
      // The editor state is about to be wiped in the finally block, so we
      // must capture SOMETHING here.
      logger.error('editor', 'serialize failed during unmount — attempting plain text fallback', {
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        const plainText = editor.getText()
        if (plainText && plainText !== originalMarkdownRef.current) {
          delta = {
            newMarkdown: plainText,
            changed: true,
            originalMarkdown: originalMarkdownRef.current,
          }
        }
      } catch {
        // Even plain text extraction failed — content is lost
        logger.error('editor', 'plain text fallback also failed — content lost')
      }
    } finally {
      // Always reset editor state
      replaceDocSilently(editor, { type: 'doc', content: [{ type: 'paragraph' }] })
      activeBlockIdRef.current = null
      originalMarkdownRef.current = ''
    }

    logger.debug('editor', 'unmounted', {
      blockId: unmountBlockId,
      changed: delta?.changed ?? false,
    })
    return delta?.changed ? delta.newMarkdown : null
  }, [editor])

  const getMarkdown = useCallback((): string | null => {
    if (!editor) return null
    const json = editor.getJSON() as DocNode
    return serialize(json)
  }, [editor])

  return {
    editor,
    mount,
    unmount,
    get activeBlockId() {
      return activeBlockIdRef.current
    },
    getMarkdown,
    get originalMarkdown() {
      return originalMarkdownRef.current
    },
  }
}
