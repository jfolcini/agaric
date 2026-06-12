/**
 * Roving TipTap editor — exactly ONE instance at all times.
 *
 * Mount on focus (parse → setContent). Unmount on blur (serialize →
 * compare → flush if dirty). Undo history is scoped per mount session
 * via addToHistory:false on content replacement transactions.
 */

import Bold from '@tiptap/extension-bold'
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
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { configKeyToTipTap, getShortcutKeys } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { curatedLowlight } from '@/lib/lowlight-curated'

import { AtTagPicker, atTagPickerPluginKey } from './extensions/at-tag-picker'
import { BlockLink } from './extensions/block-link'
import { BlockLinkPicker, blockLinkPickerPluginKey } from './extensions/block-link-picker'
import { BlockRef } from './extensions/block-ref'
import { BlockRefPicker, blockRefPickerPluginKey } from './extensions/block-ref-picker'
import { CalloutBlockquote } from './extensions/callout-blockquote'
import { CheckboxInputRule } from './extensions/checkbox-input-rule'
import { EmojiPicker, emojiPickerPluginKey } from './extensions/emoji-picker'
import { ExternalLink } from './extensions/external-link'
import { PropertyPicker, propertyPickerPluginKey } from './extensions/property-picker'
import { QueryHint } from './extensions/query-hint'
import { SlashCommand, slashCommandPluginKey } from './extensions/slash-command'
import { TagRef } from './extensions/tag-ref'
import { Underline } from './extensions/underline'
import { notifyUnknownNodeTypeToast } from './markdown-serialize-toast'
import { parse, serialize } from './markdown-serializer'
import { cleanupOrphanedPopups } from './suggestion-renderer'
import type { PickerItem } from './SuggestionList'
import { toggleCodeBlockSafely } from './toggle-code-block-safely'
import type { DocNode } from './types'

