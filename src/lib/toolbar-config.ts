/**
 * Toolbar button configuration arrays extracted from FormattingToolbar.
 *
 * Each `create*` factory returns a `ToolbarButtonConfig[]` ready to
 * be consumed by `ToolbarButtonGroup`.  Factories that need editor
 * interaction accept an `Editor` parameter; pure-event configs are
 * plain functions with no parameters.
 */

import type { Editor } from '@tiptap/react'
import type { LucideIcon } from 'lucide-react'
import {
  AtSign,
  Bold,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Code,
  FileSymlink,
  Highlighter,
  Info,
  Italic,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Settings2,
  Strikethrough,
  Undo2,
  X,
} from 'lucide-react'
import { dispatchBlockEvent } from '@/lib/block-events'

// ── Shared constants ────────────────────────────────────────────────────

/** Shared active-state class applied to toolbar buttons when their feature is on. */
export const toolbarActiveClass = 'bg-accent text-accent-foreground'

/** Languages available in the code block language selector popover. */
export const CODE_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'rust',
  'bash',
  'sql',
  'html',
  'css',
  'json',
  'go',
  'java',
  'c',
  'cpp',
  'ruby',
  'markdown',
  'yaml',
  'toml',
] as const

/** Short display labels shown on the toolbar button when a code block language is active. */
export const LANG_SHORT: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  rust: 'RS',
  bash: 'SH',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  go: 'GO',
  java: 'JA',
  c: 'C',
  cpp: 'C++',
  ruby: 'RB',
  markdown: 'MD',
  yaml: 'YML',
  toml: 'TOML',
}

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolbarButtonConfig {
  icon: LucideIcon
  label: string
  tip: string
  activeKey?: string
  disabledWhenFalse?: string
  action: () => void
}

// ── Factory functions ───────────────────────────────────────────────────

export function createMarkToggles(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: Bold,
      label: 'toolbar.bold',
      tip: 'toolbar.boldTip',
      activeKey: 'bold',
      action: () => editor.chain().focus().toggleBold().run(),
    },
    {
      icon: Italic,
      label: 'toolbar.italic',
      tip: 'toolbar.italicTip',
      activeKey: 'italic',
      action: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      icon: Code,
      label: 'toolbar.code',
      tip: 'toolbar.codeTip',
      activeKey: 'code',
      action: () => editor.chain().focus().toggleCode().run(),
    },
    {
      icon: Strikethrough,
      label: 'toolbar.strikethrough',
      tip: 'toolbar.strikethroughTip',
      activeKey: 'strike',
      action: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      icon: Highlighter,
      label: 'toolbar.highlight',
      tip: 'toolbar.highlightTip',
      activeKey: 'highlight',
      action: () => editor.chain().focus().toggleHighlight().run(),
    },
  ]
}

export function createRefsAndBlocks(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: FileSymlink,
      label: 'toolbar.internalLink',
      tip: 'toolbar.pageLinkTip',
      action: () => {
        const { from, to } = editor.state.selection
        if (from !== to) {
          editor.commands.resolveBlockLinkFromSelection()
        } else {
          editor.chain().focus().insertContent('[[').run()
        }
      },
    },
    {
      icon: AtSign,
      label: 'toolbar.insertTag',
      tip: 'toolbar.tagTip',
      action: () => {
        // The AtTagPicker extension only opens the suggestion popup when
        // `@` is preceded by whitespace or is at the start of a block
        // (`allowedPrefixes: [' ', '\u00A0', '\n']` — see `at-tag-picker.ts`).
        // Inserting a bare `@` mid-text would therefore type the glyph
        // without triggering the picker, which is surprising for a button
        // labelled "Insert tag". Prepend a space when the previous char
        // isn't already a valid prefix so clicking the button reliably
        // opens the picker regardless of caret position.
        const { from } = editor.state.selection
        const prev = from > 0 ? editor.state.doc.textBetween(from - 1, from) : ''
        const needsSpace = prev !== '' && prev !== ' ' && prev !== '\u00A0' && prev !== '\n'
        editor
          .chain()
          .focus()
          .insertContent(needsSpace ? ' @' : '@')
          .run()
      },
    },
    {
      icon: Quote,
      label: 'toolbar.blockquote',
      tip: 'toolbar.blockquoteTip',
      activeKey: 'blockquote',
      action: () => editor.chain().focus().toggleBlockquote().run(),
    },
  ]
}

export function createStructureButtons(): ToolbarButtonConfig[] {
  return [
    {
      icon: ListOrdered,
      label: 'toolbar.orderedList',
      tip: 'toolbar.orderedListTip',
      action: () => dispatchBlockEvent('INSERT_ORDERED_LIST'),
    },
    {
      icon: Minus,
      label: 'toolbar.divider',
      tip: 'toolbar.dividerTip',
      action: () => dispatchBlockEvent('INSERT_DIVIDER'),
    },
    {
      icon: Info,
      label: 'toolbar.callout',
      tip: 'toolbar.calloutTip',
      action: () => dispatchBlockEvent('INSERT_CALLOUT'),
    },
  ]
}

export function createMetadataButtons(): ToolbarButtonConfig[] {
  return [
    {
      icon: CalendarDays,
      label: 'toolbar.insertDate',
      tip: 'toolbar.insertDateTip',
      action: () => dispatchBlockEvent('OPEN_DATE_PICKER'),
    },
    {
      icon: CalendarClock,
      label: 'toolbar.setDueDate',
      tip: 'toolbar.dueDateTip',
      action: () => dispatchBlockEvent('OPEN_DUE_DATE_PICKER'),
    },
    {
      icon: CalendarCheck2,
      label: 'toolbar.setScheduledDate',
      tip: 'toolbar.scheduledDateTip',
      action: () => dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER'),
    },
    {
      icon: CheckSquare,
      label: 'toolbar.todoToggle',
      tip: 'toolbar.todoToggleTip',
      action: () => dispatchBlockEvent('TOGGLE_TODO_STATE'),
    },
    {
      icon: Settings2,
      label: 'toolbar.properties',
      tip: 'toolbar.propertiesTip',
      action: () => dispatchBlockEvent('OPEN_BLOCK_PROPERTIES'),
    },
  ]
}

export function createHistoryButtons(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: Undo2,
      label: 'toolbar.undo',
      tip: 'toolbar.undoTip',
      disabledWhenFalse: 'canUndo',
      action: () => editor.chain().focus().undo().run(),
    },
    {
      icon: Redo2,
      label: 'toolbar.redo',
      tip: 'toolbar.redoTip',
      disabledWhenFalse: 'canRedo',
      action: () => editor.chain().focus().redo().run(),
    },
    {
      icon: X,
      label: 'toolbar.discard',
      tip: 'toolbar.discardTip',
      action: () => dispatchBlockEvent('DISCARD_BLOCK_EDIT'),
    },
  ]
}
