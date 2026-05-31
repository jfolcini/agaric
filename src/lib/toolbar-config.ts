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
  Parentheses,
  Quote,
  Redo2,
  Settings2,
  Strikethrough,
  Underline,
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
  /**
   * Overflow priority used by `useToolbarOverflow` (PEND-33 Layer B).
   * Higher = stays visible longer under width pressure. 100 = always visible,
   * 30 = drops first. Optional; defaults to 0 (drops first) when unset.
   * Applied only to buttons rendered inside the always-visible toolbar; the
   * mark toggles fed into `SelectionBubbleMenu` ignore this field.
   */
  priority?: number
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
    {
      // #211 P2-5 — underline. Takes the bubble menu to 7 marks + Link,
      // within the ≤8-button calm-UI ceiling the issue adopts.
      icon: Underline,
      label: 'toolbar.underline',
      tip: 'toolbar.underlineTip',
      activeKey: 'underline',
      action: () => editor.chain().focus().toggleUnderline().run(),
    },
  ]
}

export function createRefsAndBlocks(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: FileSymlink,
      label: 'toolbar.internalLink',
      tip: 'toolbar.pageLinkTip',
      priority: 60,
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
      // #213 PR 4 — block-ref creation parity. Mirrors the page-link button
      // above: resolve a selection into a `((ref))`, or insert the `((`
      // trigger to open the BlockRefPicker when there's no selection.
      icon: Parentheses,
      label: 'toolbar.insertBlockRef',
      tip: 'toolbar.blockRefTip',
      priority: 60,
      action: () => {
        const { from, to } = editor.state.selection
        if (from !== to) {
          editor.commands.resolveBlockRefFromSelection()
        } else {
          editor.chain().focus().insertContent('((').run()
        }
      },
    },
    {
      icon: AtSign,
      label: 'toolbar.insertTag',
      tip: 'toolbar.tagTip',
      priority: 60,
      action: () => {
        // The AtTagPicker extension only opens the suggestion popup when
        // `@` is preceded by whitespace or is at the start of a block
        // (`allowedPrefixes: [' ', '\u00A0', '\n']` — see `at-tag-picker.ts`).
        // Inserting a bare `@` mid-text would therefore type the glyph
        // without triggering the picker, which is surprising for a button
        // labelled via t('toolbar.insertTag'). Prepend a space when the previous char
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
      // #265 — blockquote is a long-tail structural insert with a `/quote`
      // slash twin (the canonical home). Demoted below the high-frequency
      // structure (heading 65 / code block 55 / ordered list 50) so it drops
      // into the overflow popover first under width pressure (#217).
      icon: Quote,
      label: 'toolbar.blockquote',
      tip: 'toolbar.blockquoteTip',
      activeKey: 'blockquote',
      priority: 35,
      action: () => editor.chain().focus().toggleBlockquote().run(),
    },
  ]
}

export function createStructureButtons(): ToolbarButtonConfig[] {
  return [
    {
      // #265 — ordered list is one of the high-frequency structural inserts
      // kept inline (heading / code block / list). Priority unchanged at 50.
      icon: ListOrdered,
      label: 'toolbar.orderedList',
      tip: 'toolbar.orderedListTip',
      priority: 50,
      action: () => dispatchBlockEvent('INSERT_ORDERED_LIST'),
    },
    {
      // #265 — divider is a long-tail structural insert with a `/divider`
      // slash twin. Demoted (50 → 35) into the overflow popover first.
      icon: Minus,
      label: 'toolbar.divider',
      tip: 'toolbar.dividerTip',
      priority: 35,
      action: () => dispatchBlockEvent('INSERT_DIVIDER'),
    },
    {
      // #265 — callout is a long-tail structural insert with a `/callout`
      // slash twin. Demoted (40 → 30) so it is the first structure to overflow.
      icon: Info,
      label: 'toolbar.callout',
      tip: 'toolbar.calloutTip',
      priority: 30,
      action: () => dispatchBlockEvent('INSERT_CALLOUT'),
    },
  ]
}

export function createMetadataButtons(): ToolbarButtonConfig[] {
  return [
    {
      // #265 — the three date pickers (insert / due / scheduled) all have
      // slash twins (`/date`, `/due`, `/scheduled`) and are long-tail on the
      // standing bar. Demoted (70 → 40) toward the overflow popover so the
      // high-frequency TODO toggle (80) and priority cycle (75) keep their
      // place; the dates remain reachable via slash + overflow.
      icon: CalendarDays,
      label: 'toolbar.insertDate',
      tip: 'toolbar.insertDateTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_DATE_PICKER'),
    },
    {
      icon: CalendarClock,
      label: 'toolbar.setDueDate',
      tip: 'toolbar.dueDateTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_DUE_DATE_PICKER'),
    },
    {
      icon: CalendarCheck2,
      label: 'toolbar.setScheduledDate',
      tip: 'toolbar.scheduledDateTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER'),
    },
    {
      icon: CheckSquare,
      label: 'toolbar.todoToggle',
      tip: 'toolbar.todoToggleTip',
      priority: 80,
      action: () => dispatchBlockEvent('TOGGLE_TODO_STATE'),
    },
    {
      icon: Settings2,
      label: 'toolbar.properties',
      tip: 'toolbar.propertiesTip',
      priority: 40,
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
      priority: 100,
      action: () => editor.chain().focus().undo().run(),
    },
    {
      icon: Redo2,
      label: 'toolbar.redo',
      tip: 'toolbar.redoTip',
      disabledWhenFalse: 'canRedo',
      priority: 100,
      action: () => editor.chain().focus().redo().run(),
    },
    {
      icon: X,
      label: 'toolbar.discard',
      tip: 'toolbar.discardTip',
      priority: 30,
      action: () => dispatchBlockEvent('DISCARD_BLOCK_EDIT'),
    },
  ]
}