const suggestionPluginKeys = [
  atTagPickerPluginKey,
  blockLinkPickerPluginKey,
  blockRefPickerPluginKey,
  emojiPickerPluginKey,
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
 *
 * #711 — canonicalization is not an edit. `mount` parses the stored markdown
 * and `unmount` re-serializes it, and the serializer canonicalizes
 * (`3. item` → `1. item`, `_em_` → `*em*`, `snake_case` → `snake\_case`, …).
 * Comparing the new markdown against the RAW original therefore flagged
 * `changed: true` on a plain focus+blur with zero edits, silently rewriting
 * stored content and polluting the op log / undo history. When the raw
 * strings differ, compare against the canonicalized original
 * (`serialize(parse(original))`) instead: only real document changes count.
 */
export function computeContentDelta(originalMarkdown: string, currentJson: DocNode): ContentDelta {
  const newMarkdown = serialize(currentJson, notifyUnknownNodeTypeToast)
  if (newMarkdown === originalMarkdown) {
    return { newMarkdown, changed: false, originalMarkdown }
  }
  const canonicalOriginal = serialize(parse(originalMarkdown))
  return { newMarkdown, changed: newMarkdown !== canonicalOriginal, originalMarkdown }
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

// Share the curated lowlight instance with `RichContentRenderer` so bundlers
// only ship one copy of the grammars (see `src/lib/lowlight-curated.ts`).
const lowlight = curatedLowlight

// ── Configurable formatting shortcuts ────────────────────────────────────
// NOTE (#752): the bindings below are FROZEN at editor creation. TipTap
// builds its keymap exactly once from `addKeyboardShortcuts()`, so
// `getShortcutKeys(...)` is read a single time when the Editor instance is
// constructed. A Settings rebind therefore only applies to editors created
// afterwards (in practice: after an app reload) — unlike the document-level
// listeners that route through `matchesShortcutBinding` on every keydown
// and pick rebinds up live. This freeze is pinned by the
// "shortcut bindings are frozen at editor creation (#752)" test in
// `__tests__/use-roving-editor.test.ts`; if live rebinding is ever wanted
// here, the extensions must dispatch through a `handleKeyDown` plugin prop
// instead of a static keymap.

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
    const toggle = () => this.editor.commands.toggleStrike()
    return {
      [configKeyToTipTap(getShortcutKeys('strikethrough'))]: toggle,
      // #211 P2-11 — keep the legacy `Ctrl+Shift+X` working for one release
      // after the primary binding moved to `Ctrl+Shift+S`. Remove next release.
      'Mod-Shift-x': toggle,
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
        toggleCodeBlockSafely(this.editor as Editor)
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
  /** Return blocks matching query (for (( picker). */
  searchBlockRefs?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** PEND-15 Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** PEND-15 Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

/** Options for {@link RovingEditorHandle.mount}. */
export interface MountOptions {
  /**
   * Where to place the caret after the mount focuses the editor.
   * `'end'` → end of the document (e.g. Backspace-delete landing in the
   * previous block); `'start'` → start. Omitted → TipTap's default focus
   * behaviour (restore previous selection / document start).
   */
  cursorPlacement?: 'start' | 'end' | undefined
}

export interface RovingEditorHandle {
  /** The TipTap editor instance (null before first mount). */
  editor: Editor | null
  /**
   * Mount the editor into a block. Parses markdown → PM doc → setContent.
   * Undo history is reset — Ctrl+Z never crosses the mount boundary.
   * `opts.cursorPlacement` positions the caret after focus (#752).
   */
  mount: (blockId: string, markdown: string, opts?: MountOptions) => void
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
  /**
   * Split the document at the collapsed caret (#909). Returns the markdown
   * before and after the caret, or null when the editor is unmounted or the
   * selection is a non-collapsed range. Does NOT mutate the document.
   */
  splitAtCaret: () => { before: string; after: string } | null
  /** The markdown string that was passed to `mount()`. */
  originalMarkdown: string
  /**
   * Register a callback to be invoked on every TipTap `update` event while
   * the editor is mounted. Pass `null` to unregister.
   * The callback receives the current markdown string.
   */
  setOnMarkdownChange: (cb: ((md: string) => void) | null) => void
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
    // UX-309 / #544: callers own the placeholder text and pass the
    // i18n-keyed translation (e.g. BlockTree → t('block.emptyPlaceholder')).
    // The default is empty rather than a hardcoded English string so a caller
    // that forgets to pass it shows no hint instead of bypassing i18n.
    placeholder = '',
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
  } = options

  const activeBlockIdRef = useRef<string | null>(null)
  const originalMarkdownRef = useRef<string>('')
  const onMarkdownChangeRef = useRef<((md: string) => void) | null>(null)

  // Refs to hold latest callbacks — extensions capture these at creation
  // time but the refs always point to the current versions, preventing
  // stale closures inside NodeViews.
  const resolveTagNameRef = useRef(resolveTagName)
  resolveTagNameRef.current = resolveTagName
  // #921 — the placeholder is computed live per focused block (template hint vs
  // slash-command hint) but the editor is created once, so a captured string
  // froze at creation. Keep it in a ref and read it via Placeholder's function
  // form so the decoration reflects the CURRENT placeholder on every render.
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  resolveBlockTitleRef.current = resolveBlockTitle
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick
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
  const searchTagsRef = useRef(searchTags)
  searchTagsRef.current = searchTags
  const searchPagesRef = useRef(searchPages)
  searchPagesRef.current = searchPages
  const searchSlashCommandsRef = useRef(searchSlashCommands)
  searchSlashCommandsRef.current = searchSlashCommands
  const searchPropertyKeysRef = useRef(searchPropertyKeys)
  searchPropertyKeysRef.current = searchPropertyKeys

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
      Underline,
      CalloutBlockquote,
      OrderedList,

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
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      TagRef.configure({
        resolveName: (id: string) => resolveTagNameRef.current(id),
        onClick: (id: string) => onTagClickRef.current?.(id),
      }),
      BlockLink.configure({
        resolveTitle: (id: string) => resolveBlockTitleRef.current(id),
        onNavigate: (id: string) => onNavigateRef.current?.(id),
      }),
      BlockRef.configure({
        resolveContent: (id: string) => resolveBlockTitleRef.current(id),
        onNavigate: (id: string) => onNavigateRef.current?.(id),
      }),
      AtTagPicker.configure({
        items: (query: string) => searchTagsRef.current(query),
        onCreate: (name: string) => {
          const fn = onCreateTagRef.current
          if (!fn) return Promise.reject(new Error('onCreateTag not provided'))
          return fn(name)
        },
      }),
      BlockLinkPicker.configure({
        items: (query: string) => searchPagesRef.current(query),
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
        items: (query: string) => searchSlashCommandsRef.current(query),
        onCommand: (item: PickerItem) => onSlashCommandRef.current?.(item),
      }),
      PropertyPicker.configure({
        items: (query: string) => searchPropertyKeysRef.current(query),
        onSelect: (item: PickerItem) => onPropertySelectRef.current?.(item),
      }),
      // #130 — inline `:` emoji picker. Self-contained (static emoji data +
      // internal insert), so no options to wire.
      EmojiPicker,
      // #907 — passive inline `{{query …}}` syntax hint. Ghost-text only
      // (no `.suggestion-popup`), Tab-to-accept; never intercepts Enter, so
      // block-save always works. Self-contained (vocabulary from query-utils).
      QueryHint,
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
        // #925 — deliberate soft-keyboard configuration for the prose-first
        // block editor (previously unset, so mobile keyboards guessed). Enter
        // creates a new block, so hint the keyboard's action key as "enter";
        // notes are prose, so capitalize sentences and enable autocorrect /
        // spellcheck. `inputmode: text` keeps the standard text keyboard.
        enterkeyhint: 'enter',
        autocapitalize: 'sentences',
        autocorrect: 'on',
        spellcheck: 'true',
        inputmode: 'text',
      },
    },
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })

  // PEND-30 L-4: B-77 cleanup layer 5 — when the host component unmounts
  // (e.g. an exception during render that swaps the tree, fast tab switch),
  // TipTap's `useEditor` destroys the editor without going through the
  // suggestion plugin's `onExit`, which can leave orphan popup DOM. Sweep
  // any survivors here so the next mount of the editor never reuses stale
  // popups.
  useEffect(
    () => () => {
      cleanupOrphanedPopups()
    },
    [],
  )

  // Fires on every TipTap `update` while mounted. Serializes the current
  // document to markdown and forwards it to the registered listener (if any)
  // — replaces the old 500ms polling interval in EditableBlock (#536).
  const handleEditorUpdate = useCallback(() => {
    const cb = onMarkdownChangeRef.current
    if (!cb || !editor) return
    const json = editor.getJSON() as DocNode
    cb(serialize(json, notifyUnknownNodeTypeToast))
  }, [editor])

  const mount = useCallback(
    (blockId: string, markdown: string, opts?: MountOptions) => {
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
        // MAINT-176: dispatch can throw when the view is torn down between
        // block-switch frames. On the catch path we abort BEFORE the
        // replaceDocSilently below, since that would run against possibly
        // corrupt plugin state. isDestroyed distinguishes the expected race
        // (debug) from an unexpected throw on a live view (warn).
        try {
          editor.view.dispatch(suggTr)
        } catch (err) {
          if (editor.view.isDestroyed) {
            logger.debug('editor', 'suggestion-exit dispatch on destroyed view; aborting', {
              error: err instanceof Error ? err.message : String(err),
            })
          } else {
            logger.warn(
              'editor',
              'suggestion-exit dispatch threw; aborting replaceDocSilently',
              undefined,
              err,
            )
          }
          return
        }
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
      // #752 — honour the caller's cursor-placement hint (previously the
      // `DeleteBlockOpts.cursorPlacement` contract was documented + passed
      // but silently dropped by this bare `focus()`).
      editor.commands.focus(opts?.cursorPlacement ?? null)
      editor.on('update', handleEditorUpdate)
    },
    [editor, handleEditorUpdate],
  )

  const unmount = useCallback((): string | null => {
    if (!editor) return null
    const unmountBlockId = activeBlockIdRef.current

    // Detach the markdown-change listener before wiping state.
    editor.off('update', handleEditorUpdate)

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
  }, [editor, handleEditorUpdate])

  const getMarkdown = useCallback((): string | null => {
    if (!editor) return null
    const json = editor.getJSON() as DocNode
    return serialize(json, notifyUnknownNodeTypeToast)
  }, [editor])

  // #909 — split the document at the collapsed caret. Returns the markdown of
  // everything BEFORE the caret and everything AFTER it, so Enter can leave the
  // before-text in the current block and seed the new block with the after-text
  // (ProseMirror's splitBlock semantics; marks spanning the caret are carried
  // into each half by `doc.cut`). Returns null when there is no editor or the
  // selection is a range (a non-collapsed selection has no single split point).
  const splitAtCaret = useCallback((): { before: string; after: string } | null => {
    if (!editor) return null
    const { from, empty } = editor.state.selection
    if (!empty) return null
    const { doc } = editor.state
    const before = serialize(doc.cut(0, from).toJSON() as DocNode, notifyUnknownNodeTypeToast)
    const after = serialize(doc.cut(from).toJSON() as DocNode, notifyUnknownNodeTypeToast)
    return { before, after }
  }, [editor])

  // Memoize the returned handle so its object identity is stable across
  // renders that don't change `editor` / `mount` / `unmount` / `getMarkdown`.
  // The two `activeBlockId` / `originalMarkdown` getters read from refs, so
  // they remain live regardless of memo freshness — consumers that need
  // up-to-date values either read them via the getters or capture the
  // handle in a ref (e.g. `EditableBlock.tsx:129`, `BlockTree.tsx:201`).
  //
  // Without this, every parent re-render produced a fresh handle object
  // that propagated to `SortableBlockWrapper` and defeated its `React.memo`
  // (design-system-perf-review-2026-05-09.md item 5.)
  const setOnMarkdownChange = useCallback((cb: ((md: string) => void) | null) => {
    onMarkdownChangeRef.current = cb
  }, [])

  return useMemo<RovingEditorHandle>(
    () => ({
      editor,
      mount,
      unmount,
      get activeBlockId() {
        return activeBlockIdRef.current
      },
      getMarkdown,
      splitAtCaret,
      get originalMarkdown() {
        return originalMarkdownRef.current
      },
      setOnMarkdownChange,
    }),
    [editor, mount, unmount, getMarkdown, splitAtCaret, setOnMarkdownChange],
  )
}
